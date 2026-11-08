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

# Added at build time, and only to the published pages. The player in ``src`` is
# also what gets installed on church computers, which must not call out to
# anything.
ANALYTICS = (
    "<!-- Cloudflare Web Analytics --><script type='module' "
    "src='https://static.cloudflareinsights.com/beacon.min.js' "
    "data-cf-beacon='{\"token\": \"597d8741dde04f27b28c5b19376b6013\"}'></script>"
    "<!-- End Cloudflare Web Analytics -->"
)


def add_analytics(page: Path) -> None:
    with page.open(encoding="utf-8", newline="") as f:
        html = f.read()
    if html.count("</body>") != 1:
        raise SystemExit(f"{page} needs exactly one </body> for the analytics tag")
    newline = "\r\n" if "\r\n" in html else "\n"
    with page.open("w", encoding="utf-8", newline="") as f:
        f.write(html.replace("</body>", ANALYTICS + newline + "</body>"))


def build(out: Path) -> None:
    if out.exists():
        # Only ever replace an earlier build, never some other folder.
        if any(out.iterdir()) and not (out / "play" / "index.html").exists():
            raise SystemExit(f"{out} is not an earlier build of the site; not replacing it")
        shutil.rmtree(out)
    shutil.copytree(HERE, out, ignore=lambda d, names: [n for n in names if n in SKIP])
    shutil.copytree(ROOT / "src", out / "play",
                    ignore=shutil.ignore_patterns("manifest.json", "manifest.json.tmp"))
    for page in out.rglob("*.html"):
        add_analytics(page)
    instruments = write_manifest(out / "play" / "soundfonts")
    print(f"Site built in {out} with {len(instruments)} instrument(s)")


if __name__ == "__main__":
    build(Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "_site")
