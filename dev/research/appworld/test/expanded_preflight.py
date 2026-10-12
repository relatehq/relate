"""Offline public-path validation, not agent attempts or benchmark scores."""

import argparse
import json
import sys
import uuid
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from sdk_runner import AppWorld, NodeRepl, HERE, path_store
from music_acquire import music_catalog
from acquire import graph_payments
from task_catalog import ADDITIONAL_TASKS


def check(task):
    path_store.update_root(str(HERE / ".local/world"))
    with AppWorld(
        task_id=task,
        experiment_name="expanded-preflight-" + uuid.uuid4().hex[:12],
        load_ground_truth=False,
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
            for app in ("spotify", "phone", "venmo")
        }
        rows = music_catalog(
            world.apis, tokens["spotify"], world.task.supervisor.email
        ) | graph_payments(
            world.apis, tokens["phone"], tokens["venmo"], dict(world.task.supervisor)
        )
        with_node = NodeRepl(world, rows, tokens=tokens)
        try:
            event = with_node.request(
                {
                    "type": "execute",
                    "code": """
              let counts = {}; for (const item of relate.describe().objects) {
                counts[item.apiName] = 0;
                for await (const row of relate.objects[item.apiName].query({evidence:'full'})) {
                  if (Object.values(row.meta.fields).some(f => !['available','absent'].includes(f.status))) throw new Error(item.apiName + ' incomplete fields');
                  counts[item.apiName]++;
                }
              } console.log(JSON.stringify(counts));
            """,
                }
            )
            assert event["error"] is None, event["error"]
            counts = json.loads(event["output"])
            assert all(counts[k] == len(v) for k, v in rows.items())
            return {"task": task, "passed": True, "records": sum(counts.values())}
        finally:
            with_node.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--tasks", nargs="+", default=ADDITIONAL_TASKS)
    parser.add_argument("--jobs", type=int, default=3)
    parser.add_argument(
        "--output", type=Path, default=HERE / "evidence/expanded-preflight.json"
    )
    args = parser.parse_args()
    with ProcessPoolExecutor(max_workers=args.jobs) as pool:
        results = []
        for result in pool.map(check, args.tasks):
            results.append(result)
            print(
                json.dumps(
                    {"finished": len(results), "total": len(args.tasks), **result}
                ),
                flush=True,
            )
    args.output.write_text(
        json.dumps({"agent_attempts": 0, "results": results}, indent=2) + "\n"
    )
