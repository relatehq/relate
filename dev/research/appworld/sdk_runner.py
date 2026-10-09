"""AppWorld Python baselines versus a persistent TS REPL using the public SDK.

Run artifacts contain protected benchmark data and remain under .local/.
The OpenAI credential is read by the host and never passed into the REPL.
"""

import argparse
import hashlib
import json
import os
import selectors
import shutil
import subprocess
from pathlib import Path

import freezegun.api as clock
import requests
from acquire import music, payments
from appworld import AppWorld, load_task_ids
from appworld.common.path_store import path_store
from dotenv import dotenv_values
from runner import BASE, SCHEMA, SEMANTICS

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
SDK_PROMPT = """You are an agent operating simulated apps to complete a user's task.
Return JSON with exactly one key, code, containing executable TypeScript. No markdown.
Your TypeScript runs in a persistent Node REPL: bindings persist and top-level await is supported. Use console.log to inspect results; only printed output is visible.
Use the authenticated Relate SDK consumer `relate` for graph reads. Start by discovering the graph with relate.describe() and object details with relate.objects[apiName].describe(). Read descriptions before guessing fields or relationships.
For capabilities outside the graph and task completion, original application APIs are also available as asynchronous apis.APP.OPERATION({named: arguments}). Discover them with await apis.api_docs.show_app_descriptions(), await apis.api_docs.show_api_descriptions({app_name: ...}) and await apis.api_docs.show_api_doc({app_name: ..., api_name: ...}). Read docs before guessing arguments.
Always finish pagination. Use TypeScript loops for bulk work.
Complete via await apis.supervisor.complete_task({answer: ...}) for a question; omit answer for an action task.
Do not access databases, files on the real machine, task solutions, or evaluation internals. Imports and host filesystem/network access are not available.
"""
AUTH = """\nAll three apps are already authenticated equally by the host. The variable tokens contains spotify, phone and venmo access tokens. Use the appropriate token with original APIs; do not log in again. Work with real API data; never invent records.\n"""
COMPLETION = """\nPrinting a result does not complete the task. When finished, call the completion API described above with your final answer. For numeric questions, submit only the numeric value, without explanatory text, currency symbols, or units. For questions asking for a name or title, submit only that name or title, without explanatory text. Follow any answer-format requirements stated in the task.\n"""
SOURCES = ["sdk_runner.py", "sdk-repl.mjs", "sdk-graph.mjs", "acquire.py", "runner.py"]


def dump(value):
    return json.dumps(value, ensure_ascii=False, default=str, separators=(",", ":"))


class NodeRepl:
    def __init__(self, world, rows, tokens):
        self.world = world
        # Permission checks also constrain escaped JS contexts: no arbitrary host
        # files, subprocesses, workers or network. Only code/dependencies readable.
        readable = [
            HERE / "sdk-repl.mjs",
            HERE / "sdk-graph.mjs",
            ROOT / "node_modules",
            ROOT / "package.json",
        ]
        for package in (ROOT / "packages").iterdir():
            readable += [
                package / "dist",
                package / "package.json",
                package / "node_modules",
            ]
        command = [shutil.which("node"), "--permission"]
        command += [f"--allow-fs-read={path}" for path in readable]
        command += [str(HERE / "sdk-repl.mjs")]
        self.process = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            env={"PATH": os.environ["PATH"], "NODE_NO_WARNINGS": "1"},
            cwd="/tmp",
        )
        self.buffer = b""
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.process.stdout, selectors.EVENT_READ)
        self.request({"type": "init", "rows": rows, "tokens": tokens})

    def send(self, value):
        self.process.stdin.write(dump(value) + "\n")
        self.process.stdin.flush()

    def request(self, value):
        self.send(value)
        deadline = clock.real_perf_counter() + 60
        while True:
            remaining = deadline - clock.real_perf_counter()
            while b"\n" not in self.buffer:
                remaining = deadline - clock.real_perf_counter()
                if remaining <= 0 or not self.selector.select(remaining):
                    self.process.kill()
                    raise TimeoutError("Node cell exceeded 60 seconds")
                chunk = os.read(self.process.stdout.fileno(), 65536)
                if not chunk:
                    raise RuntimeError(
                        "Node exited: " + self.process.stderr.read()[:2000]
                    )
                self.buffer += chunk
            line, self.buffer = self.buffer.split(b"\n", 1)
            event = json.loads(line)
            if event["type"] == "api":
                before = len(self.world.requester.request_tracker.requests)
                try:
                    if (
                        event["app"] == "admin"
                        or event["app"].startswith("_")
                        or event["api"].startswith("_")
                    ):
                        raise ValueError("Private app APIs are unavailable")
                    result = getattr(
                        getattr(self.world.apis, event["app"]), event["api"]
                    )(**event["args"])
                    response = {
                        "type": "api-result",
                        "id": event["id"],
                        "result": result,
                    }
                except Exception as error:
                    response = {
                        "type": "api-result",
                        "id": event["id"],
                        "error": f"{type(error).__name__}: {error}",
                    }
                records = self.world.requester.request_tracker.requests[before:]
                response["invalidate"] = any(
                    r["method"] not in ("get", "head") for r in records
                )
                self.send(response)
            elif event["type"] == "error":
                raise RuntimeError(event["error"])
            else:
                return event

    def close(self):
        if self.process.poll() is None:
            try:
                self.request({"type": "close"})
                self.process.wait(timeout=5)
            except Exception:
                self.process.kill()
                self.process.wait(timeout=5)
        self.selector.close()
        for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
            stream.close()


