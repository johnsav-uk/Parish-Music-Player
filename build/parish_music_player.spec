# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec for Parish Music Player.

Build from the project root:

    pyinstaller build/parish_music_player.spec --noconfirm

Produces dist/ParishMusicPlayer/ParishMusicPlayer.exe, a one-folder build that
runs on a clean Windows machine with no Python, no pip and no separate browser
install.

Why one folder rather than one file
-----------------------------------
A one-file build unpacks roughly 25 MB of soundfonts into a temporary directory
on every launch, which adds several seconds of delay before the window appears
and leaves the folder behind if the machine is switched off at the wall, as
church PCs often are. The one-folder build starts immediately. The Inno Setup
installer in this directory wraps the folder so the volunteer still sees a
single Setup file and a Start menu entry.

To build one file anyway, set ONEFILE below to True.
"""

import os
import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

ONEFILE = False

# SPECPATH is set by PyInstaller to the directory holding this spec file.
PROJECT_ROOT = Path(SPECPATH).parent          # noqa: F821 - injected by PyInstaller
SRC = PROJECT_ROOT / "src"

if not (SRC / "index.html").is_file():
    raise SystemExit(f"Cannot find the player files at {SRC}. Run from the project root.")

# ---------------------------------------------------------------------------
# Data files
#
# Everything under src/ is the application: the page, its modules, the stylesheet,
# the logo and the soundfonts. Collect it wholesale so a soundfont added later is
# picked up without editing this file.
# ---------------------------------------------------------------------------
datas = []
for path in SRC.rglob("*"):
    if not path.is_file():
        continue
    if path.suffix in {".map", ".tmp"} or path.name.startswith("."):
        continue
    # (source on disk, destination directory inside the bundle)
    datas.append((str(path), str(Path("src") / path.parent.relative_to(SRC))))

# pywebview ships the Microsoft.Web.WebView2 interop assemblies and its own
# JavaScript shims as package data. Without these the window opens blank.
datas += collect_data_files("webview")

hiddenimports = [
    "generate_manifest",
]
# pywebview resolves its platform backend at runtime, so the Windows modules are
# invisible to PyInstaller's static analysis.
hiddenimports += collect_submodules("webview.platforms")
hiddenimports += [
    "clr",                 # pythonnet, used by the EdgeChromium backend
    "webview.platforms.winforms",
    "webview.platforms.edgechromium",
]

# Nothing here needs a GUI toolkit, a plotting stack or a test runner. Excluding
# them keeps the build near 40 MB instead of several hundred.
excludes = [
    "tkinter", "unittest", "pydoc", "doctest", "test", "lib2to3",
    "numpy", "PIL", "matplotlib", "PySide2", "PySide6", "PyQt5", "PyQt6",
    "email.test", "distutils",
]

block_cipher = None

a = Analysis(
    [str(PROJECT_ROOT / "app.py")],
    pathex=[str(PROJECT_ROOT)],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=excludes,
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

ICON = PROJECT_ROOT / "build" / "app.ico"
icon_arg = str(ICON) if ICON.is_file() else None

VERSION_FILE = PROJECT_ROOT / "build" / "file_version_info.txt"
version_arg = str(VERSION_FILE) if VERSION_FILE.is_file() else None

if ONEFILE:
    exe = EXE(
        pyz,
        a.scripts,
        a.binaries,
        a.zipfiles,
        a.datas,
        [],
        name="ParishMusicPlayer",
        debug=False,
        bootloader_ignore_signals=False,
        strip=False,
        upx=False,                 # UPX-packed executables trip antivirus heuristics
        runtime_tmpdir=None,
        console=False,             # no black terminal window behind the player
        disable_windowed_traceback=False,
        icon=icon_arg,
        version=version_arg,
    )
else:
    exe = EXE(
        pyz,
        a.scripts,
        [],
        exclude_binaries=True,
        name="ParishMusicPlayer",
        debug=False,
        bootloader_ignore_signals=False,
        strip=False,
        upx=False,
        console=False,
        disable_windowed_traceback=False,
        icon=icon_arg,
        version=version_arg,
    )

    coll = COLLECT(
        exe,
        a.binaries,
        a.zipfiles,
        a.datas,
        strip=False,
        upx=False,
        upx_exclude=[],
        name="ParishMusicPlayer",
    )
