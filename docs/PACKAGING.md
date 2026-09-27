# Building the Windows executable and installer

The result is a single `Setup.exe` a parish can download and run. The installed
player needs no Python, no pip, no browser configuration and no internet
connection.

Everything below was run on Windows 11 with Python 3.11.9 and completed
successfully; the figures are from that build.

## What you need

| | |
|---|---|
| Python | 3.11 or 3.12, 64-bit, from python.org (the Microsoft Store build works too) |
| Inno Setup 6 | Only for the installer step. Free, from <https://jrsoftware.org/isdl.php> |
| Disk space | About 500 MB during the build |

Everything else is installed into a local virtual environment by the build
script.

## The short version

From the project root in PowerShell:

```powershell
.\build\build.ps1 -Clean -Installer
```

That creates the virtual environment, installs the pinned dependencies, refreshes
the instrument manifest, builds the executable, checks that the assets made it
into the bundle, launches it once to confirm it starts, and compiles the
installer.

Output:

- `dist\ParishMusicPlayer\ParishMusicPlayer.exe` — the application, 53.6 MB with all twelve instruments
- `Output\ParishMusicPlayer-Setup-2.0.0.exe` — the file to publish

## Step by step

If you would rather run the steps yourself, or the script fails partway.

**1. Create a virtual environment.**

```bash
py -3.11 -m venv .venv
```

**2. Install dependencies.**

```bash
.venv\Scripts\python.exe -m pip install -r requirements.txt
```

Installs pywebview 5.3.2, pythonnet 3.0.5 and PyInstaller 6.11.1, all pinned.

**3. Refresh the instrument manifest.**

```bash
.venv\Scripts\python.exe generate_manifest.py src\soundfonts
```

Writes `src/soundfonts/manifest.json` from whatever `.js` soundfonts are in the
folder. Run this after adding or removing an instrument.

**4. Build the executable.**

```bash
.venv\Scripts\python.exe -m PyInstaller build\parish_music_player.spec --noconfirm
```

**5. Check it runs.**

```bash
dist\ParishMusicPlayer\ParishMusicPlayer.exe --debug
```

The player window should open within a couple of seconds. If it does not, read
`%LOCALAPPDATA%\ParishMusicPlayer\player.log`.

**6. Build the installer.**

```bash
"C:\Program Files (x86)\Inno Setup 6\ISCC.exe" build\installer.iss
```

## What the spec bundles

`build/parish_music_player.spec` collects:

- everything under `src/` — the page, the JavaScript modules, the stylesheet, the
  logo and all twelve soundfonts — walked recursively, so an instrument added
  later is picked up without editing the spec
- pywebview's package data, including the Microsoft.Web.WebView2 interop
  assemblies; without these the window opens blank
- `webview.platforms.*`, `clr` and `generate_manifest` as hidden imports, since
  pywebview resolves its backend at runtime and is invisible to static analysis

It excludes tkinter, numpy, PIL, matplotlib, the Qt bindings and the test
modules, which keeps the build near 40 MB rather than several hundred.

Two deliberate choices:

**One folder, not one file.** A one-file build unpacks about 25 MB of soundfonts
to a temporary directory on every launch, delaying the window by several seconds
and leaving the directory behind if the PC is switched off at the wall, as church
PCs often are. The installer wraps the folder, so the parish still sees a single
Setup file. Set `ONEFILE = True` at the top of the spec to change this.

**UPX compression is off.** UPX-packed executables are a long-standing trigger
for antivirus heuristics. An unsigned player that a virus scanner quarantines is
worse than a larger download.

## What the installer does

- installs per user by default, so a volunteer without an administrator password
  can run it; the dialog offers a machine-wide install
- creates Start menu and optional desktop shortcuts
- registers a proper uninstaller
- removes `%LOCALAPPDATA%\ParishMusicPlayer`, which holds the saved settings and
  the WebView profile, on uninstall
- checks for the Edge WebView2 runtime and offers the Microsoft download link if
  it is missing

That last check matters. Windows 11 and current Windows 10 ship WebView2, but a
machine that has never been updated may not have it, and the player would
otherwise open a blank window with no explanation — discovered on a Sunday
morning.

## The SmartScreen warning

An unsigned executable downloaded from the internet shows "Windows protected your
PC". The user clicks **More info**, then **Run anyway**. This is normal for
unsigned software and is already described in the README.

The only real fix is an Authenticode code-signing certificate, roughly £200–400 a
year from a certificate authority. An OV certificate still accumulates
SmartScreen reputation over the first few hundred downloads; an EV certificate is
trusted immediately and costs more. For a free parish tool, documenting the
warning is the reasonable trade.

If you do sign, add this to the spec's `EXE()` call, or sign
`dist\ParishMusicPlayer\ParishMusicPlayer.exe` and the finished installer with
`signtool` before publishing.

## Troubleshooting the build

**The window opens blank.** WebView2 is missing, or pywebview's data files were
not collected. Confirm `WebView2Loader.dll` appears under
`dist\ParishMusicPlayer\_internal`.

**`ModuleNotFoundError: No module named 'clr'` at runtime.** pythonnet was not
bundled. Check it is installed in `.venv`, not only in the system Python.

**The player starts but shows "Instrument sounds not found".** The soundfonts
did not make it into the bundle. Check that `src\soundfonts` contains the `.js`
files and rebuild; the build script fails loudly on this.

**Antivirus quarantines the executable.** Confirm UPX is off, which it is by
default here, and submit the file to the vendor as a false positive. Signing
resolves it properly.

**The build succeeds but the executable exits immediately.** Read
`%LOCALAPPDATA%\ParishMusicPlayer\player.log`. The usual cause is `src/`
missing from the bundle, which the spec fails on at build time.
