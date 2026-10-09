"""Real AppWorld parity and evaluator persistence for the raw TypeScript arm."""

import json
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from appworld.evaluator import evaluate_task
from sdk_runner import HERE, AppWorld, NodeRepl, path_store

path_store.update_root(str(HERE / ".local/world"))
name = "raw-ts-smoke-" + uuid.uuid4().hex[:10]
task = "e7a10f8_1"
marker = "raw-ts-persistence-marker"
with AppWorld(task_id=task, experiment_name=name, load_ground_truth=False) as world:
    expected = world.apis.api_docs.show_api_descriptions(app_name="spotify")
    node = NodeRepl(world, mode="raw_ts", tokens={})
    try:
        response = node.request(
            {
                "type": "execute",
                "code": "console.log(JSON.stringify(await apis.api_docs.show_api_descriptions({app_name:'spotify'})));",
            }
        )
        assert response["error"] is None, response
        assert json.loads(response["output"]) == expected
        response = node.request(
            {
                "type": "execute",
                "code": f"await completeTask({{answer: {json.dumps(marker)}}});",
            }
        )
        assert response["error"] is None, response
        assert world.task_completed()
        world.execute("pass")
        world.save_state()
    finally:
        node.close()
report = evaluate_task(task_id=task, experiment_name=name).to_dict()
assert not report["success"]
assert marker in json.dumps(report)
assert "<<not_given>>" not in json.dumps(report)
print("PASS: raw TS API JSON equals original Python API; completion reaches evaluator")
