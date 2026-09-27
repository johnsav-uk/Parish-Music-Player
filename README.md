# Parish Music Player

A free, open-source music player for Catholic and Christian parish churches.
It plays standard audio files and MIDI files from one playlist, under one-button
control designed for a Bluetooth presentation clicker.

Free for all parishes.

## Features

- **Audio and MIDI together** — MP3, WAV, OGG and FLAC alongside MIDI in a single playlist
- **One-button control** — press to play, press twice or hold to fade out, Escape to stop
- **Clicker support** — arrow keys, Page Up and Page Down, and Bluetooth media buttons
- **Level matching** — recorded audio and MIDI are measured and levelled against each other, so nothing jumps out
- **Drag-and-drop playlist** — reorder tracks during a service
- **An instrument per track** — organ for the hymns, piano for Communion, chosen before the service from the playlist itself
- **A real pipe organ** — three registrations sampled from the 1967 Hammarberg organ in Bureå church, pipe by pipe
- **Softer pianos** — a Yamaha grand and a Kawai upright, taken from their gently played recordings for a warmer tone
- **Nineteen bundled instruments** — organ, piano, choir, strings, harp, flute, trumpet and bells
- **Tempo on the fly** — slow a MIDI hymn down, or speed it up, while it plays, without changing its pitch
- **Remembers each hymn** — its tempo and instrument come back the next time the file is loaded
- **A timeline** — elapsed and total time, and a bar to click to move to any point, or to cue a verse before pressing play
- **Organ-style sustain** — long notes ring on naturally, and can be switched off for piano
- **Three colour schemes and three layouts** — White, Parchment or Blue; Wide, Anchored or Tall
- **No subscriptions, no ads, no data collection**

## Installing

Windows 10 or 11.

