"""Relate actions over the original environment, with isolated code execution."""
import json
import os
from pathlib import Path
import selectors
import subprocess
import time
import uuid
import weakref



class RelateBridge:
    def __init__(self, tools, handlers):
        self.handlers = handlers
        self.records = []
        self.read_buffer = b""
        self.name = "agency-cl-executor-" + uuid.uuid4().hex
        source = Path(__file__).with_name("executor-bridge.ts")
        target = "/workspace/benchmarks/media-agency/src/external/continual-learning/executor-bridge.ts"
        image = os.environ["AGENCY_EXECUTOR_IMAGE"]
        self.process = subprocess.Popen([
            "docker", "run", "--rm", "-i", "--name", self.name,
            "--network", "none", "--read-only", "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges", "--pids-limit", "64", "--memory", "512m",
            "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
            "--mount", f"type=bind,src={source},dst={target},readonly",
            image, "node", "--import", "tsx", target,
        ], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
        try:
            self.instructions = self.call({"type": "init", "tools": tools})["instructions"]
        except BaseException:
            self.close()
            raise

    def call(self, message):
        self.process.stdin.write(json.dumps(message) + "\n")
        self.process.stdin.flush()
        deadline = time.monotonic() + 75
        with selectors.DefaultSelector() as selector:
            selector.register(self.process.stdout, selectors.EVENT_READ)
            while True:
                while b"\n" not in self.read_buffer:
                    if not selector.select(max(0, deadline - time.monotonic())):
                        raise TimeoutError("Relate executor exceeded 75 seconds")
                    chunk = os.read(self.process.stdout.fileno(), 65536)
                    if not chunk:
                        raise RuntimeError("Relate executor exited: " + self.process.stderr.read()[-4000:])
                    self.read_buffer += chunk
                line, self.read_buffer = self.read_buffer.split(b"\n", 1)
                reply = json.loads(line)
                if reply["type"] == "reply":
                    if "error" in reply:
                        raise RuntimeError(reply["error"])
                    return reply["value"]
                if reply["type"] != "invoke" or reply["name"] not in self.handlers:
                    raise ValueError("Executor requested an unavailable domain tool")
                value = self.handlers[reply["name"]](reply["arguments"])
                self.records.append({"name": reply["name"], "arguments": reply["arguments"], "result": value})
                self.process.stdin.write(json.dumps({"type": "result", "id": reply["id"], "value": value}) + "\n")
                self.process.stdin.flush()

    def close(self):
        if self.process.stdin and not self.process.stdin.closed:
            self.process.stdin.close()
        subprocess.run(["docker", "rm", "-f", self.name], capture_output=True, timeout=20)
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
