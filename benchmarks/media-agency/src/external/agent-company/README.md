# TheAgentCompany integration (in progress)

This directory owns the agency benchmark's integration with the original
TheAgentCompany workplace. Infrastructure bootstrap is implemented; the agent
runner, Relate interface, original evaluator invocation, and measured comparison
remain pending. No task scores have been produced yet.

Upstream source: `TheAgentCompany/TheAgentCompany@98b68ef82a47690c316f42fddb05baafaab56851`.
Controller image is pinned by digest in `services.py`. The source's compose file
is mounted over the older copy in the image, because the source uses
`bitnamilegacy/mongodb` while the published image still references `bitnami/mongodb`.
The first failed startup and its original compose file are retained under artifacts.

```sh
python3 benchmarks/media-agency/src/external/agent-company/services.py \
  --output benchmarks/media-agency/artifacts/agent-company/services-002
```

The launcher checks fixed upstream container names, compose volumes, and service
ports before starting. It refuses to reset existing matching resources. It records
all pre-existing containers and the new controller ID. The upstream controller
needs Docker socket access to launch its workplace services; it runs with amd64
emulation on this machine. A started controller does not mean the services are
healthy. Inspect `/api/healthcheck/{gitlab,owncloud,rocketchat,plane}` on port 2999
before launching tasks.

Cleanup must be limited to resources created by this benchmark. Never run global
Docker prune or stop unrelated containers. The retained before-state inventory is
the ownership boundary; teardown and health automation still need implementation.
