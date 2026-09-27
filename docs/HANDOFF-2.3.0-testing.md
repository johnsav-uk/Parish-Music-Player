# Handoff: bug-checking 2.3.0

A self-contained brief for a fresh session. It follows
[HANDOFF-2.2.1-testing.md](HANDOFF-2.2.1-testing.md), whose advice on
reproducing reports from the browser console still applies.

The installer:

    Output\ParishMusicPlayer-Setup-2.3.0.exe        47.9 MB

2.2.1 was never distributed widely; 2.1.0 is the version in the wild. The
2.2.1 installer is kept beside this one.

## 2.3.1

One fix, to the playlist. After dragging a track to a new position, clicking a
track selected nothing until something else reset it. Clicks were ignored from
the drop until `dragend` switched them back on, but the move rebuilds the list,
so the row the drag began on had left the page and its `dragend` never reached
the list. The pause after a drop now expires by itself (`ignoreClicksUntil` in
`ui.js`), and only the ↕ handle starts a drag, so a click with an ordinary
hand's worth of movement is no longer read as the start of one. The bug
predates 2.3.0.

## What changed since 2.2.1

**Settings now survive a restart.** They never did. localStorage belongs to an
origin, the origin includes the port, and `app.py` takes a new port on every
launch, so each start was a new site with empty storage. Settings now live in
`%LOCALAPPDATA%\ParishMusicPlayer\settings.json`, read and written through
`GET` and `PUT /settings` on the launcher's own server (`QuietHandler` in
`app.py`). Writes need an `X-Parish-Player: 1` header, which a page on another
origin cannot send without a preflight the server never grants. localStorage is
kept as a copy, and as the fallback when the page is served by anything else.

**Timeline.** Elapsed and total time under Now Playing, and a bar to click or
drag. While playing it jumps; while armed it sets a starting point for the next
press ("Starts at 1:08"), cleared once that playing ends. `Player.seek`,
`MidiPlayer._resumeHeldNotes` for chords already sounding at the jump.

**Tempo, MIDI only.** 70 to 130 per cent, one per cent a step, press and hold to
repeat. In Now Playing it changes the hymn as it plays (`MidiPlayer.setRate`:
voices already sounding finish, those scheduled ahead are cancelled and
rescheduled from the current place). On each playlist row it is set
beforehand; clicking the figure resets to 100. Positions everywhere are in the
file's own seconds; the timer divides by the rate to show real time.

**Per-hymn memory.** Tempo and instrument, keyed by file name without extension
or case, in `settings.hymns`. Only values somebody changed are stored. A hymn
with a remembered instrument is marked `instrumentChosen` and no longer follows
the default. A live tempo change is remembered too, deliberately: if the
congregation needed 95 per cent once, it will next week.

**Four new instruments**, converted by the new `tools/build_sf2.py`:
Soft Grand Piano (Salamander, CC BY), Upright Piano (Kawai, CC0), Yamaha Grand
Piano (YDP, CC BY) and Magnificent Gothic. The pianos use soft velocity layers,
which is what makes them warmer rather than quieter; measured, the soft grand
and the upright carry about 40 per cent less spectral brightness than the
General MIDI piano. Credits are in `LICENSE`.

**Magnificent Gothic is of unknown licence**, and ships anyway at the owner's
decision. It is `Maggoth2.sf2`, the only instrument in the soundfont the
parish's VLC was set to, so VLC was playing every Clavinova piano file on this
organ. That is why VLC sounded softer: it was not a piano at all.

**Anchored layout at 1366 by 768.** It was already 33 pixels too tall there,
cutting off the Play button; the MIDI card now scrolls within itself instead.

**MIDI engine leak.** `sources` was meant to be pruned of finished voices but
nothing marked them finished, so it grew for the whole of every hymn.

## Where the risk is

**Tempo is the first live control that is remembered.** A stray click during
Mass changes next week's starting tempo as well. The changed figure turns gold.

**The timeline is clickable.** A stray click moves the music, as in VLC.

**One unexplained observation.** Once, in testing, a first click on the bar
appeared to start the hymn from 0:00 instead of cueing it. Three attempts to
reproduce it, one replaying the same steps with every event logged, found only
correct behaviour. Worth trying on the parish PC.

**Settings from 2.1.0 are not carried over**, because 2.1.0 never actually kept
any.

**Running from source with the Microsoft Store Python** writes the settings to a
redirected copy of LOCALAPPDATA,
`%LOCALAPPDATA%\Packages\PythonSoftwareFoundation.Python.3.11_...\LocalCache\Local\ParishMusicPlayer`,
not the one the installed app uses.

## Checking a tempo report

```javascript
const p = window.parishPlayer.player;
({ tempo: p.currentTrack.tempo, rate: p.midi && p.midi.rate,
   position: p.position, late: p.midi && p.midi.lateCount,
   remembered: p.settings.hymns })
```

`position` should advance by `rate` file-seconds per real second. `late` counts
notes skipped for being scheduled in the past, and should stay 0 across a tempo
change.

## Building

As before, but note that `-Clean` deletes `Output\`, including earlier
installers. To keep them, remove `dist\` and `build\ParishMusicPlayer\` by
hand and run without it. Under Windows PowerShell 5.1, run the script in its own
process, or PyInstaller's progress on stderr is raised as an error:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\build\build.ps1 -Installer
```
