# Handoff: bug-checking 2.2.1 after a real service

A self-contained brief for a fresh session. It assumes no knowledge of the
conversations that led here.

## The job

Version 2.2.1 has been built but only lightly used. Somebody is about to run a
real service with it. This is the list of what changed, what is most likely to
be wrong, and how to reproduce anything they report.

The installer to give them:

    Output\ParishMusicPlayer-Setup-2.2.1.exe        40.9 MB

Run from source instead with `python app.py`, adding `--browser` to use the
default browser rather than the app window, and `--debug` for a log at
`%LOCALAPPDATA%\ParishMusicPlayer\player.log`.

## What changed since 2.1.0

2.1.0 is the only version anyone outside has. Everything below is new to them.

**Three pipe organ instruments** converted from a recording of the 1967
Hammarberg organ in Bureå, Sweden: Pipe Organ, Pipe Organ (Full) and Pipe Organ
(Flute). Real pipe recordings rather than the General MIDI set. See
[AUDIT.md](AUDIT.md), "A real pipe organ", and
[HANDOFF-organ-soundfont.md](HANDOFF-organ-soundfont.md) for how they were made.

**Three colour schemes**, White, Parchment and Blue, switched from Setup. White
is the default. Before this, eight of twenty-two pieces of text on the Player
tab were below the readable contrast minimum, and a PC set to light mode drew
near-black text on the navy ground.

**Three layouts**, Wide, Anchored and Tall, switched from Setup. Wide is the
default. Anchored pins the sound controls and one full-width Play button to the
bottom of the window so only the service list scrolls. One parishioner prefers
Wide and another Anchored, which is why both exist.

**Sound and MIDI instruments moved to the Player tab**, at the parish's request.

**The Levelling slider was removed.** The target is now fixed in `loudness.js`.
It could only make the balance worse; see AUDIT defect 34.

**Two bug fixes.** The instrument dropdown closed the instant it opened, and the
console sat on "Preparing instrument: 87 of 88" when it was ready to play. AUDIT
defects 32 and 33.

## Where the risk is

Ordered by how likely a real service is to hit it. None of these is a known
fault; they are the places where the testing was thin.

**The new organ has never been heard in a building.** It was compared against
the old one by rendering the same hymn through both and listening on a desktop.
A church with a PA and a stone acoustic is a different test. Listen for the
Trumpet in Pipe Organ (Full) being too aggressive, and for the bottom octave
speaking too slowly: real 16-foot pipes take about 300 milliseconds to come up
and that is faithfully reproduced, which can feel late under a congregation.

**Nine combinations, a handful tested.** Three layouts times three schemes. Wide
and Anchored were checked at 1320 by 800 in White. A parish PC at 1366 by 768,
or in Parchment, is untested ground. Anchored in particular has to fit fixed
furniture into the window: below 620 pixels of height it gives the page its
scrollbar back, and that threshold has not been tried on real hardware.

**The Player tab now holds controls that can spoil a service.** Church acoustic,
Acoustic size and Note release are one stray click away during Mass. This was
asked for deliberately and the concern was recorded, but if something sounds
wrong mid-service this is the first thing to check, before suspecting the
engine. The setting that was genuinely dangerous, Levelling, is gone.

**The dropdown fix narrowed a focus rule.** Controls used to hand focus back on
pointer-up so the spacebar and the clicker always work; that now applies to
sliders only. Dropdowns release focus on change instead, or when something else
is clicked. If anyone reports the spacebar or the clicker going dead after
touching a control, this is where to look: `_bindFocusGuards` in `controls.js`.

**A known and unchanged edge.** With a dropdown open, the spacebar still reaches
the transport and starts the music. It always did. It is more reachable now that
the list genuinely stays open.

## Reproducing anything they report

Run from source and drive it from the browser console. `window.parishPlayer`
exposes `{ player, settings, controls, ui, State }`.

```bash
python app.py --browser --port 8801
```

Loading files without the file dialog, which is what makes most of this
testable:

```javascript
const p = window.parishPlayer.player;
const mk = async (url, name, type) =>
  new File([await (await fetch(url)).arrayBuffer()], name, { type });
await p.loadFiles([await mk('hymn.mid', 'Test hymn.mid', 'audio/midi')]);
```

