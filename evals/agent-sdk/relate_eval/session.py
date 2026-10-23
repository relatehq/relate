"""One fresh trusted world and networkless code container per trial."""

import asyncio
import json
import os
import shutil
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PREPARED = ROOT / ".local/prepared"
OPERATIONS = {"get", "query", "traverse", "invoke", "getReceipt"}


class InfrastructureError(RuntimeError):
    pass


class CodeTimeout(RuntimeError):
    pass


class Session:
    def __init__(
        self,
        *,
        image="relate-agent-eval:local",
        cell_timeout=20,
        max_operations=400,
        max_cells=24,
    ):
        self.image = image
        self.cell_timeout = cell_timeout
        self.max_operations = max_operations
        self.max_cells = max_cells
        self.name = f"relate-eval-{uuid.uuid4().hex}"
        self.host = None
        self.worker = None
        self.calls = []
        self.cells = []
        self.submitted = False
        self.answer = None
        self.poisoned = False
        self.initialized = False
        self._lock = asyncio.Lock()
        self._host_lock = asyncio.Lock()
        self._host_pending = set()
        self._stderr_tasks = []
        self.stderr = []

    async def _drain(self, stream):
        while chunk := await stream.read(4096):
            # Retain bounded diagnostics, never inherit the host environment.
            self.stderr.append(chunk.decode(errors="replace"))
            self.stderr = self.stderr[-16:]

    async def _spawn(self, *args):
        proc = await asyncio.create_subprocess_exec(
            *args,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            limit=4 * 1024 * 1024,
            env={
                "PATH": os.environ["PATH"],
                **(
                    {"DOCKER_HOST": os.environ["DOCKER_HOST"]}
                    if "DOCKER_HOST" in os.environ
                    else {}
                ),
            },
        )
        self._stderr_tasks.append(asyncio.create_task(self._drain(proc.stderr)))
        return proc

    async def _send(self, proc, value):
        proc.stdin.write((json.dumps(value, separators=(",", ":")) + "\n").encode())
        await proc.stdin.drain()

    async def _read(self, proc):
        line = await proc.stdout.readline()
        if not line:
            raise InfrastructureError(
                "Environment process exited: " + "".join(self.stderr)[-2000:]
            )
        try:
            value = json.loads(line)
        except (ValueError, UnicodeDecodeError) as exc:
            raise InfrastructureError("Invalid environment protocol") from exc
        if not isinstance(value, dict):
            raise InfrastructureError("Environment message must be an object")
        return value

    async def host_request(self, value):
        async def exchange():
            async with self._host_lock:
                await self._send(self.host, value)
                return await self._read(self.host)

        pending = asyncio.create_task(exchange())
        self._host_pending.add(pending)
        pending.add_done_callback(self._host_pending.discard)
        # A cell timeout must not abandon a reply and desynchronize snapshot().
        return await asyncio.shield(pending)

    async def start(self, rows, role):
        if not (PREPARED / "manifest.json").is_file():
            raise InfrastructureError(
                "Run npm run prepare:sdk and build the Docker image first"
            )
        self.host = await self._spawn(shutil.which("node"), str(PREPARED / "world.mjs"))
        bootstrap = await asyncio.wait_for(
            self.host_request(dict(type="init", rows=rows, role=role)), 45
        )
        if not bootstrap["ok"]:
            raise InfrastructureError(json.dumps(bootstrap["error"]))
        self.initialized = True
        self.worker = await self._spawn(
            "docker",
            "run",
            "--rm",
            "--interactive",
            "--name",
            self.name,
            "--network=none",
            "--read-only",
            "--cap-drop=ALL",
            "--security-opt=no-new-privileges",
            "--pids-limit=64",
            "--memory=768m",
            "--cpus=1",
            "--tmpfs=/tmp:rw,noexec,nosuid,size=16m",
            self.image,
        )
        await self._send(self.worker, dict(type="init", bootstrap=bootstrap["result"]))
        ready = await asyncio.wait_for(self._read(self.worker), 30)
        if ready != {"type": "ready"}:
            raise InfrastructureError(f"Worker did not initialize: {ready}")
        return self

    async def execute(self, code):
        async with self._lock:
            if self.poisoned:
                raise CodeTimeout("This trial's code sandbox has already timed out")
            if len(self.cells) >= self.max_cells:
                return dict(
                    error="Cell budget exhausted", output="", budget_exhausted=True
                )
            cell = dict(code=code)
            self.cells.append(cell)
            try:
                async with asyncio.timeout(self.cell_timeout):
                    await self._send(self.worker, dict(type="execute", code=code))
                    while True:
                        message = await self._read(self.worker)
                        if message.get("type") == "operation":
                            method, args = message.get("method"), message.get("args")
                            if method not in OPERATIONS or not isinstance(args, list):
                                raise InfrastructureError(
                                    "Worker requested a non-public operation"
                                )
                            if len(self.calls) >= self.max_operations:
                                reply = dict(
                                    ok=False,
                                    error=dict(
                                        name="BudgetError",
                                        message="SDK operation budget exhausted",
                                        code="budget",
                                    ),
                                )
                            else:
                                reply = await self.host_request(
                                    dict(type="operation", method=method, args=args)
                                )
                                self.calls.append(
                                    dict(method=method, args=args, **reply)
                                )
                            await self._send(
                                self.worker,
                                dict(type="reply", id=message["id"], **reply),
                            )
                        elif message.get("type") == "result":
                            cell.update(message)
                            if "submitted" in message:
                                self.submitted, self.answer = True, message["submitted"]
                            return message
                        else:
                            raise InfrastructureError("Unexpected worker message")
            except TimeoutError as exc:
                self.poisoned = True
                cell.update(
                    error="CodeTimeout", output="Cell exceeded its execution deadline"
                )
                await self._stop_worker()
                raise CodeTimeout("Code exceeded its execution deadline") from exc

    async def snapshot(self):
        # Independent control channel; the untrusted worker cannot request this.
        response = await asyncio.wait_for(self.host_request(dict(type="snapshot")), 15)
        if not response["ok"]:
            raise InfrastructureError(json.dumps(response["error"]))
        return response["result"]

    async def _stop_worker(self):
        if self.worker:
            kill = await asyncio.create_subprocess_exec(
                "docker",
                "rm",
                "--force",
                self.name,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await asyncio.wait_for(kill.wait(), 15)
            if self.worker.returncode is None:
                self.worker.kill()
                await self.worker.wait()

    async def close(self):
        try:
            await self._stop_worker()
        finally:
            await self._close_host()

    async def _close_host(self):
        if self.host and self.host.returncode is None:
            self.host.kill()
            await self.host.wait()
        for task in self._host_pending:
            task.cancel()
        await asyncio.gather(*self._host_pending, return_exceptions=True)
        for task in self._stderr_tasks:
            task.cancel()
        await asyncio.gather(*self._stderr_tasks, return_exceptions=True)
