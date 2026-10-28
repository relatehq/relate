"""Luna terminal agent in original task images, with original task evaluators."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request
import uuid

from executor import RelateBridge

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[4]
UPSTREAM = ROOT / "benchmarks/media-agency/artifacts/upstream/agent-company"
PIN = "98b68ef82a47690c316f42fddb05baafaab56851"
ENV_MODEL = "gpt-4o-2024-08-06"


def command(args, *, timeout=120, env=None, input=None):
    result = subprocess.run(args, input=input, text=True, capture_output=True,
                            timeout=timeout, env=env, cwd=ROOT)
    return {"exitCode": result.returncode, "stdout": result.stdout, "stderr": result.stderr}


def checked(args, **kwargs):
    result = command(args, **kwargs)
    if result["exitCode"]:
        raise RuntimeError(json.dumps(result)[-8000:])
    return result["stdout"].strip()


def save(path, value):
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2))
    temporary.chmod(0o600)
    temporary.replace(path)


def health(services):
    checks = {}
    for service in services:
        try:
            with urllib.request.urlopen(f"http://localhost:2999/api/healthcheck/{service}", timeout=15) as response:
                checks[service] = response.status == 200
        except Exception:
            checks[service] = False
    return checks


def environment():
    # Node loads the existing worktree env; the key is never a command argument,
    # agent message, task-container environment, or result artifact.
    key = checked(["node", "--env-file=.env", "-e", "process.stdout.write(process.env.OPENAI_API_KEY || '')"])
    if not key:
        raise RuntimeError("OPENAI_API_KEY is missing")
    return {**os.environ, "LITELLM_API_KEY": key,
            "LITELLM_BASE_URL": "https://api.openai.com/v1", "LITELLM_MODEL": ENV_MODEL,
            "DECRYPTION_KEY": "theagentcompany is all you need"}


def model_call(messages, tools, transcript):
    payload = {
        "system": "You are completing a workplace task in a disposable benchmark environment. "
                  "Use the provided tools to inspect files, run programs, and interact with the workplace services. "
                  "You may install user-level dependencies. Do not access /utils, /npc, evaluator code, hidden tests, "
                  "host services unrelated to this task, or grading data. Finish with a concise completion report. "
                  "The task is in /instruction/task.md. Work in /workspace. "
                  "Service credentials: GitLab root / theagentcompany (root@local); "
                  "ownCloud theagentcompany / theagentcompany; Plane agent@company.com / theagentcompany; "
                  "RocketChat theagentcompany / theagentcompany. "
                  "Use the synthetic the-agent-company.com hostname already configured inside your task container. "
                  "For Relate, discover first; shell action input.arguments is JSON.stringify({command: ...}); "
                  "decode receipt.output.value for exitCode, stdout, and stderr.",
        "messages": messages, "tools": tools, "transcript": str(transcript),
    }
    result = checked(["node", "--env-file=.env", "--import", "tsx", str(HERE / "model-bridge.ts")],
                     input=json.dumps(payload) + "\n", timeout=200)
    reply = json.loads(result)
    if "error" in reply:
        raise RuntimeError(reply["error"])
    if reply["stopReason"] != "complete":
        raise RuntimeError("Model stopped: " + reply["stopReason"])
    return reply


def run_task(task, output, args, env):
    directory = output / task
    directory.mkdir()
    state = {"task": task, "arm": args.arm, "status": "starting"}
    save(directory / "trial.json", state)
    name = "agency-tac-task-" + uuid.uuid4().hex
    bridge = None
    created = False
    messages = [{"role": "user", "content": [{"type": "text", "text": "Complete the task in /instruction/task.md."}]}]
    tool_records = []
    try:
        image = f"ghcr.io/theagentcompany/{task}-image:1.0.0"
        pull = command(["docker", "pull", "--platform", "linux/amd64", image], timeout=1800)
        save(directory / "pull.json", pull)
        if pull["exitCode"]:
            raise RuntimeError("Task image pull failed; see pull.json")
        digest = checked(["docker", "image", "inspect", image, "--format", "{{.Id}}"])
        state["image"] = digest
        state["container"] = name
        checked(["docker", "run", "-d", "--name", name, "--platform", "linux/amd64",
                 "--network", "host", "--security-opt", "no-new-privileges", digest,
                 "sleep", "infinity"])
        created = True
        init = command(["docker", "exec", "--env", "LITELLM_API_KEY", "--env", "LITELLM_BASE_URL",
                        "--env", "LITELLM_MODEL", "--env", "SERVER_HOSTNAME=localhost", name,
                        "bash", "/utils/init.sh"], env=env, timeout=900)
        save(directory / "init.json", init)
        if init["exitCode"]:
            state["quotaExhausted"] = any(term in json.dumps(init) for term in ["credit_balance_exhausted", "insufficient_quota"])
            raise RuntimeError("Task initialization failed; see init.json")
        checked(["docker", "exec", name, "bash", "-lc",
                 "useradd -m -u 65532 agencyagent && chown -R agencyagent /workspace "
                 "&& chmod 700 /utils /npc && chmod -R a+rX /instruction"])
        started = time.monotonic()
        state["status"] = "running"
        save(directory / "trial.json", state)
        def shell(arguments):
            if len(tool_records) >= args.max_steps or time.monotonic() - started >= args.task_seconds:
                raise RuntimeError("Task action/time budget exhausted")
            result = command(["docker", "exec", "--user", "agencyagent", "--workdir", "/workspace",
                              "--env", "HOME=/home/agencyagent", "--env", "PYTHONPATH=", name,
                              "timeout", "45s", "bash", "-lc", arguments["command"]], timeout=55)
            tool_records.append({"name": "shell", "arguments": arguments, "result": result})
            save(directory / "tool-records.json", tool_records)
            return {**result, "stdout": result["stdout"][-50000:], "stderr": result["stderr"][-10000:]}
        shell_tool = {"name": "shell", "description": "Run a shell command in the task container; limit 45 seconds. Use background jobs and poll their output for longer work.",
                      "parameters": {"type": "object", "properties": {"command": {"type": "string"}},
                                     "required": ["command"], "additionalProperties": False}}
        tools = [shell_tool]
        if args.arm == "relate":
            bridge = RelateBridge([shell_tool], {"shell": shell})
            tools = [{"name": "discover", "description": "Discover Relate actions and schemas.",
                      "parameters": {"type": "object", "properties": {}, "additionalProperties": False}},
                     {"name": "execute", "description": bridge.instructions,
                      "parameters": {"type": "object", "properties": {"code": {"type": "string"}},
                                     "required": ["code"], "additionalProperties": False}}]
        try:
            for _ in range(args.max_steps):
                if time.monotonic() - started >= args.task_seconds:
                    raise RuntimeError("Task time budget exhausted")
                reply = model_call(messages, tools, directory / "model.jsonl")
                message = {"role": "assistant", "content": reply["content"]}
                if reply.get("continuation"):
                    message["continuation"] = reply["continuation"]
                messages.append(message)
                results = []
                for call in [b for b in reply["content"] if b["type"] == "tool_call"]:
                    if call.get("argumentError"):
                        raise ValueError(call["argumentError"])
                    if args.arm == "baseline-tools" and call["name"] == "shell":
                        value = shell(call["input"])
                    elif bridge and call["name"] == "discover":
                        value = bridge.call({"type": "discover"})
                    elif bridge and call["name"] == "execute":
                        value = bridge.call({"type": "execute", "code": call["input"]["code"]})
                    else:
                        raise ValueError("Unknown tool: " + call["name"])
                    results.append({"type": "tool_result", "id": call["id"], "content": json.dumps(value), "isError": False})
                if not results:
                    state["agentStatus"] = "finished"
                    break
                messages.append({"role": "user", "content": results})
            else:
                state["agentStatus"] = "step-limit"
        except Exception as error:
            state["agentStatus"] = "error"
            state["agentError"] = str(error)
        # Grade partial work too. Neither tool/provider failures nor budget
        # exhaustion remove the task from the planned denominator.
        save(directory / "trajectory.json", {"messages": messages, "toolCalls": tool_records})
        checked(["docker", "cp", str(directory / "trajectory.json"), name + ":/utils/trajectory.json"])
        evaluation = command(["docker", "exec", "--env", "LITELLM_API_KEY", "--env", "LITELLM_BASE_URL",
                              "--env", "LITELLM_MODEL", "--env", "DECRYPTION_KEY", name,
                              "python_default", "/utils/eval.py", "--trajectory_path", "/utils/trajectory.json",
                              "--result_path", "/utils/result.json"], env=env, timeout=600)
        save(directory / "evaluation-log.json", evaluation)
        if evaluation["exitCode"]:
            raise RuntimeError("Original evaluator failed; see evaluation-log.json")
        checked(["docker", "cp", name + ":/utils/result.json", str(directory / "result.json")])
        state["result"] = json.loads((directory / "result.json").read_text())
        state["status"] = "scored"
    except Exception as error:
        state.update(status="error", error=str(error))
    finally:
        if bridge:
            bridge.close()
        if created:
            state["cleanup"] = command(["docker", "rm", "-f", name], timeout=30)
        save(directory / "trial.json", state)
    return state


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--tasks", help="Comma-separated IDs; omitted selects all 175 original tasks")
    parser.add_argument("--arm", choices=["baseline-tools", "relate"], default="baseline-tools")
    parser.add_argument("--max-steps", type=int, default=80)
    parser.add_argument("--task-seconds", type=int, default=1800)
    parser.add_argument("--wait-services", type=int, default=3600)
    args = parser.parse_args()
    if checked(["git", "-C", str(UPSTREAM), "rev-parse", "HEAD"]) != PIN:
        raise RuntimeError("Unexpected upstream revision")
    available = sorted(p.name for p in (UPSTREAM / "workspaces/tasks").iterdir() if (p / "task.md").exists())
    tasks = args.tasks.split(",") if args.tasks else available
    if len(set(tasks)) != len(tasks) or any(task not in available for task in tasks):
        raise ValueError("Unknown or duplicated task selection")
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    manifest = {"benchmark": "TheAgentCompany", "upstream": PIN, "arm": args.arm,
                "model": "gpt-6-luna", "reasoning": "medium", "environmentModel": ENV_MODEL,
                "tasks": tasks, "maxSteps": args.max_steps, "taskSeconds": args.task_seconds,
                "status": "waiting-services", "integrationHashes": {str(p.relative_to(HERE)): hashlib.sha256(p.read_bytes()).hexdigest()
                    for p in HERE.rglob("*") if p.is_file() and p.suffix in {".py", ".ts"}}}
    if args.arm == "relate":
        image = checked(["docker", "image", "inspect", os.environ.get("AGENCY_EXECUTOR_IMAGE", "relate-agency:v2-14b8ca0"), "--format", "{{.Id}}"])
        os.environ["AGENCY_EXECUTOR_IMAGE"] = image
        manifest["executorImage"] = image
    save(output / "manifest.json", manifest)
    deadline = time.monotonic() + args.wait_services
    while True:
        checks = health(["gitlab", "owncloud", "rocketchat", "plane"])
        save(output / "health.json", checks)
        if all(checks.values()):
            break
        if time.monotonic() >= deadline:
            manifest["status"] = "service-health-timeout"
            save(output / "manifest.json", manifest)
            raise SystemExit("Workplace services did not become healthy; no task was attempted")
        time.sleep(15)
    env = environment()
    manifest["status"] = "running"
    save(output / "manifest.json", manifest)
    for task in tasks:
        result = run_task(task, output, args, env)
        print(task, result["status"], flush=True)
        if result.get("quotaExhausted") or any(term in result.get("agentError", "") for term in ["credit_balance_exhausted", "insufficient_quota"]):
            manifest["status"] = "stopped-quota"
            save(output / "manifest.json", manifest)
            raise SystemExit("No credits remaining; unstarted tasks remain in the plan")
    manifest["status"] = "exited"
    save(output / "manifest.json", manifest)
