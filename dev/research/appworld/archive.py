"""Package protected traces using AppWorld's own encrypted bundle format."""

import argparse
import shutil
import tempfile
from pathlib import Path
from appworld.common.constants import PASSWORD, SALT
from appworld.common.utils import pack_bundle, unpack_bundle

HERE = Path(__file__).resolve().parent
if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["pack", "unpack"])
    parser.add_argument("--bundle", default="evidence/trajectories.bundle")
    args = parser.parse_args()
    bundle = HERE / args.bundle
    bundle.parent.mkdir(parents=True, exist_ok=True)
    if args.action == "pack":
        # Upstream matches include_directories by substring. Stage only the
        # originals so a later pack cannot recursively include restored copies.
        with tempfile.TemporaryDirectory() as staging:
            shutil.copytree(
                HERE / ".local/runs",
                Path(staging) / "runs",
                ignore=shutil.ignore_patterns("__pycache__"),
            )
            pack_bundle(
                bundle_file_path=str(bundle),
                base_directory=staging,
                include_directories=["runs"],
                password=PASSWORD,
                salt=SALT,
            )
    else:
        unpack_bundle(
            bundle_file_path=str(bundle),
            base_directory=str(HERE / ".local/restored"),
            password=PASSWORD,
            salt=SALT,
        )
    print(bundle)
