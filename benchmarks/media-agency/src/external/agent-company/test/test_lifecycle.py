"""Original deterministic task/evaluator smoke. This is not a Luna score."""
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
spec = importlib.util.spec_from_file_location("company_runner", HERE / "run.py")
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class RedactionTest(unittest.TestCase):
    def test_upstream_key_echo_is_not_retained(self):
        sentinel = "test-private-provider-key-98765"
        result = runner.command([sys.executable, "-c", "import os; print(os.environ['LITELLM_API_KEY'])"],
                                env={**os.environ, "LITELLM_API_KEY": sentinel})
        self.assertEqual(result["exitCode"], 0)
        self.assertEqual(result["stdout"].strip(), "[redacted]")
        self.assertNotIn(sentinel, json.dumps(result))

    def test_declared_service_dependencies_cover_full_selection(self):
        self.assertEqual(runner.required_services(["ds-sql-exercise", "sde-install-go", "sde-install-openjdk"]), [])
        tasks = [p.name for p in (runner.UPSTREAM / "workspaces/tasks").iterdir() if (p / "task.md").exists()]
        self.assertEqual(len(tasks), 175)
        self.assertEqual(runner.required_services(tasks), ["gitlab", "owncloud", "plane", "rocketchat"])


@unittest.skipUnless(os.environ.get("AGENCY_DOCKER_TESTS") == "1", "Set AGENCY_DOCKER_TESTS=1 for original-image lifecycle checks")
class LifecycleTest(unittest.TestCase):
    def test_environment_model_routes_in_original_image(self):
        image = runner.load_images(HERE / "images-1.0.0.lock.json", ["ds-sql-exercise"])["ds-sql-exercise"]
        output = runner.checked(["docker", "run", "--rm", "--network", "none", "--platform", "linux/amd64",
            image, "python_default", "-c",
            "from litellm.utils import get_llm_provider; print(get_llm_provider(model=" + repr(runner.ENV_MODEL) + ")[1])"])
        self.assertEqual(output.strip(), "openai")

    def test_both_surfaces_preserve_task_permissions_and_grade_original_state(self):
        # The original task is first alphabetically among tasks with no service
        # dependencies and a deterministic evaluator. We deliberately do not
        # solve its SQL questions: this validates the lifecycle, not performance.
        command = '''
set -eu
test "$(id -u)" -eq 0
test -z "$(ls -A /utils)"
test -z "$(ls -A /npc)"
! touch /utils/must-not-write
! umount /utils
test -z "${LITELLM_API_KEY:-}"
test -z "${OPENAI_API_KEY:-}"
touch /usr/local/agency-permission-check
touch /data/agency-permission-check
for f in /proc/[0-9]*/environ; do cat "$f" 2>/dev/null || true; done
cat /instruction/task.md
'''
        env = {**os.environ, "LITELLM_API_KEY": "offline-sentinel-do-not-use",
               "LITELLM_BASE_URL": "http://127.0.0.1:1", "LITELLM_MODEL": "offline-no-model",
               "DECRYPTION_KEY": "theagentcompany is all you need"}
        os.environ.setdefault("AGENCY_EXECUTOR_IMAGE", "relate-agency:v2-14b8ca0")
        artifact_root = runner.ROOT / "benchmarks/media-agency/artifacts/agent-company"
        artifact_root.mkdir(parents=True, exist_ok=True)
        output = Path(tempfile.mkdtemp(prefix="offline-lifecycle-", dir=artifact_root))
        runner.save(output / "identity.json", {"kind": "offline-integration-test", "modelCalls": 0,
            "upstream": runner.PIN,
            "sourceHashes": {str(p.relative_to(HERE)): hashlib.sha256(p.read_bytes()).hexdigest()
                             for p in HERE.rglob("*") if p.is_file() and p.suffix in {".py", ".ts"}},
            "imageLockSha256": hashlib.sha256((HERE / "images-1.0.0.lock.json").read_bytes()).hexdigest()})
        outcomes = {}
        real_command = runner.command
        def command_with_trusted_fixture(args, **kwargs):
            if args[:2] == ["docker", "commit"] and not args[2].endswith("-agent"):
                # Simulate a live NPC process holding credentials, without an
                # LLM call. It must not enter the agent's PID namespace.
                result = real_command(["docker", "exec", "-d", "--env", "LITELLM_API_KEY", args[2], "sleep", "600"], env=env)
                self.assertEqual(result["exitCode"], 0)
            if "/utils/eval.py" in args:
                grader = args[args.index("python_default") - 1]
                result = real_command(["docker", "exec", grader, "sh", "-c",
                    "test -f /data/agency-permission-check && test -f /usr/local/agency-permission-check && test -f /utils/evaluator.py.enc"])
                self.assertEqual(result["exitCode"], 0, "Grader must see agent filesystem changes and original evaluator")
            return real_command(args, **kwargs)
        for arm in ["baseline-tools", "relate"]:
            with self.subTest(arm=arm):
                arm_dir = output / arm
                arm_dir.mkdir()
                code = 'return await graph.actions.shell({input:{arguments:JSON.stringify(' + json.dumps({"command": command}) + ')},idempotencyKey:"lifecycle-check"});'
                calls = ([{"name": "shell", "input": {"command": command}}] if arm == "baseline-tools" else
                         [{"name": "discover", "input": {}}, {"name": "execute", "input": {"code": code}}])
                replies = [{"content": [{"type": "tool_call", "id": f"call-{i}", **call}]} for i, call in enumerate(calls)]
                replies.append({"content": [{"type": "text", "text": "Lifecycle smoke finished; SQL task intentionally unsolved."}]})
                with patch.object(runner, "model_call", side_effect=replies), patch.object(runner, "command", side_effect=command_with_trusted_fixture):
                    state = runner.run_task("ds-sql-exercise", arm_dir,
                        SimpleNamespace(arm=arm, max_steps=5, task_seconds=300,
                            images=runner.load_images(HERE / "images-1.0.0.lock.json", ["ds-sql-exercise"])), env)
                outcomes[arm] = state
                self.assertEqual(state["status"], "scored", json.dumps(state))
                self.assertEqual(state["agentStatus"], "finished", json.dumps(state))
                self.assertNotIn("executorCleanupError", state, json.dumps(state))
                records = json.loads((arm_dir / "ds-sql-exercise/tool-records.json").read_text())
                self.assertEqual(len(records), 1)
                self.assertEqual(records[0]["result"]["exitCode"], 0, str(records))
                self.assertNotIn(env["LITELLM_API_KEY"], json.dumps(records))
                self.assertTrue(all(item.get("exitCode") == 0 for item in state["cleanup"]), str(state["cleanup"]))
        self.assertEqual(outcomes["baseline-tools"]["result"], outcomes["relate"]["result"])
        print("Retained offline lifecycle evidence:", output)


if __name__ == "__main__":
    unittest.main()
