"""Local-only AppWorld interface experiment. Protected traces stay in .local/."""

import argparse
import hashlib
import json
import subprocess
import freezegun.api as real_clock
from pathlib import Path

import requests
from appworld import AppWorld, load_task_ids
from appworld.common.path_store import path_store
from acquire import payments

HERE = Path(__file__).resolve().parent
SCHEMA = {
    "type": "object",
    "properties": {"code": {"type": "string"}},
    "required": ["code"],
    "additionalProperties": False,
}
BASE = """You are an agent operating simulated apps to complete a user's task.
Return JSON with exactly one key, code, containing executable Python. No markdown.
Your Python runs in a persistent interpreter with `apis` available. Use print to inspect results.
Discover APIs with apis.api_docs.show_api_descriptions(app_name=...) and
apis.api_docs.show_api_doc(app_name=..., api_name=...). Read docs before guessing arguments.
Get credentials with apis.supervisor.show_account_passwords(); log in using the app's documented login API.
Always paginate collections until empty. Do not assume the first page is complete.
Use Python loops/comprehensions for bulk work. Only printed output is visible to you.
Complete via apis.supervisor.complete_task(answer=...) for a question; omit answer for an action task.
Do not access databases, files on the real machine, task solutions, or evaluation internals.
"""
SEMANTICS = """Relationship notes: a playlist contains many songs; a song can occur in multiple playlists.
Playlist membership is distinct from the user's song library. Song public popularity is not the user's personal liking.
Use source song IDs for original app action APIs. Deduplicate songs when combining playlists.
Phone contacts and Venmo transaction participants can be joined by exact email in this simulator.\nTransactions have distinct sender and receiver; filter direction and date before summing.\nDuration fields are in seconds. A collection page is not the complete collection.
"""
RESEARCH = """An experimental function research(op, **kwargs) is available in Python.
research('load', access_token=spotify_token) loads a snapshot of ALL playlist-library pages and their song details.
Call load before other operations. It returns an index and records acquisition API calls.
research('list', kind='Song'|'Playlist'|'Membership', select=['field',...]) reads the loaded objects.
research('get', kind=..., id=source_id, select=[...]) reads one object.
research('traverse', kind='Playlist', id=source_playlist_id, relation='memberships', select=[...]) reads memberships.
research('traverse', kind='Membership', id='playlist_id:song_id', relation='song'|'playlist', select=[...]) reads a target.
research('traverse', kind='Song', id=source_song_id, relation='memberships', select=[...]) reads memberships.
Song fields: sourceId,title,albumId,duration,genre,releaseDate,likeCount,playCount,artistsJson (JSON-encoded artist objects).
Playlist fields: sourceId,title. Membership fields: sourceId,playlist,song.
Outputs have a result key. A list result has data: [{id,data,meta?...},...]. A get has status,id,data.
IDs in results are graph IDs; sourceId is the original API ID (string). Inputs accept source or graph IDs.
select is optional. Use print(json.dumps(...)) or ordinary print; import json if needed.
The snapshot covers playlist membership only, not liked/downloaded status or other libraries.
After any source write the snapshot is invalid: reload before using research again.
Alternatively research('load', domain='payments', phone_token=..., venmo_token=...) loads all phone contacts and own Venmo transactions.
This replaces the previous snapshot. Payment kinds: Person(sourceId=email,name,relationshipsJson), Transaction(sourceId,sender,receiver,amount,description,createdAt,likeCount).
Person traversals: sentTransactions, receivedTransactions. Transaction traversals: sender, receiver.
relationshipsJson is a JSON string listing contact relationship labels (e.g. roommate); parse with json.loads.
Use the supervisor email to identify yourself. Transaction sourceId is the original integer ID as a string.
The payments scope excludes social feed, pending requests and contacts without email. It is not all Venmo activity.
All original APIs remain available; choose whichever interface helps.
"""


CLARIFICATION = """Exact response shapes:
load returns {"counts": {...}, "scope": "...", "complete": true} directly; it has no result or status key.
list/traverse return {"result": {"data": [{"id": canonical_id, "data": {...}}], "meta": {...}}, ...}.
get returns {"result": {"status": "ok", "id": canonical_id, "data": {...}}, ...}.
Do not interpret a missing wrapper/status key as an empty or failed load. Read the documented key.
Every reference field (Membership.playlist/song and Transaction.sender/receiver) contains a CANONICAL GRAPH ID, never a source ID or email.
Example identity lookup, using actual returned records:
people = research('list', kind='Person', select=['sourceId'])['result']['data']
email_by_id = {p['id']: p['data']['sourceId'] for p in people}
For a transaction record tx, email_by_id[tx['data']['receiver']] resolves its receiver email.
Alternatively compare reference IDs with Person records' top-level id. Pass returned opaque IDs directly; never construct a canonical ID from source IDs.
"""


