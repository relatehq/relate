"""Training-only deterministic integration probe, not an agent score."""

from pathlib import Path
from appworld import AppWorld
from appworld.common.path_store import path_store
from runner import Research, HERE, dumps

path_store.update_root(str(HERE / ".local/world"))
summary = []
with AppWorld(
    task_id="82e2fac_1", experiment_name="adapter-probe", load_ground_truth=False
) as world:
    creds = world.apis.supervisor.show_account_passwords()
    pw = next(c["password"] for c in creds if c["account_name"] == "spotify")
    token = world.apis.spotify.login(username=world.task.supervisor.email, password=pw)[
        "access_token"
    ]
    research = Research(world, "full")
    world.shell.user_ns["research"] = research
    world.shell.user_ns["probe_token"] = token
    print(world.execute("print(research('load', access_token=probe_token))"))
    for condition in ["flat", "full", "compact"]:
        research.condition = condition
        for select in [None, ["sourceId", "title", "likeCount"]]:
            response = research(
                "list", kind="Song", **({"select": select} if select else {})
            )
            summary.append(
                {
                    "condition": condition,
                    "select": select,
                    "bytes": len(dumps(response).encode()),
                    "records": len(response["result"]["data"]),
                    "snapshot_fetches": response["snapshot_fetches"],
                }
            )
    p = next(iter(research.rows["Playlist"]))
    response = research(
        "traverse", kind="Playlist", id=p["sourceId"], relation="memberships"
    )
    print("traversal rows", len(response["result"]["data"]))
    print(dumps(summary))
    print("acquisition", research.calls[0])
    Path(".local/probe-results.json").write_text(
        dumps({"rows": summary, "acquisition": research.calls[0]})
    )
    research.close()