Copy the MIDI files somewhere under `src/` so the dev server will serve them,
and **delete the copies afterwards**: everything under `src/` is collected into
the build.

Real parish files that exposed most of the defects in AUDIT live in
`C:\Users\John\Desktop\Hymns 6th Easter` and
`C:\Users\John\Desktop\2nd Sunday Easter B`. They are Clavinova recordings full
of sustain pedal and Yamaha system-exclusive data. All eight parse correctly as
of 2.2.1.

What the state should look like once a track is armed:

```javascript
({ state: p.state,                                   // 'READY'
   pill: document.querySelector('.status-pill').textContent,   // 'Ready - press play'
   resident: p.soundfonts.resident,                  // at most two instruments
   notes: p.currentTrack.schedule.notes.length })
```

The Setup tab's Diagnostics panel shows the same figures live, which is usually
quicker than the console.

## Checking a report of "it sounds wrong"

The levels are measured, so this is answerable rather than a matter of opinion:

```javascript
p.tracks.map(t => ({ name: t.name,
                     measured: t.measured && +t.measured.rms.toFixed(4),
                     gain: +p.gainFor(t).toFixed(3),
                     levelled: t.measured && +(t.measured.rms * p.gainFor(t)).toFixed(4) }))
```

Every track should come out at 0.12. If one does not, it has hit either the
peak ceiling or the boost limit, both in `loudness.js`, and the reason will be
that it was mastered near full scale or is very quiet and noisy.

Contrast, if anyone says something is hard to read, was measured with a script
that walks every text node and composites the real background. It is not
committed; `docs/AUDIT.md` defect 30 records the method and the figures, and
rewriting it takes about twenty lines.

## Rebuilding

```powershell
.\build\build.ps1 -Clean -Installer
```

Inno Setup 6 is installed for the current user at
`%LOCALAPPDATA%\Programs\Inno Setup 6`; the build script looks there as well as
in Program Files. The version number lives in exactly two places,
`build\installer.iss` and `build\file_version_info.txt`, and both must match.

Bump the version for anything that leaves this machine. 2.1.0 is in the wild;
2.2.0 was built and never distributed, which is why 2.2.1 exists.

## Not fixed, and deliberately so

**The installer is not code-signed.** Windows shows SmartScreen, and a managed
machine may refuse it outright, which is what happened when it was sent to one
parishioner: "Windows cannot access the specified device, path or file". The
file was intact and Defender found nothing. Only a code signing certificate,
roughly 200 to 400 pounds a year, fixes this for everyone. Until then the
instructions are: right-click, Properties, tick Unblock; or check the
antivirus quarantine; or ask whoever administers the machine.

**No Mac version.** The code is close to portable, since the player is a web
app in a native window and pywebview has a macOS backend. The blockers are that
PyInstaller cannot cross-compile, so the build must happen on a Mac, and that
Gatekeeper blocks unsigned apps. Raised and parked.

**WebView2 on an un-updated Windows 10.** The window needs Microsoft's Edge
WebView2 runtime. Windows 11 and any maintained Windows 10 have it. The
installer offers a download link, which needs internet. Making it genuinely
offline means embedding Microsoft's standalone installer, about 130 MB.

## Orientation

```
src/index.html          two tabs: Player for the service, Setup for everything else
src/css/app.css         three colour schemes and three layouts, all as tokens
src/js/player.js        transport, state machine, fades, auto-advance, levelling
src/js/midi-parser.js   MIDI parsing, sustain pedal, tempo map
src/js/midi-engine.js   voicing, note scheduling, offline loudness measurement
src/js/soundfont.js     instrument loading, decoding, the two-instrument cache
src/js/controls.js      clicker, keyboard, focus guards
src/js/ui.js            rendering, the playlist, the instrument choosers
src/js/loudness.js      measurement, and the fixed levelling target
generate_manifest.py    builds soundfonts/manifest.json, holds instrument metadata
tools/                  the GrandOrgue converter; not part of the application
build/                  PyInstaller spec, build script, Inno Setup script, icon
docs/AUDIT.md           every defect found so far and how each was verified
docs/PACKAGING.md       building the executable and installer
```
