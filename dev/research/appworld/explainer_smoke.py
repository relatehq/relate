"""Offline train/dev preflight of acquisition and each real public SDK surface."""

import argparse
import json

from acquire import graph_payments, music
from appworld import AppWorld, load_task_ids
from appworld.common.path_store import path_store
from explainer_support import acquisition_coverage
from sdk_runner import HERE, NodeRepl


def smoke(arm, task):
    with AppWorld(
        task_id=task,
        experiment_name=f"explainer-preflight-{arm}",
        random_seed=100,
        timeout_seconds=60,
        load_ground_truth=False,
    ) as world:
        passwords = {
            row["account_name"]: row["password"]
            for row in world.apis.supervisor.show_account_passwords()
        }
        tokens = {
            app: getattr(world.apis, app).login(
                username=world.task.supervisor.phone_number
                if app == "phone"
                else world.task.supervisor.email,
                password=passwords[app],
            )["access_token"]
            for app in ["spotify", "phone", "venmo"]
        }
        rows = music(world.apis, tokens["spotify"]) | graph_payments(
            world.apis, tokens["phone"], tokens["venmo"], dict(world.task.supervisor)
        )
        mode = "snapshot_ts" if arm == "snapshot_ts" else "sdk"
        node = NodeRepl(
            world,
            rows,
            mode=mode,
            tokens=tokens,
            coverage=acquisition_coverage(rows),
            journal_path=HERE / ".local/preflight-journals" / f"{arm}-{task}.sqlite3",
        )
        try:
            if mode == "snapshot_ts":
                code = """if (typeof relate !== 'undefined') throw new Error('SDK leaked into snapshot control');
const description = snapshot.describe();
for (const object of description.objects) {
 if (!Array.isArray(snapshot.records[object.apiName])) throw new Error('Missing snapshot array');
 if (!snapshot.describeObject(object.apiName).properties.length) throw new Error('Missing semantics');
}
console.log('offline-ok');"""
            else:
                code = """const description = await relate.describe();
for (const object of description.objects) {
 const api = relate.objects[object.apiName];
 const page = await api.query({limit:1});
 if (!Array.isArray(page.data)) throw new Error('Invalid page');
}
"""
                extras = {
                    "baseline": "",
                    "actions": "if (!relate.actions.likeTransaction.describe().result.succeeded.outputPath) throw new Error('Missing receipt contract');",
                    "errors": "try { await relate.actions.likeTransaction({input:{},idempotencyKey:'invalid-preflight'}); throw new Error('Expected invalid'); } catch(e) { if (e.issues?.[0]?.path.join('.') !== 'input.transaction') throw e; }",
                    "collections": "const handle=relate.objects.Transaction.query({limit:1}); await handle.page(); for await (const record of handle.records()) { if (!record.meta) throw new Error('Lost evidence'); break; }",
                    "datetime": "await relate.objects.Transaction.query({where:{createdAt:{gte:'0001-01-01T00:00:00',lt:'9999-12-31T23:59:59'}}});",
                    "relationships": "if (!relate.objects.Person.describe().traversals.every(t => t.predicate?.links.length)) throw new Error('Missing relationship predicates');",
                    "filters": "for (const obj of description.objects) { const api=relate.objects[obj.apiName]; const row=(await api.query({limit:1})).data[0]; if (!row) continue; const edge=api.describe().traversals.find(t=>t.cardinality==='many'); if (edge) { const page=await api.traverse[edge.name](row.id,{where:{id:{in:[]}}}); if(page.data.length) throw new Error('Filter ignored'); } }",
                    "coverage": "if ((await relate.objects.Transaction.query()).meta.coverage?.status !== 'complete') throw new Error('Missing host coverage');",
                }
                code += extras[arm] + "\nconsole.log('offline-ok');"
            result = node.request({"type": "execute", "code": code})
            if result.get("error") or "offline-ok" not in result.get("output", ""):
                raise RuntimeError(
                    f"{arm}/{task}: {result.get('error') or 'Missing success marker'}"
                )
        finally:
            node.close()
    print(
        json.dumps({"arm": arm, "task": task, "offline": "passed", "model_calls": 0}),
        flush=True,
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--arm", required=True)
    parser.add_argument("--tasks", nargs="+", required=True)
    args = parser.parse_args()
    path_store.update_root(str(HERE / ".local/world"))
    if not set(args.tasks) <= set(load_task_ids("train") + load_task_ids("dev")):
        parser.error("Only train/dev tasks permitted")
    for task in args.tasks:
        smoke(args.arm, task)


if __name__ == "__main__":
    main()