def research_docs(condition, clarified=False):
    if condition not in ("flat", "full", "compact"):
        return ""
    docs = RESEARCH
    if clarified and condition == "flat":
        docs = "\n".join(
            line
            for line in docs.splitlines()
            if not line.startswith(("research('traverse'", "Person traversals:"))
        )
    if condition == "flat":
        docs += "\nBulk control: research traverse is NOT available. Use list/get and join records in Python.\n"
    if clarified:
        docs += CLARIFICATION
    return docs


def dumps(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str)


class Research:
    def __init__(self, world, condition):
        self.world, self.condition = world, condition
        self.process = (
            subprocess.Popen(
                ["node", str(HERE / "graph.mjs")],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            if condition in ("flat", "full", "compact")
            else None
        )
        self.calls = []
        self.write_count = 0
        self.rows = None

    def bridge(self, message):
        if self.process is None:
            raise RuntimeError("Graph subprocess must start outside the sandbox")
        self.process.stdin.write(dumps(message) + "\n")
        self.process.stdin.flush()
        line = self.process.stdout.readline()
        if not line:
            raise RuntimeError(self.process.stderr.read()[:2000])
        response = json.loads(line)
        if "error" in response:
            raise RuntimeError(response["error"])
        return response

    def writes(self):
        return sum(
            r["method"] not in ("get", "head")
            for r in self.world.requester.request_tracker.requests
        )

    def __call__(self, op, **kwargs):
        started = real_clock.real_perf_counter()
        before = len(self.world.requester.request_tracker.requests)
        result = None
        try:
            if op == "load":
                self.rows = None
                domain = kwargs.get("domain", "music")
                if domain == "payments":
                    loaded_rows = payments(
                        self.world.apis, kwargs["phone_token"], kwargs["venmo_token"]
                    )
                elif domain == "music":
                    token = kwargs["access_token"]
                    playlists = []
                    for page in range(100):
                        rows = self.world.apis.spotify.show_playlist_library(
                            access_token=token, page_index=page, page_limit=20
                        )
                        if not isinstance(rows, list):
                            raise ValueError("Playlist API did not return a collection")
                        playlists.extend(rows)
                        if not rows:
                            break
                    else:
                        raise ValueError(
                            "Collection acquisition cap reached; no complete snapshot"
                        )
                    song_ids = sorted({sid for p in playlists for sid in p["song_ids"]})
                    songs = [
                        self.world.apis.spotify.show_song(song_id=sid)
                        for sid in song_ids
                    ]
                    loaded_rows = {
                        "Playlist": [
                            {"sourceId": str(p["playlist_id"]), "title": p["title"]}
                            for p in playlists
                        ],
                        "Song": [
                            {
                                "sourceId": str(s["song_id"]),
                                "title": s["title"],
                                "albumId": str(s["album_id"]),
                                "duration": s["duration"],
                                "genre": s["genre"],
                                "releaseDate": s["release_date"],
                                "likeCount": s["like_count"],
                                "playCount": s["play_count"],
                                "artistsJson": dumps(s["artists"]),
                            }
                            for s in songs
                        ],
                        "Membership": [
                            {
                                "sourceId": f"{p['playlist_id']}:{sid}",
                                "playlist": str(p["playlist_id"]),
                                "song": str(sid),
                            }
                            for p in playlists
                            for sid in p["song_ids"]
                        ],
                    }
                else:
                    raise ValueError("Unknown domain")
                # Build the same IDs and index for both bulk and graph conditions.
                self.bridge({"op": "load", "rows": loaded_rows})
                self.rows = loaded_rows
                self.write_count = self.writes()
                result = {
                    "counts": {k: len(v) for k, v in self.rows.items()},
                    "scope": "all playlist-library pages and member song details"
                    if domain == "music"
                    else "all phone contacts with email and all own Venmo transactions; excludes social feed and payment requests",
                    "complete": True,
                }
            else:
                if self.rows is None:
                    raise ValueError("Call research('load', access_token=...) first")
                if self.writes() != self.write_count:
                    raise ValueError("Snapshot invalidated by source write; reload")
                result = self.bridge({"op": op, "condition": self.condition, **kwargs})
            return result
        finally:
            self.calls.append(
                {
                    "op": op,
                    "source_calls": len(self.world.requester.request_tracker.requests)
                    - before,
                    "seconds": real_clock.real_perf_counter() - started,
                    "response_bytes": len(dumps(result).encode())
                    if result is not None
                    else None,
                    "kind": kwargs.get("kind"),
                    "select": kwargs.get("select"),
                }
            )

    def close(self):
        if self.process:
            self.process.stdin.close()
            self.process.wait(timeout=10)


def run(args, task_id, condition, seed):
    out = HERE / ".local" / "runs" / args.run / f"{task_id}__{condition}__{seed}"
    out.mkdir(parents=True, exist_ok=False)
    name = f"{args.run}-{condition}-{seed}"
    messages = [
        {
            "role": "system",
            "content": BASE
            + (SEMANTICS if condition != "raw" else "")
            + research_docs(condition, args.clarify_interface),
        }
    ]
    steps, error = [], None
    termination = "step-budget"
    total_prompt = total_generated = host_poll_calls = 0
    setup_calls = 0
    start = real_clock.real_perf_counter()
    with AppWorld(
        task_id=task_id,
        experiment_name=name,
        random_seed=100,
        timeout_seconds=60,
        load_ground_truth=False,
    ) as world:
        if args.bootstrap:
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
            world.shell.user_ns["tokens"] = tokens
            setup_calls = len(world.requester.request_tracker.requests)
            messages[0]["content"] += (
                "\nAll three apps are already authenticated equally by the host. The Python variable tokens contains tokens['spotify'], tokens['phone'], tokens['venmo']. Pass the appropriate access_token=tokens[app] to original APIs and use these tokens with research load. Do not log in again. apis is already initialized: never import apis. Work with real API data; never invent example records.\n"
            )
        research = Research(world, condition)
        if condition in ("flat", "full", "compact"):
            world.shell.user_ns["research"] = research
        messages.append(
            {
                "role": "user",
                "content": dumps(
                    {
                        "task": world.task.instruction,
                        "supervisor": dict(world.task.supervisor),
                        "date": str(world.task.datetime),
                    }
                ),
            }
        )
        try:
            for step in range(args.steps):
                response = requests.post(
                    "http://localhost:11434/api/chat",
                    json={
                        "model": args.model,
                        "messages": messages,
                        "format": SCHEMA,
                        "think": {"false": False, "true": True}.get(
                            args.think, args.think
                        ),
                        "stream": False,
                        "keep_alive": "30m",
                        "options": {
                            "num_ctx": args.context,
                            "num_predict": 1000,
                            "temperature": 0.2,
                            "seed": seed,
                        },
                    },
                    timeout=240,
                )
                response.raise_for_status()
                generation = response.json()
                content = generation["message"]["content"]
                total_prompt += generation.get("prompt_eval_count", 0)
                total_generated += generation.get("eval_count", 0)
                messages.append({"role": "assistant", "content": content})
                try:
                    code = json.loads(content)["code"]
                    output = world.execute(code)
                except (ValueError, KeyError, TypeError) as exc:
                    output = f"Invalid response: {exc}"
                # Identical explicit output cap; preserve full output in the private trace.
                visible = output[: args.output_chars]
                if len(output) > args.output_chars:
                    visible += "\n[OUTPUT TRUNCATED: request fewer fields/records or compute a summary in Python]"
                messages.append(
                    {
                        "role": "user",
                        "content": visible or "Execution produced no printed output.",
                    }
                )
                steps.append(
                    {
                        "step": step,
                        "generation": generation,
                        "output": output,
                        "visible_chars": len(visible),
                    }
                )
                (out / "trace.json").write_text(
                    dumps({"messages": messages, "steps": steps})
                )
                print(
                    dumps(
                        {
                            "task": task_id,
                            "condition": condition,
                            "seed": seed,
                            "step": step,
                            "generated": generation.get("eval_count"),
                            "output_chars": len(output),
                        }
                    ),
                    flush=True,
                )
                calls_before_poll = len(world.requester.request_tracker.requests)
                is_complete = world.task_completed()
                host_poll_calls += (
                    len(world.requester.request_tracker.requests) - calls_before_poll
                )
                if is_complete:
                    termination = "completed"
                    break
                if (
                    len(steps) >= 3
                    and len(
                        {
                            (s["generation"]["message"]["content"], s["output"])
                            for s in steps[-3:]
                        }
                    )
                    == 1
                ):
                    termination = "repeated-action"
                    break
                if total_generated >= args.generated_budget:
                    break
        except Exception as exc:
            error = f"{type(exc).__name__}: {exc}"
            termination = "infrastructure-error"
        finally:
            research.close()
        source_calls = len(world.requester.request_tracker.requests) - host_poll_calls
        completed = world.task_completed()
        (out / "api_calls.json").write_text(
            dumps(world.requester.request_tracker.requests)
        )
        world.save_state()
    # Evaluator is outside the agent's world; no feedback is returned to the agent.
    from appworld.evaluator import evaluate_task

    evaluation = evaluate_task(task_id=task_id, experiment_name=name)
    report = evaluation.to_dict()
    (out / "evaluation.json").write_text(dumps(report))
    result = {
        "task_id": task_id,
        "condition": condition,
        "seed": seed,
        "model": args.model,
        "success": evaluation.success if error is None else None,
        "termination": termination,
        "completed": completed,
        "steps": len(steps),
        "prompt_tokens": total_prompt,
        "generated_tokens": total_generated,
        "source_calls": source_calls,
        "setup_calls": setup_calls,
        "agent_source_calls": source_calls - setup_calls,
        "host_poll_calls": host_poll_calls,
        "output_chars": sum(len(s["output"]) for s in steps),
        "research_calls": research.calls,
        "seconds": real_clock.real_perf_counter() - start,
        "error": error,
    }
    (out / "result.json").write_text(dumps(result))
    print(dumps(result), flush=True)
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="qwen3.6:27b")
    parser.add_argument(
        "--clarify-interface",
        action="store_true",
        help="Exploratory prompt-only clarification of response envelopes and reference IDs",
    )
    parser.add_argument(
        "--bootstrap",
        action="store_true",
        help="Give every condition the same host-authenticated app tokens",
    )
    parser.add_argument(
        "--think", choices=["false", "true", "low", "medium", "high"], default="false"
    )
    parser.add_argument("--tasks", nargs="+", required=True)
    parser.add_argument(
        "--conditions",
        nargs="+",
        choices=["raw", "static", "flat", "full", "compact"],
        default=["raw"],
    )
    parser.add_argument("--seeds", nargs="+", type=int, default=[11])
    parser.add_argument("--run", required=True)
    parser.add_argument("--steps", type=int, default=18)
    parser.add_argument("--context", type=int, default=24576)
    parser.add_argument("--output-chars", type=int, default=14000)
    parser.add_argument("--generated-budget", type=int, default=14000)
    args = parser.parse_args()
    path_store.update_root(str(HERE / ".local" / "world"))
    allowed = set(load_task_ids("train") + load_task_ids("dev"))
    if not set(args.tasks) <= allowed:
        parser.error("Only train/dev tasks are permitted by this research runner")
    root = HERE / ".local" / "runs" / args.run
    root.mkdir(parents=True, exist_ok=True)
    config = vars(args) | {
        "source_sha256": {
            p.name: hashlib.sha256(p.read_bytes()).hexdigest()
            for p in [Path(__file__), HERE / "graph.mjs", HERE / "acquire.py"]
        },
        "ollama": requests.get("http://localhost:11434/api/version", timeout=10).json(),
    }
    if (root / "config.json").exists():
        parser.error("Run name already exists; use a new immutable run name")
    (root / "config.json").write_text(dumps(config))
    (root / "source").mkdir()
    for source_path in [Path(__file__), HERE / "graph.mjs", HERE / "acquire.py"]:
        (root / "source" / source_path.name).write_bytes(source_path.read_bytes())
    for task_id in args.tasks:
        for seed in args.seeds:
            # Counterbalance condition order by task/seed, without concurrent GPU runs.
            conditions = args.conditions[:]
            offset = (args.tasks.index(task_id) + args.seeds.index(seed)) % len(
                conditions
            )
            conditions = conditions[offset:] + conditions[:offset]
            for condition in conditions:
                run(args, task_id, condition, seed)


if __name__ == "__main__":
    main()