def code_action(result):
    calls = [
        item for item in result.get("output", []) if item.get("type") == "function_call"
    ]
    if len(calls) != 1 or calls[0].get("name") != "execute_code":
        return "", None
    return calls[0]["arguments"], calls[0]["call_id"]


def model_call(key, model, messages, max_output, reasoning):
    start = clock.real_perf_counter()
    response = requests.post(
        "https://api.openai.com/v1/responses",
        headers={"Authorization": f"Bearer {key}"},
        json={
            "model": model,
            "store": False,
            "input": messages,
            "reasoning": {"effort": reasoning},
            "max_output_tokens": max_output,
            "include": ["reasoning.encrypted_content"],
            "tools": [
                {
                    "type": "function",
                    "name": "execute_code",
                    "description": "Execute the next code cell in the persistent interpreter and return its printed output. Inspect the result before choosing the next cell.",
                    "strict": True,
                    "parameters": SCHEMA,
                }
            ],
            "tool_choice": {"type": "function", "name": "execute_code"},
            "parallel_tool_calls": False,
        },
        timeout=180,
    )
    if response.status_code != 200:
        # Do not persist request headers or a requests exception object.
        raise RuntimeError(f"OpenAI HTTP {response.status_code}: {response.text[:600]}")
    result = response.json()
    content, call_id = code_action(result)
    usage = result["usage"]
    cached = usage.get("input_tokens_details", {}).get("cached_tokens", 0)
    rates = (0.20, 0.02, 1.25) if "nano" in model else (0.75, 0.075, 4.5)
    cost = (
        (usage["input_tokens"] - cached) * rates[0]
        + cached * rates[1]
        + usage["output_tokens"] * rates[2]
    ) / 1_000_000
    return content, {
        "usage": usage,
        "provider_output": result.get("output", []),
        "call_id": call_id,
        "estimated_usd": cost,
        "model": result["model"],
        "status": result["status"],
        "seconds": clock.real_perf_counter() - start,
    }


