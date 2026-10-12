import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import budget_compare
import ergonomics_compare as comparison
import explorer
import sdk_runner
import write_audit
from validate_ergonomics import validate_spending
from retained_usage import arm_status, episode_usage


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value))


class RunnerTests(unittest.TestCase):
    def exercise(self, budget, crash=False, model_error=False, rejected=None, invalid_content=None):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        here = Path(temp.name)
        (here / ".local/runs/test").mkdir(parents=True)
        condition = "sdk" if rejected is not None else "raw_ts"
        case = here / f".local/runs/test/task__{condition}__0"
        world = MagicMock()
        world.__enter__.return_value = world
        world.task.supervisor = SimpleNamespace(email="test", phone_number="test")

        # dict(supervisor) is part of the real setup contract.
        class Supervisor(dict):
            email = "test"
            phone_number = "test"

        world.task.supervisor = Supervisor()
        world.task.instruction = "test"
        world.task.datetime = "2026-01-01"
        world.apis.supervisor.show_account_passwords.return_value = [
            {"account_name": a, "password": "test"}
            for a in ["spotify", "phone", "venmo"]
        ]
        world.requester.request_tracker.requests = []
        world.execute.return_value = ""
        world.task_completed.return_value = False
        limits = []
        worker = MagicMock()

        def execute(request):
            saved = json.loads((case / "steps.json").read_text())
            self.assertEqual(saved[-1]["execution_status"], "pending")
            self.assertEqual(saved[-1]["model"]["estimated_usd"], 0.1)
            if crash:
                raise RuntimeError("worker crashed")
            return {"output": "ok"}

        worker.request.side_effect = execute

        def response(key, model, messages, limit, reasoning):
            limits.append(limit)
            if rejected is not None:
                if len(limits) == 1:
                    return invalid_content or "", {
                        "estimated_usd": 0.1, "usage": {"input_tokens": 10, "output_tokens": 10},
                        "provider_output": rejected, "call_id": "bad" if invalid_content else None, "seconds": 0.01,
                        "model": model, "status": "tool_use",
                    }
                feedback = messages[-1]
                diagnostic = json.loads(feedback.get("output", feedback.get("content")))
                self.assertEqual(diagnostic["error"]["type"], "ToolProtocolError")
                self.assertIn("await completeTask", diagnostic["error"]["guidance"])
                self.assertEqual(worker.request.call_count, 0)
                world.task_completed.return_value = True
            if model_error:
                raise RuntimeError("provider connection failed")
            code = "await completeTask({answer: '34'});" if rejected is not None else "console.log(1)"
            return json.dumps({"code": code}), {
                "estimated_usd": 0.1,
                "usage": {"input_tokens": 10, "output_tokens": limit},
                "provider_output": [],
                "call_id": "call",
                "seconds": 0.01,
                "model": model,
                "status": "completed",
            }

        args = SimpleNamespace(
            run="test",
            steps=4,
            model="nano",
            max_output_tokens=4096,
            generated_budget=budget,
            reasoning="low",
            max_cost_usd=10,
            output_chars=100,
            completion_feedback=False,
        )
        evaluation = MagicMock(success=False)
        evaluation.to_dict.return_value = {}
        with (
            patch.object(sdk_runner, "HERE", here),
            patch.object(sdk_runner, "AppWorld", return_value=world),
            patch.object(sdk_runner, "NodeRepl", return_value=worker),
            patch.object(sdk_runner, "music", return_value={}),
            patch.object(sdk_runner, "graph_payments", return_value={}),
            patch.object(sdk_runner, "acquisition_coverage", return_value={}),
            patch.object(sdk_runner, "model_call", side_effect=response),
            patch("appworld.evaluator.evaluate_task", return_value=evaluation),
            contextlib.redirect_stdout(io.StringIO()),
        ):
            result = sdk_runner.run(args, "unused", "task", condition, 0, [0])
        return result, limits, case

    def test_sdk_rejects_native_completion_then_recovers(self):
        for rejected in [
            [{"role": "assistant", "content": [{"type": "tool_use", "id": "bad", "name": "completeTask", "input": {"answer": "34"}}]}],
            [{"type": "function_call", "call_id": "bad", "name": "completeTask", "arguments": '{"answer":"34"}'}],
            [{"role": "assistant", "content": "34"}],
        ]:
            with self.subTest(rejected=rejected):
                result, _, case = self.exercise(5000, rejected=rejected)
                self.assertEqual(result["termination"], "completed")
                self.assertEqual(result["steps"], 2)
                self.assertEqual(result["estimated_usd"], 0.2)
                steps = json.loads((case / "steps.json").read_text())
                self.assertEqual(steps[0]["execution_status"], "failed")
                self.assertEqual(steps[0]["api_calls"], 0)
                self.assertEqual(steps[0]["model"]["provider_output"], rejected)

    def test_sdk_malformed_arguments_recover_without_execution(self):
        for content in ['not json', '[]', '{"code": 34}', '{"answer": "34"}']:
            with self.subTest(content=content):
                rejected = [{"type": "function_call", "call_id": "bad", "name": "execute_code", "arguments": content}]
                result, _, _ = self.exercise(5000, rejected=rejected, invalid_content=content)
                self.assertEqual(result["termination"], "completed")

    def test_worker_crash_retains_billed_response(self):
        result, limits, case = self.exercise(5000, crash=True)
        self.assertEqual(result["termination"], "infrastructure-error")
        self.assertEqual(result["steps"], 1)
        self.assertEqual(result["prompt_tokens"], 10)
        self.assertEqual(result["generated_tokens"], 4096)
        self.assertEqual(result["estimated_usd"], 0.1)
        self.assertEqual(
            json.loads((case / "steps.json").read_text())[0]["execution_status"],
            "failed",
        )

    def test_generated_allowance_is_clamped_before_each_request(self):
        result, limits, _ = self.exercise(5000)
        self.assertEqual(limits, [4096, 904])
        self.assertEqual(result["generated_tokens"], 5000)
        self.assertEqual(result["termination"], "generated-budget")

    def test_empty_budget_makes_no_request(self):
        result, limits, _ = self.exercise(0)
        self.assertEqual(limits, [])
        self.assertEqual(result["estimated_usd"], 0)

    def test_failed_request_is_retained_with_unknown_usage(self):
        _, _, case = self.exercise(5000, model_error=True)
        self.assertEqual(episode_usage(case)["attempted_requests"], 1)
        self.assertEqual(episode_usage(case)["requests_without_usage"], 1)


