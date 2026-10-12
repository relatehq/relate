"""Requires the downloaded training world; never supplies a task solution."""

import json
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from appworld.evaluator import evaluate_task
from sdk_runner import HERE, AppWorld, NodeRepl, path_store

path_store.update_root(str(HERE / ".local/world"))
name = "sdk-persistence-smoke-" + uuid.uuid4().hex[:10]
task = "e7a10f8_1"
marker = "persistence-regression-marker"
with AppWorld(task_id=task, experiment_name=name, load_ground_truth=False) as world:
    node = NodeRepl(world, {})
    try:
        event = node.request(
            {
                "type": "execute",
                "code": 'console.log(await completeTask({answer: "' + marker + '"}));',
            }
        )
        assert event["error"] is None, event
        assert world.task_completed()
        world.execute("pass")
        world.save_state()
    finally:
        node.close()
report = evaluate_task(task_id=task, experiment_name=name).to_dict()
# The answer is deliberately wrong. What matters is that the evaluator receives
# the submitted marker from disk, rather than its initial <<not_given>> value.
assert not report["success"]
assert marker in json.dumps(report), "Evaluator did not read the submitted answer"
assert "<<not_given>>" not in json.dumps(report)
print("PASS: TS API completion persisted to the original AppWorld evaluator")