1. Download the installer, `ParishMusicPlayer-Setup-<version>.exe`, from the
   [latest release](https://github.com/johnsav-uk/Parish-Music-Player/releases/latest).
2. Run it. Windows will show "Windows protected your PC" because the file is not
   signed with a commercial certificate. Click **More info**, then **Run anyway**.
3. Start the player from the Start menu.

If Windows says it "cannot access the specified device, path or file", the
download has been blocked rather than damaged: right-click the installer,
choose **Properties**, tick **Unblock** and click OK. On a managed machine, ask
whoever looks after it.

No Python, no browser setup and no internet connection are needed after
installation.

## Using it

The window has two tabs. **Player** is what you use during a service. **Setup**
holds everything else and should not need opening once the player is configured.

### Loading music

Click **+ Load audio / MIDI files**, or drag files onto the window. Hold Ctrl to
select several at once.

Files are sorted by name, so number them to set the order:

```
01 - Entrance Hymn.mp3
02 - Kyrie.mid
03 - Gloria.mp3
04 - Offertory.mp3
05 - Agnus Dei.mid
```

### Controls

| Action | Button | Keyboard | Clicker |
|---|---|---|---|
| Play the armed track | Press | Space, Right arrow, Enter | Forward |
| Fade out and stop | Press twice, or hold | Left arrow, F, or hold Space | Back |
| Stop immediately | — | Escape | — |

After a track ends, fades out or is stopped, the next one is queued
automatically and waits for your next press. A single press while music is
playing does nothing, so a clicker knocked by accident will not interrupt the
service.

### Choosing an instrument for each hymn

Every MIDI track in the playlist has its own instrument dropdown on the right of
its row. Set them before the service: Pipe Organ for the entrance hymn, Pipe
Organ (Full) for the recessional, Grand Piano or Harp for Communion, whatever
suits the music. The
choice is remembered per track, and the player prepares the next instrument
while the current track is still playing, so switching costs no delay.

Recorded audio files show an "audio" badge instead, as they carry their own
sound already.

Bluetooth headphone and clicker media buttons — play, pause, next, previous —
work as well, and are armed the first time you interact with the window.

### Settings

| Setting | What it does |
|---|---|
| Fade duration | How long a fade takes. Default 3 seconds |
| Hold threshold | How long to hold before a hold counts as a fade. Default 600 ms |
| Master volume | Overall loudness |
| Note release | How long MIDI notes ring on. Increase if notes sound clipped |
| Default instrument | Used for newly loaded MIDI files. Change any single track from the playlist |
| Sustain long notes | Holds notes past the end of the recording. Right for organ, turn off for piano |
| Ignore drum track | Skips MIDI channel 10, so drum parts are not played as organ notes |

Settings are saved and restored the next time you open the player.

## Appearance

The Setup tab has two switches. **Colour scheme** offers White, Parchment and
Blue; White is the default and the plainest to read, Blue is gentlest in a dark
church. **Layout** offers three:

| | |
|---|---|
| Wide | The service list beside the Play button. A whole service on one screen |
| Anchored | The same, with the sound controls and one full-width Play button fixed to the bottom of the window, so only the list ever scrolls |
| Tall | A single narrow column, for a small or portrait monitor |

Both wide layouts become the tall one by themselves on a narrow window, so any
of them is safe on any monitor. The choice is saved.

## The organ

Three of the instruments are one organ. Pipe Organ draws its Principal 8' and
Oktava 4', which is what most hymns want; Pipe Organ (Full) adds the upperwork,
the Mixtur and the Trumpet, for a last verse or a recessional; Pipe Organ
(Flute) is the single stopped flute, quiet enough to accompany Communion.

They are recordings of the 1967 Hammarberg organ in Bureå church, Sweden, made
by Lars Palo and prepared for GrandOrgue by Lars Palo and Graham Goode, used
under a Creative Commons Attribution-ShareAlike licence. See `LICENSE`.

## Adding more instruments

Download any soundfont from
<https://gleitz.github.io/midi-js-soundfonts/MusyngKite/> and save the `.js` file
into the `soundfonts` folder inside the installation directory. It appears in the
instrument list next time the player starts.

To convert a pipe organ sample set into an instrument, see `tools/README.md`.

## Troubleshooting

**The window is blank.** The Microsoft Edge WebView2 runtime is missing. The
installer offers to download it; you can also get it from
<https://go.microsoft.com/fwlink/p/?LinkId=2124703>.

**Levels are still uneven between tracks.** Every track is measured and brought
to the same level automatically, so this should be rare. The one case it cannot
fix is a recording already mastered at full volume: it cannot be raised any
further without distorting, so it may sit slightly below the rest. Use **Master
volume**, or the amplifier, if the whole service is too quiet or too loud.

**MIDI notes sound clipped, or too short.** Increase **Note release** on the
Setup tab.

**MIDI sounds muddy or smeared.** Decrease **Note release**. It controls how long
each note rings after it ends, and too much of it turns a busy hymn into a wash.

**A hymn recorded on a piano sounds wrong on the organ.** It should now be
handled automatically: organ, choir, strings and wind hold each note into the
next chord, the way an organist does, while piano, harp and bells follow the
recorded sustain pedal instead. If a particular file still suits one better than
the other, change that track's instrument from its row in the playlist.

**A MIDI piano sounds strange on long notes.** Turn off **Sustain long notes**.
It holds notes past the end of the recording, which suits an organ but not a
piano.

**The clicker does nothing.** Click the player window once so it has focus. Most
clickers send arrow keys or Page Up and Page Down, all of which are supported.
If yours sends something else, open **Setup**, find "Clicker and keyboard",
click **Learn** next to Play, and press the button on your clicker. It is mapped
and saved straight away.

**Something went wrong and you want to report it.** Open the **Diagnostics**
panel at the bottom of Settings, and attach
`%LOCALAPPDATA%\ParishMusicPlayer\player.log`.

## For developers

The player is a single-page web application. The MIDI parser, the sample-based
synthesiser, the mixer, the fades and the level matching are all plain JavaScript
running on the Web Audio engine — no frameworks and no build step for the
front end.

Python does two things only: it serves the files over the loopback interface,
which browsers require for ES modules, and it opens them in an embedded WebView2
window.

```
src/index.html        markup
src/css/app.css       styling
src/js/main.js        entry point and wiring
src/js/player.js      transport, state machine, fades, auto-advance
src/js/midi-parser.js standard MIDI file parsing
src/js/midi-engine.js MIDI voice scheduling and offline level measurement
src/js/soundfont.js   instrument loading and sample decoding
src/js/loudness.js    RMS and peak measurement, normalisation gain
src/js/controls.js    keyboard, clicker and media-button handling
src/js/ui.js          rendering
src/js/settings.js    saved preferences
app.py                local server and desktop window
generate_manifest.py  builds the instrument list from the soundfonts folder
```

To run from source:

```bash
python app.py
```

Add `--browser` to open in your default browser instead of the app window, and
`--debug` for verbose logging.

- [Code audit](docs/AUDIT.md) — defects found in the previous build, and how each was fixed
- [Packaging guide](docs/PACKAGING.md) — building the executable and installer
- [Organ soundfont handoff](docs/HANDOFF-organ-soundfont.md) — brief for replacing the bundled organ with a real pipe organ sample set

Pull requests are welcome.

## Licence

MIT. See [LICENSE](LICENSE).

Instrument sounds come from [gleitz/midi-js-soundfonts](https://github.com/gleitz/midi-js-soundfonts), also MIT.