class ReportingTests(unittest.TestCase):
    def test_budget_rejects_partial_spending_and_unknown_usage(self):
        with self.assertRaises(AssertionError):
            validate_spending({"estimated_usd": 2.25, "requests_without_usage": 0})
        with self.assertRaisesRegex(AssertionError, "unknown request usage"):
            validate_spending({"estimated_usd": 0.75, "requests_without_usage": 1})

    def test_partial_and_unfinished_arms_keep_all_usage(self):
        with (
            tempfile.TemporaryDirectory() as temp,
            tempfile.TemporaryDirectory() as output,
        ):
            here = Path(temp) / "repo/dev/research/appworld"
            base = here / ".local/runs" / (comparison.PREFIX + "baseline-v1")
            config = {
                "tasks": [f"task{i}" for i in range(6)],
                "conditions": ["sdk"],
                "repeats": 2,
                "git_head": "test",
                "source_sha256": {},
            }
            save(base / "config.json", config)
            case = base / "task0__sdk__0"
            step = {
                "turn": 1,
                "content": '{"code":"console.log(1)"}',
                "output": "ok",
                "visible_output": "ok",
                "error": None,
                "api_calls": 0,
                "execution_seconds": 0,
                "model": {
                    "model": "nano",
                    "usage": {"input_tokens": 10, "output_tokens": 5},
                    "estimated_usd": 0.75,
                },
            }
            save(case / "steps.json", [step])
            result = dict.fromkeys(
                [
                    "seconds",
                    "cached_tokens",
                    "model_seconds",
                    "setup_seconds",
                    "acquisition_seconds",
                    "source_calls",
                    "acquisition_calls",
                    "agent_source_calls",
                    "setup_calls",
                ],
                0,
            )
            result.update(
                task_id="task0",
                condition="sdk",
                repeat=0,
                success=True,
                completed=True,
                termination="completed",
                steps=1,
                error=None,
                prompt_tokens=10,
                generated_tokens=5,
                estimated_usd=0.75,
            )
            save(case / "result.json", result)
            save(case / "api_calls.json", [])
            save(case / "evaluation.json", {})
            save(case / "initial_messages.json", [])
            (here / "explorer.html").write_text("<html></html>")
            with (
                patch.object(comparison, "HERE", here),
                patch.object(budget_compare, "HERE", here),
                patch.object(write_audit, "HERE", here),
                patch.object(comparison.subprocess, "check_output", return_value=b""),
                patch.object(explorer, "HERE", here),
                contextlib.redirect_stdout(io.StringIO()),
            ):
                report = comparison.analyze()
                self.assertEqual(report["estimated_usd"], 0.75)
                self.assertEqual(report["attempted_requests"], 1)
                self.assertFalse(report["runs"][base.name]["comparison_eligible"])
                self.assertEqual(report["comparisons"], {})
                # A second response has no result because execution is still pending.
                save(base / "task1__sdk__0/steps.json", [step])
                report = comparison.analyze()
                self.assertEqual(report["estimated_usd"], 1.5)
                self.assertEqual(report["attempted_requests"], 2)
                explorer.build(Path(output), [])
                data = json.loads((Path(output) / "data.json").read_text())[0]
                self.assertEqual(len(data["episodes"]), 2)
                self.assertEqual(data["estimated_usd"], 1.5)
                self.assertFalse(data["comparison_eligible"])

    def test_twelve_results_require_exact_cases_and_no_infrastructure_errors(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            config = {
                "tasks": [f"task{i}" for i in range(6)],
                "conditions": ["sdk"],
                "repeats": 2,
            }
            for task in config["tasks"]:
                for repeat in range(2):
                    save(
                        root / f"{task}__sdk__{repeat}/result.json",
                        dict(
                            task_id=task,
                            condition="sdk",
                            repeat=repeat,
                            error=None,
                            success=False,
                        ),
                    )
            self.assertTrue(arm_status(root, config)["comparison_eligible"])
            save(
                root / "task0__sdk__0/result.json",
                dict(
                    task_id="task0",
                    condition="sdk",
                    repeat=0,
                    error="RuntimeError",
                    success=None,
                ),
            )
            self.assertFalse(arm_status(root, config)["comparison_eligible"])


if __name__ == "__main__":
    unittest.main()