def run(args, key, task_id, condition, repeat, spent):
    name = f"{args.run}-{condition}-{repeat}"
    out = HERE / ".local/runs" / args.run / f"{task_id}__{condition}__{repeat}"
    out.mkdir()
    start = clock.real_perf_counter()
    steps, error, node = [], None, None
    termination = "step-budget"
    completed = False
    polling = 0
    acquisition_calls = 0
    acquisition_seconds = 0
    setup_seconds = 0
    messages = [
        {
            "role": "system",
            "content": (
                SDK_PROMPT
                if condition == "sdk"
                else BASE + (SEMANTICS if condition == "static" else "")
            )
            .replace(
                "Return JSON with exactly one key, code, containing executable Python. No markdown.",
                "Use execute_code to run the next Python cell.",
            )
            .replace(
                "Return JSON with exactly one key, code, containing executable TypeScript. No markdown.",
                "Use execute_code to run the next TypeScript cell.",
            )
            + AUTH
            + COMPLETION
            + "\nWork iteratively: write one short cell, inspect its printed results, then choose the next cell. Read documentation output before attempting the documented operation.\n",
        }
    ]
    with AppWorld(
        task_id=task_id,
        experiment_name=name,
        random_seed=100,
        timeout_seconds=60,
        load_ground_truth=False,
    ) as world:
        try:
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
                for app in ["spotify", "phone", "venmo"]
            }
            setup_calls = len(world.requester.request_tracker.requests)
            world.shell.user_ns["tokens"] = tokens
            if condition == "sdk":
                acquire_start = clock.real_perf_counter()
                # Same fixed coverage for every task; no task-id/answer-based routing.
                rows = music(world.apis, tokens["spotify"]) | payments(
                    world.apis, tokens["phone"], tokens["venmo"]
                )
                acquisition_calls = (
                    len(world.requester.request_tracker.requests) - setup_calls
                )
                acquisition_seconds = clock.real_perf_counter() - acquire_start
                node = NodeRepl(world, rows, tokens)
            setup_seconds = clock.real_perf_counter() - start
            messages.append(
                {
                    "role": "user",
                    "content": dump(
                        {
                            "task": world.task.instruction,
                            "supervisor": dict(world.task.supervisor),
                            "date": str(world.task.datetime),
                        }
                    ),
                }
            )
            (out / "initial_messages.json").write_text(dump(messages))
            for turn in range(args.steps):
                # Conservative reservation excludes cache discounts and uses a
                # byte upper bound for input tokens, leaving no overshoot per call.
                rate_in, rate_out = (
                    (0.20, 1.25) if "nano" in args.model else (0.75, 4.5)
                )
                reserve = (
                    len(dump(messages).encode()) * rate_in
                    + args.max_output_tokens * rate_out
                ) / 1_000_000
                if spent[0] + reserve > args.max_cost_usd:
                    termination = "cost-budget"
                    break
                content, model = model_call(
                    key, args.model, messages, args.max_output_tokens, args.reasoning
                )
                spent[0] += model["estimated_usd"]
                # Preserve reasoning (encrypted for stateless requests), message
                # phases and the actual call; only the tool's arguments execute.
                messages.extend(model["provider_output"])
                execution_start = clock.real_perf_counter()
                before = len(world.requester.request_tracker.requests)
                event = {}
                try:
                    if model["call_id"] is None:
                        output = "Model returned no unambiguous execute_code action."
                        termination = "model-no-action"
                    else:
                        code = json.loads(content)["code"]
                        if node:
                            event = node.request({"type": "execute", "code": code})
                            output = event["output"]
                        else:
                            output = world.execute(code)
                except TimeoutError as exc:
                    event = {"error": str(exc)}
                    output = f"Execution timed out: {exc}"
                    termination = "execution-timeout"
                except (ValueError, KeyError, TypeError) as exc:
                    output = f"Invalid response: {exc}"
                visible = output[: args.output_chars]
                if len(output) > args.output_chars:
                    visible += "\n[OUTPUT TRUNCATED: select fewer fields/records or compute a summary in code]"
                if model["call_id"] is not None:
                    messages.append(
                        {
                            "type": "function_call_output",
                            "call_id": model["call_id"],
                            "output": visible
                            or "Execution produced no printed output.",
                        }
                    )
                step = {
                    "turn": turn + 1,
                    "content": content,
                    "output": output,
                    "visible_output": visible,
                    "model": model,
                    "execution_seconds": clock.real_perf_counter() - execution_start,
                    "api_calls": len(world.requester.request_tracker.requests) - before,
                    "snapshot_fetches": event.get("snapshot_fetches", 0),
                    "error": event.get("error"),
                }
                steps.append(step)
                (out / "steps.json").write_text(dump(steps))
                print(
                    dump(
                        {
                            "task": task_id,
                            "condition": condition,
                            "repeat": repeat,
                            "turn": turn + 1,
                            "cost_usd": round(spent[0], 5),
                        }
                    ),
                    flush=True,
                )
                before = len(world.requester.request_tracker.requests)
                completed = world.task_completed()
                polling += len(world.requester.request_tracker.requests) - before
                if (
                    args.completion_feedback
                    and not completed
                    and model["call_id"] is not None
                ):
                    reminder = (
                        "await apis.supervisor.complete_task({answer: value})"
                        if node
                        else "apis.supervisor.complete_task(answer=value)"
                    )
                    messages[-1]["output"] += (
                        "\nTask status: incomplete. When you have the answer, submit it with "
                        + reminder
                        + ". Printing an answer does not complete the task."
                    )
                    step["visible_output"] = messages[-1]["output"]
                    (out / "steps.json").write_text(dump(steps))
                if termination in ("execution-timeout", "model-no-action"):
                    break
                if completed:
                    termination = "completed"
                    break
                if (
                    sum(s["model"]["usage"]["output_tokens"] for s in steps)
                    >= args.generated_budget
                ):
                    termination = "generated-budget"
                    break
        except Exception as exc:
            error = f"{type(exc).__name__}: {exc}"
            termination = "infrastructure-error"
        finally:
            if node:
                node.close()
        records = world.requester.request_tracker.requests[:]
        (out / "api_calls.json").write_text(dump(records))
        # Direct host API calls update the in-memory world. AppWorld's evaluator
        # reads the normal output DBs; save_state() alone writes a checkpoint.
        # A no-op public execution flushes the current state to evaluator input.
        if condition == "sdk":
            flushed = world.execute("pass")
            if flushed.startswith("Execution failed"):
                raise RuntimeError("Unable to persist SDK world for evaluation")
        world.save_state()
    from appworld.evaluator import evaluate_task

    evaluation = evaluate_task(task_id=task_id, experiment_name=name)
    (out / "evaluation.json").write_text(dump(evaluation.to_dict()))
    result = {
        "task_id": task_id,
        "condition": condition,
        "repeat": repeat,
        "model": args.model,
        "success": evaluation.success if error is None else None,
        "termination": termination,
        "completed": completed,
        "steps": len(steps),
        "seconds": clock.real_perf_counter() - start,
        "setup_seconds": setup_seconds,
        "acquisition_seconds": acquisition_seconds,
        "setup_calls": locals().get("setup_calls", 0),
        "acquisition_calls": acquisition_calls,
        "source_calls": len(records) - polling,
        "agent_source_calls": len(records)
        - polling
        - locals().get("setup_calls", 0)
        - acquisition_calls,
        "prompt_tokens": sum(s["model"]["usage"]["input_tokens"] for s in steps),
        "cached_tokens": sum(
            s["model"]["usage"].get("input_tokens_details", {}).get("cached_tokens", 0)
            for s in steps
        ),
        "generated_tokens": sum(s["model"]["usage"]["output_tokens"] for s in steps),
        "model_seconds": sum(s["model"]["seconds"] for s in steps),
        "estimated_usd": sum(s["model"]["estimated_usd"] for s in steps),
        "snapshot_fetches": sum(s["snapshot_fetches"] for s in steps),
        "error": error,
    }
    (out / "result.json").write_text(dump(result))
    print(dump(result), flush=True)
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", required=True)
    parser.add_argument("--tasks", nargs="+", required=True)
    parser.add_argument(
        "--conditions",
        nargs="+",
        choices=["raw", "static", "sdk"],
        default=["raw", "static", "sdk"],
    )
    parser.add_argument("--repeats", type=int, default=1)
    parser.add_argument(
        "--model", choices=["gpt-5.4-nano", "gpt-5.4-mini"], default="gpt-5.4-nano"
    )
    parser.add_argument(
        "--credentials",
        type=Path,
        required=True,
        help="Host-only dotenv file; only OPENAI_API_KEY is read",
    )
    parser.add_argument("--reasoning", choices=["none", "low", "medium"], default="low")
    parser.add_argument(
        "--completion-feedback",
        action="store_true",
        help="Post-hoc ablation: return the task completion status and submission syntax after each cell",
    )
    parser.add_argument("--steps", type=int, default=14)
    parser.add_argument("--max-output-tokens", type=int, default=4096)
    parser.add_argument("--generated-budget", type=int, default=14000)
    parser.add_argument("--output-chars", type=int, default=14000)
    parser.add_argument("--max-cost-usd", type=float, default=5)
    args = parser.parse_args()
    path_store.update_root(str(HERE / ".local/world"))
    allowed = set(load_task_ids("train") + load_task_ids("dev"))
    if not set(args.tasks) <= allowed:
        parser.error("Only train/dev tasks permitted")
    key = dotenv_values(args.credentials).get("OPENAI_API_KEY")
    if not key or key.startswith("encrypted:"):
        parser.error("No usable OPENAI_API_KEY in credentials file")
    root = HERE / ".local/runs" / args.run
    root.mkdir(parents=True, exist_ok=False)
    config = {k: v for k, v in vars(args).items() if k != "credentials"}
    config.update(
        {
            "git_head": subprocess.check_output(
                ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True
            ).strip(),
            "source_sha256": {
                name: hashlib.sha256((HERE / name).read_bytes()).hexdigest()
                for name in SOURCES
            },
            "reasoning": args.reasoning,
            "provider_seed": None,
            "action_protocol": "single execute_code function call; stateless encrypted reasoning replay",
            "world_seed": 100,
            "sdk_prompt": SDK_PROMPT,
            "raw_prompt": BASE,
            "static_notes": SEMANTICS,
            "completion_instruction": COMPLETION,
            "source_acquisition": "fixed music+payments union for every SDK episode",
            "pricing_per_million": {
                "nano": [0.20, 0.02, 1.25],
                "mini": [0.75, 0.075, 4.5],
            },
        }
    )
    (root / "config.json").write_text(dump(config))
    (root / "source").mkdir()
    for name in SOURCES:
        shutil.copyfile(HERE / name, root / "source" / name)
    spent = [0.0]
    results = []
    for repeat in range(args.repeats):
        for index, task in enumerate(args.tasks):
            offset = (repeat + index) % len(args.conditions)
            order = args.conditions[offset:] + args.conditions[:offset]
            for condition in order:
                results.append(run(args, key, task, condition, repeat, spent))
                (root / "summary.json").write_text(dump(results))
                if results[-1]["termination"] in (
                    "cost-budget",
                    "infrastructure-error",
                ):
                    raise SystemExit(
                        "Stopped after budget/infrastructure failure; completed artifacts retained"
                    )


if __name__ == "__main__":
    main()
