"""Public capability inventory, not task prompts or reference solutions.

A family is the task-ID prefix; the suffix selects a concrete instance.
Only train/dev metadata is inventoried. Helpers are not business domains.
"""

import json
from pathlib import Path

DOMAINS = {
    "amazon": "Shopping",
    "spotify": "Music",
    "venmo": "Payments",
    "gmail": "Email",
    "splitwise": "Shared expenses",
    "phone": "Phone and contacts",
    "file_system": "Files",
    "simple_note": "Notes",
    "todoist": "Task management",
}
BASELINE_FAMILIES = ("e7a10f8", "82e2fac", "d0b1f43", "afc0fce")
# Short capability descriptions, deliberately omitting benchmark instructions.
ADDITIONAL_FAMILIES = {
    "692c77d": "Rate songs using personal likes and library membership",
    "287e338": "Aggregate recommended songs by artist",
    "27e1026": "Compare release dates across personal music collections",
    "b7a9ee9": "Follow artists selected by playlist song genre",
    "ce359b5": "Remove songs from libraries and playlists by release date",
    "229360a": "Clean saved collections using likes and download state",
    "e3d6c94": "Create playlists from filtered recommendations",
    "ccb4494": "Like songs through the current queue position",
    "07b42fd": "Follow catalog artists by genre and follower count",
    "c901732": "Play songs selected from album or playlist statistics",
    "e85d92a": "Compare public song popularity for an artist",
    "aa8502b": "Follow or unfollow artists using personally liked songs",
    "50e1ac9": "Rank personal-library songs by genre and play count",
    "fac291d": "Count distinct songs across personal music collections",
    "4ec8de5": "Count saved songs and album songs by release period",
    "b119b1f": "Navigate the player queue to an artist",
    "d4e9306": "Follow artists associated with liked songs and albums",
    "3ab5b8b": "Download liked songs from a selected collection",
    "23cf851": "Aggregate transaction likes by direction and date",
    "57c3486": "Like catalog songs by followed artists",
    "6bdbc26": "Inspect followers of the current song artist",
    "6171bbc": "Build playlists from per-collection song rankings",
    "396c5a2": "Queue artist songs selected by public play count",
}


def task_ids(families):
    return [f"{family}_{i}" for family in families for i in (1, 2, 3)]


BASELINE_TASKS = task_ids(BASELINE_FAMILIES)
ADDITIONAL_TASKS = task_ids(ADDITIONAL_FAMILIES)
IMPLEMENTED_TASKS = BASELINE_TASKS + ADDITIONAL_TASKS


def inventory(root):
    families = {}
    for split in ("train", "dev"):
        for tid in (root / "datasets" / f"{split}.txt").read_text().splitlines():
            family = tid.split("_")[0]
            apps = sorted(
                json.loads(
                    (
                        root / "tasks" / tid / "ground_truth/required_apps.json"
                    ).read_text()
                )
            )
            item = families.setdefault(
                family,
                {
                    "family": family,
                    "split": split,
                    "required_apps": apps,
                    "instances": [],
                    "coverage": "baseline"
                    if family in BASELINE_FAMILIES
                    else "expanded"
                    if family in ADDITIONAL_FAMILIES
                    else "outside-current-scope",
                },
            )
            if item["required_apps"] != apps or item["split"] != split:
                raise ValueError(f"Family metadata differs between instances: {family}")
            item["instances"].append(tid)
            if family in ADDITIONAL_FAMILIES:
                item["capability"] = ADDITIONAL_FAMILIES[family]
    expected = {
        f
        for f, v in families.items()
        if set(v["required_apps"]) in ({"spotify"}, {"venmo"})
    } - set(BASELINE_FAMILIES)
    if expected != set(ADDITIONAL_FAMILIES):
        raise ValueError(
            "Expanded catalog no longer matches all additional single-app Spotify/Venmo families"
        )
    return {
        "data_version": (root / "version.txt").read_text().strip(),
        "splits": ["train", "dev"],
        "domains": DOMAINS,
        "families": sorted(families.values(), key=lambda x: (x["split"], x["family"])),
    }


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--root", type=Path, default=Path(__file__).parent / ".local/world/data"
    )
    args = parser.parse_args()
    print(json.dumps(inventory(args.root), indent=2))
