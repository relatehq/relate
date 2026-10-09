"""Public-API write/refresh/replay smoke; no task solution is loaded or supplied."""

import json
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from acquire import payments
from sdk_runner import HERE, AppWorld, NodeRepl, path_store

path_store.update_root(str(HERE / ".local/world"))
name = "sdk-write-smoke-" + uuid.uuid4().hex[:10]
with AppWorld(
    task_id="afc0fce_1", experiment_name=name, load_ground_truth=False
) as world:
    passwords = {
        r["account_name"]: r["password"]
        for r in world.apis.supervisor.show_account_passwords()
    }
    tokens = {
        app: getattr(world.apis, app).login(
            username=world.task.supervisor.phone_number
            if app == "phone"
            else world.task.supervisor.email,
            password=passwords[app],
        )["access_token"]
        for app in ["phone", "venmo"]
    }
    rows = payments(world.apis, tokens["phone"], tokens["venmo"])
    before = next(row for row in rows["Transaction"] if row["likeCount"] == 0)
    node = NodeRepl(world, rows, tokens=tokens)
    try:
        event = node.request(
            {
                "type": "execute",
                "code": """
          let tx; for await (const row of relate.objects.Transaction.query({where: {sourceId: SOURCE_ID}})) { tx = row; break; }
          let req = {input: {transaction: tx.id, comment: 'Research write smoke'}, idempotencyKey: 'smoke-comment'};
          let receipt; try { receipt = await relate.actions.commentOnTransaction(req); } catch (e) { console.log(e); throw e; }
          let replay = await relate.actions.commentOnTransaction(req);
          await relate.actions.likeTransaction({input: {transaction: tx.id}, idempotencyKey:'smoke-like'});
          console.log(JSON.stringify({receipt, replay, row: await relate.objects.Transaction.get(tx.id), hidden: typeof apis + '/' + typeof tokens}));
        """.replace("SOURCE_ID", json.dumps(before["sourceId"])),
            }
        )
        assert event["error"] is None, event
        observed = json.loads(event["output"])
        assert observed["hidden"] == "undefined/undefined"
        assert observed["receipt"]["output"] == observed["replay"]["output"]
        assert observed["row"]["data"]["sourceId"] == before["sourceId"]
        assert observed["row"]["data"]["commentCount"] == before["commentCount"] + 1
        original = world.apis.venmo.show_transaction(
            transaction_id=int(before["sourceId"]), access_token=tokens["venmo"]
        )
        assert original["comment_count"] == before["commentCount"] + 1
        assert original["like_count"] == observed["row"]["data"]["likeCount"]
        calls = world.requester.request_tracker.requests
        writes = [
            c
            for c in calls
            if c["method"].upper() == "POST" and c["url"].endswith("/comments")
        ]
        assert len(writes) == 1
        world.execute("pass")
        world.save_state()
    finally:
        node.close()
print(
    "PASS: original Venmo mutation, SDK read-after-write, hidden credentials and single-write receipt replay"
)
