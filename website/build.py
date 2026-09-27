"""
Assemble the public website into one folder.

    python website/build.py [output-dir]      (default: _site)

It is published at www.johnsav.co.uk/parishmusicplayer/, which is served from
the educational-tools repository, so a release is:

    python website/build.py ../educational-tools/parishmusicplayer

then commit and push that folder in educational-tools. Every link in the site
is relative, so it works under that path or at the root of any server.

The site is this folder, with the player itself copied from ``src`` into
``play/``, so the online player is always the same code as the installed one.
The instrument manifest is generated here, as app.py does at launch, because
it is not kept in the repository.
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT))

from generate_manifest import write_manifest  # noqa: E402

SKIP = {"build.py", "__pycache__"}


def build(out: Path) -> None:
    if out.exists():
        # Only ever replace an earlier build, never some other folder.
        if any(out.iterdir()) and not (out / "play" / "index.html").exists():
            raise SystemExit(f"{out} is not an earlier build of the site; not replacing it")
        shutil.rmtree(out)
    shutil.copytree(HERE, out, ignore=lambda d, names: [n for n in names if n in SKIP])
    shutil.copytree(ROOT / "src", out / "play",
                    ignore=shutil.ignore_patterns("manifest.json", "manifest.json.tmp"))
    instruments = write_manifest(out / "play" / "soundfonts")
    print(f"Site built in {out} with {len(instruments)} instrument(s)")


if __name__ == "__main__":
    build(Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "_site")
