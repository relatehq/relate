"""Start the pinned upstream workplace after checking local name/port conflicts."""
import argparse
import json
from pathlib import Path
import socket
import subprocess

IMAGE = "ghcr.io/theagentcompany/servers-api-server@sha256:fc162044d7062323c1fc5699569b1483e134accdc9c12af6816f991a040c9b5c"
# Upstream uses these fixed names and resets its own compose projects at startup.
NAMES = {"agency-bench-api", "gitlab", "owncloud", "owncloud-collabora", "rocketchat", "mongodb", "redis-stack"}
PORTS = [2999, 3000, 6379, 8091, 8092, 8929, 8930, 2424, 9980]


def docker(*args):
    return subprocess.check_output(["docker", *args], text=True).strip()


def preflight():
    containers = [json.loads(line) for line in docker("ps", "-a", "--format", "{{json .}}").splitlines() if line]
    collisions = [c["Names"] for c in containers if c["Names"] in NAMES or "plane-app" in c["Names"]]
    for port in PORTS:
        with socket.socket() as sock:
            sock.settimeout(.2)
            if sock.connect_ex(("127.0.0.1", port)) == 0:
                collisions.append(f"port:{port}")
    volumes = docker("volume", "ls", "--format", "{{.Name}}").splitlines()
    collisions.extend(v for v in volumes if "plane-app" in v or "theagentcompany" in v)
    if collisions:
        raise RuntimeError(f"Existing resources must not be reset: {collisions}")
    return containers


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    before = preflight()
    args.output.mkdir(parents=True, exist_ok=False)
    manifest = {"image": IMAGE, "platform": "linux/amd64", "before": before, "status": "starting"}
    path = args.output / "services.json"
    path.write_text(json.dumps(manifest, indent=2))
    upstream = Path(__file__).resolve().parents[3] / "artifacts/upstream/agent-company"
    compose = upstream / "servers/api-server/docker-compose.yml"
    container = docker("run", "-d", "--name", "agency-bench-api", "--platform", "linux/amd64",
                       "--network", "host", "--env", "DOCKER_DEFAULT_PLATFORM=linux/amd64",
                       "--env", "GITLAB_PORT=8929",
                       "--volume", f"{compose}:/workspace/docker-compose.yml:ro",
                       "--volume", "/var/run/docker.sock:/var/run/docker.sock", IMAGE)
    manifest.update(container=container, status="started-health-unverified")
    path.write_text(json.dumps(manifest, indent=2))
    print(container)
