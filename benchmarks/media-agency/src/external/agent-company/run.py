"""Luna terminal agent in original task images, with original task evaluators."""
import argparse
import hashlib
import json
import os
import re
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
ENV_MODEL = "openai/gpt-4o-2024-08-06"


def command(args, *, timeout=120, env=None, input=None):
    result = subprocess.run(args, input=input, text=True, capture_output=True,
                            timeout=timeout, env=env, cwd=ROOT)
    stdout, stderr = result.stdout, result.stderr
    # Upstream's NPC launcher prints its command including the API key. Keep
    # that trusted initialization output out of retained artifacts verbatim.
    for key in ("LITELLM_API_KEY", "OPENAI_API_KEY"):
        secret = (env or {}).get(key)
        if secret:
            stdout, stderr = stdout.replace(secret, "[redacted]"), stderr.replace(secret, "[redacted]")
    return {"exitCode": result.returncode, "stdout": stdout, "stderr": stderr}


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


def required_services(tasks):
    """Read the pinned benchmark's simple YAML lists, rejecting unknown forms."""
    services = set()
    allowed = {"gitlab", "owncloud", "rocketchat", "plane"}
    for task in tasks:
        for line in (UPSTREAM / "workspaces/tasks" / task / "dependencies.yml").read_text().splitlines():
            line = line.split("#", 1)[0].strip()
            if not line:
                continue
            if not line.startswith("- ") or line[2:] not in allowed:
                raise ValueError(f"Unknown service dependency in {task}: {line}")
            services.add(line[2:])
    return sorted(services)


