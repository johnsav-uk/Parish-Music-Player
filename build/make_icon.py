"""
Build build/app.ico from the player's own logo.

    python build/make_icon.py

The executable, the Start menu entry, the desktop shortcut and the Setup file
all take their icon from this one file, so that what a volunteer clicks on the
desktop is the rose window they then see at the top of the player.

Windows picks a size from the icon depending on where it is drawing it: 16 for
the title bar, 32 for the taskbar, 48 for the desktop at normal scaling, and
256 for large icons and the Alt-Tab switcher. All of them are written, because
an icon missing the size Windows wants gets a stretched neighbour instead, and
that is exactly how a home-made application looks home-made.

Needs Pillow, which is not otherwise a dependency of this project:

    python -m pip install pillow

The result is committed, so this only has to run when the logo changes.
"""

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "src" / "logo.png"
TARGET = ROOT / "build" / "app.ico"

SIZES = [(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (24, 24), (16, 16)]


def main() -> int:
    logo = Image.open(SOURCE).convert("RGBA")
    if logo.width != logo.height:
        print(f"Warning: {SOURCE.name} is {logo.width}x{logo.height}, not square; "
              "Windows will letterbox it.")
    # Down to the largest icon size first, in one good-quality step, rather than
    # letting each size be reduced from the full-resolution original.
    Image.Image.save(logo.resize((256, 256), Image.LANCZOS), TARGET,
                     format="ICO", sizes=SIZES)
    print(f"Wrote {TARGET.relative_to(ROOT)} "
          f"({TARGET.stat().st_size / 1024:.0f} KB, {len(SIZES)} sizes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