def load_images(path, tasks):
    data = json.loads(Path(path).read_text())
    if data.get("upstream") != PIN or data.get("platform") != "linux/amd64":
        raise ValueError("Image lock does not match the benchmark source/platform")
    images = {}
    for task in tasks:
        row = data.get("images", {}).get(task, {})
        reference = row.get("reference", "")
        expected = re.escape(f"ghcr.io/theagentcompany/{task}-image") + r"@sha256:[a-f0-9]{64}"
        if row.get("status") != "resolved" or not re.fullmatch(expected, reference):
            raise ValueError(f"Image lock has no resolved original image for {task}")
        images[task] = reference
    return images


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
    agent_name, grader_name = name + "-agent", name + "-grader"
    bridge = None
    containers, snapshots = [], []
    messages = [{"role": "user", "content": [{"type": "text", "text": "Complete the task in /instruction/task.md."}]}]
    tool_records = []
    try:
        image = getattr(args, "images", {}).get(task, f"ghcr.io/theagentcompany/{task}-image:1.0.0")
        state["requestedImage"] = image
        pull = command(["docker", "pull", "--platform", "linux/amd64", image], timeout=1800)
        save(directory / "pull.json", pull)
        if pull["exitCode"]:
            raise RuntimeError("Task image pull failed; see pull.json")
        digest = checked(["docker", "image", "inspect", image, "--format", "{{.Id}}"])
        volumes = json.loads(checked(["docker", "image", "inspect", image, "--format", "{{json .Config.Volumes}}"]))
        if volumes:
            raise RuntimeError("Task image declares volumes that docker commit cannot snapshot; explicit state transfer is required")
        state["image"] = digest
        state["container"] = name
        checked(["docker", "run", "-d", "--name", name, "--platform", "linux/amd64",
                 "--network", "host", "--security-opt", "no-new-privileges", digest,
                 "sleep", "infinity"])
        containers.append(name)
        init = command(["docker", "exec", "--env", "LITELLM_API_KEY", "--env", "LITELLM_BASE_URL",
                        "--env", "LITELLM_MODEL", "--env", "SERVER_HOSTNAME=localhost", name,
                        "bash", "/utils/init.sh"], env=env, timeout=900)
        save(directory / "init.json", init)
        if init["exitCode"]:
            state["quotaExhausted"] = any(term in json.dumps(init) for term in ["credit_balance_exhausted", "insufficient_quota"])
            raise RuntimeError("Task initialization failed; see init.json")
        # Preserve root permissions required by installation/system tasks. NPC
        # processes and their API-key environment stay in this trusted container.
        # The agent gets the initialized filesystem in a separate PID namespace,
        # with protected directories covered by empty read-only bind mounts.
        initialized = checked(["docker", "commit", name], timeout=180)
        snapshots.append(initialized)
        state["initializedImage"] = initialized
        hidden = directory / "hidden"
        hidden.mkdir()
        checked(["docker", "run", "-d", "--name", agent_name, "--platform", "linux/amd64",
                 "--network", "host", "--add-host", "the-agent-company.com:127.0.0.1",
                 "--security-opt", "no-new-privileges", "--env", "PYTHONPATH=",
                 "--mount", f"type=bind,src={hidden},dst=/utils,readonly",
                 "--mount", f"type=bind,src={hidden},dst=/npc,readonly", initialized,
                 "sleep", "infinity"])
        containers.append(agent_name)
        state["agentContainer"] = agent_name
        started = time.monotonic()
        state["status"] = "running"
        save(directory / "trial.json", state)
        def shell(arguments):
            if len(tool_records) >= args.max_steps or time.monotonic() - started >= args.task_seconds:
                raise RuntimeError("Task action/time budget exhausted")
            result = command(["docker", "exec", "--workdir", "/workspace",
                              "--env", "PYTHONPATH=", agent_name,
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
        save(directory / "filesystem-diff.json", command(["docker", "diff", agent_name]))
        final_image = checked(["docker", "commit", agent_name], timeout=180)
        snapshots.append(final_image)
        state["finalImage"] = final_image
        # Bind mounts are excluded from image commits, so the grader gets the
        # original protected files plus all agent filesystem changes. The agent
        # cannot see this container's processes, credentials or decrypted code.
        checked(["docker", "run", "-d", "--name", grader_name, "--platform", "linux/amd64",
                 "--network", "host", "--add-host", "the-agent-company.com:127.0.0.1",
                 "--security-opt", "no-new-privileges", "--env", "PYTHONPATH=/utils",
                 final_image, "sleep", "infinity"])
        containers.append(grader_name)
        checked(["docker", "cp", str(directory / "trajectory.json"), grader_name + ":/utils/trajectory.json"])
        evaluation = command(["docker", "exec", "--env", "LITELLM_API_KEY", "--env", "LITELLM_BASE_URL",
                              "--env", "LITELLM_MODEL", "--env", "DECRYPTION_KEY", grader_name,
                              "python_default", "/utils/eval.py", "--trajectory_path", "/utils/trajectory.json",
                              "--result_path", "/utils/result.json"], env=env, timeout=600)
        save(directory / "evaluation-log.json", evaluation)
        if evaluation["exitCode"]:
            raise RuntimeError("Original evaluator failed; see evaluation-log.json")
        checked(["docker", "cp", grader_name + ":/utils/result.json", str(directory / "result.json")])
        state["result"] = json.loads((directory / "result.json").read_text())
        state["status"] = "scored"
    except Exception as error:
        state.update(status="error", error=str(error))
    finally:
        if bridge:
            try:
                bridge.close()
            except Exception as error:
                state["executorCleanupError"] = str(error)
        state["cleanup"] = []
        for container in reversed(containers):
            try:
                state["cleanup"].append({"container": container, **command(["docker", "rm", "-f", container], timeout=30)})
            except Exception as error:
                state["cleanup"].append({"container": container, "error": str(error)})
        for snapshot in reversed(snapshots):
            try:
                state["cleanup"].append({"image": snapshot, **command(["docker", "image", "rm", "--no-prune", snapshot], timeout=30)})
            except Exception as error:
                state["cleanup"].append({"image": snapshot, "error": str(error)})
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
    parser.add_argument("--image-lock", type=Path, default=HERE / "images-1.0.0.lock.json")
    args = parser.parse_args()
    if checked(["git", "-C", str(UPSTREAM), "rev-parse", "HEAD"]) != PIN:
        raise RuntimeError("Unexpected upstream revision")
    available = sorted(p.name for p in (UPSTREAM / "workspaces/tasks").iterdir() if (p / "task.md").exists())
    tasks = args.tasks.split(",") if args.tasks else available
    if len(set(tasks)) != len(tasks) or any(task not in available for task in tasks):
        raise ValueError("Unknown or duplicated task selection")
    args.images = load_images(args.image_lock, tasks)
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    manifest = {"benchmark": "TheAgentCompany", "upstream": PIN, "arm": args.arm,
                "model": "gpt-6-luna", "reasoning": "medium", "environmentModel": ENV_MODEL,
                "tasks": tasks, "maxSteps": args.max_steps, "taskSeconds": args.task_seconds,
                "status": "waiting-services", "integrationHashes": {str(p.relative_to(HERE)): hashlib.sha256(p.read_bytes()).hexdigest()
                    for p in HERE.rglob("*") if p.is_file() and p.suffix in {".py", ".ts"}}}
    manifest["requiredServices"] = required_services(tasks)
    manifest["imageLockSha256"] = hashlib.sha256(args.image_lock.read_bytes()).hexdigest()
    manifest["taskImages"] = args.images
    if args.arm == "relate":
        image = checked(["docker", "image", "inspect", os.environ.get("AGENCY_EXECUTOR_IMAGE", "relate-agency:v2-14b8ca0"), "--format", "{{.Id}}"])
        os.environ["AGENCY_EXECUTOR_IMAGE"] = image
        manifest["executorImage"] = image
    save(output / "manifest.json", manifest)
    deadline = time.monotonic() + args.wait_services
    while True:
        checks = health(manifest["requiredServices"])
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
