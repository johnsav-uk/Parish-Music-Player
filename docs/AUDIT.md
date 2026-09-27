# Code audit — Parish Music Player

Audit of the shipped build (`parish-music-player-dist.zip`, `index.html`, 1,141 lines)
against the refactor in `src/`.

Every defect below was reproduced by running the original in a browser and
driving it from the console, not inferred from reading. Each one has a
corresponding check against the refactor, listed in
[Verification](#verification).

## Scope correction

The brief asks for FluidSynth or pygame configuration, `.sf2` SoundFont
management, MIDI velocity scaling in Python, and a PyInstaller build of a Python
audio application.

None of that applies. There is no Python audio code in this project. The player
is a single-page web application: the MIDI parser, the sample-based synthesiser,
the mixer, the fades and the normalisation are all JavaScript running on the Web
Audio engine. Python appears once, as `python -m http.server`, to serve five
static files. The instrument sounds are not `.sf2` SoundFonts but MIDI.js
JavaScript files holding base64-encoded MP3 samples.

So the work landed where the behaviour actually lives — in the JavaScript — and
the packaging problem was solved for what this application really is. That turns
out to be better for the parish anyway, as explained under
[Packaging](#packaging-what-changed-and-why).

## Defects found

### 1. A single press during playback restarted the hymn

`endHold` called `doPlay()` on any short press, and `doPlay` called `playTrack`,
which stopped the current source and started it again from zero.

Measured: playing at 1.50 s into the track, one short press, position afterwards
0.30 s. The entrance hymn returns to bar one.

This is the most serious defect in the build. The player's entire purpose is
unattended operation by someone holding a clicker who is not looking at the
screen, and a clicker knocked in a pocket is exactly the expected input.

**Fixed** in `controls.js`: a lone press while sounding does nothing. Play is
reachable only from the armed state.

### 2. An orphaned fade timer stopped whatever was playing later

`doFadeStop` armed `setTimeout(..., secs * 1000 + 100)` with no cancellation
path. Starting a different track during the fade left that timer running; when
it fired it stopped the new track and advanced the playlist.

Measured: faded track 1, selected and played track 3 during the fade, and
2.6 seconds later the transport was stopped at "End of playlist" with track 3
silent. The same pattern applied to `midiEndTimer`.

**Fixed** in `player.js`: every playback carries a generation number, and each
timer and callback checks it before acting.

### 3. The spacebar stopped working after touching any setting

The key handler began `if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;`.
A range input keeps focus after being dragged, so every subsequent keystroke was
discarded. Nothing in the interface indicated this, and the fix from the user's
point of view was to click the page and guess.

Measured: focused the master volume slider, dispatched Space, no playback.

This is the "focus loss" problem named in the brief.

**Fixed** in `controls.js`: value controls release focus when the interaction
finishes, and the handler discriminates by control type rather than refusing
every keystroke.

### 4. Thirty-six of eighty-eight instrument samples were silently discarded

`midiNoteToName` and `nameToMidi2` both matched `^([A-G]#?)(-?\d+)$` — sharps
only. The bundled MusyngKite soundfonts name every accidental with a flat:
`Bb0`, `Db1`, `Eb1`, `Gb1`, `Ab1`.

So every black note was dropped from the sample set and re-created by pitch-shifting
a white-note recording a semitone away.

| | Original | Refactor |
|---|---|---|
| Samples decoded from `church_organ` | 52 | 88 |
| Chromatic notes C2–C7 played from their own recording | 25 of 61 | 61 of 61 |
| Worst resampling distance | 1 semitone | 0 |

This is the likely cause of the "MIDI sounds out of tune or distorted" entry in
the project's own troubleshooting notes.

**Fixed** in `soundfont.js`: the note parser accepts flats and sharps.

### 5. MIDI was excluded from normalisation

`calcGain` opened with `if (track.midi) return 1`. Recorded audio was levelled to
a target RMS; MIDI was not measured at all and played at a fixed velocity scale.
The feature described as "balances volume between tracks so nothing jumps out
unexpectedly" did not apply between an MP3 and a hymn in MIDI, which is the
transition most likely to jump.

**Fixed**: MIDI tracks are rendered offline through the same voice-building code
used for playback, measured for RMS and peak, and levelled with the same formula
as recorded audio. See [Normalisation](#normalisation).

### 6. The MIDI level meter displayed random numbers

`$('vFill').style.width = (Math.random() * 40 + 20).toFixed(0) + '%'`.

The bar moved convincingly while showing nothing about the audio. An operator
using it to judge output during a service was reading noise.

**Fixed** in `player.js`: one analyser node on the master bus meters everything.

### 7. Filenames were interpolated into `innerHTML` unescaped

`renderList` built rows with a template literal containing the raw filename.

Measured: a track named `<img src=x onerror="...">.mp3` executed its handler when
the playlist rendered. Reaching it requires naming a file that way, so the
practical risk on a parish PC is low, but it is trivially avoided.

**Fixed** in `ui.js`: rows are built as DOM nodes with `textContent`.

### 8. Soundfont memory was never released

Each instrument load appended a `<script>` tag that was never removed and left
roughly 3 MB of base64 on `window.MIDI.Soundfont` alongside the decoded PCM.
Trying several instruments accumulated all of them.

Measured after one load: raw data still on `window`, two script tags retained.

**Fixed** in `soundfont.js`: the base64 and the script element are released once
the samples are decoded, and only one instrument is held at a time.

### 9. The MIDI file was re-parsed on every press

`playMidi` called `parseMidi` and `midiToSchedule` each time playback started —
synchronous work on the main thread at the exact moment the operator clicked.

**Fixed** in `player.js`: files are parsed once at load.

### 10. `midiToSchedule` crashed on large files

`Math.max(...notes.map(n => n.sec + n.dur))` spreads one argument per note. Past
roughly 100,000 notes this throws `RangeError: Maximum call stack size exceeded`.

**Fixed**: duration is computed with a loop.

### 11. SMPTE time division produced wrong tempo

The header division word was read as a plain integer. When bit 15 is set the
value is an SMPTE frame rate and ticks-per-frame pair, and reading it as
ticks-per-quarter-note yields a wildly wrong tempo.

**Fixed** in `midi-parser.js`.

### 12. Drum tracks were played as organ notes

Channel 10 carries percussion, where note numbers select drums rather than
pitches. Every note was sent to the melodic instrument regardless of channel, so
a hymn file with a drum track played the drum part as organ.

**Fixed**: channel 10 is dropped by default, with a setting to include it.

### 13. Every note looped its sample, including piano

`s.loop = true` with `loopStart`/`loopEnd` at 10 % and 90 % of the buffer was
applied unconditionally. That suits a sustained organ. On a piano sample it
loops the decay, which does not sound like a piano.

**Fixed** in `midi-engine.js`: samples are one-shot, and a loop over the steady
part of the recording is enabled only when a note outlasts the sample. A
"Sustain long notes" setting controls it.

### 14. Playback timing depended on wall-clock timers

`midiEndTimer` used `setTimeout((midiDur + 1.5) * 1000)` while notes were
scheduled on the audio clock, and the scheduler topped up from a 500 ms
`setInterval` with a 3 s lookahead. Browsers throttle timers in background
windows, which stretches the interval well past the lookahead and starves the
scheduler.

**Fixed**: end detection compares against `AudioContext.currentTime`, the
lookahead is 8 s, and the packaged build runs in a dedicated window that is never
a background tab. The optional media-key keep-alive also marks the page audible,
which exempts it from throttling.

### 15. The local server was exposed to the network and leaked processes

`Launch.vbs` ran `python -m http.server 8765` with no `--bind`, publishing the
player folder on every network interface. Nothing ever stopped it: each launch
left a hidden Python process running until reboot, and the second launch of a
session could not bind the fixed port.

**Fixed** in `app.py`: bound to `127.0.0.1` on an OS-assigned port, on a daemon
thread that dies with the window. Verified: closing the packaged application
ended the process and freed the port.

### 17. A press longer than the hold threshold never started the music

Found after the first round of fixes, from a report that the second track would
not play.

The hold timer fired at 600 ms and raised a fade regardless of whether anything
was playing. With nothing playing the fade was a no-op, but the gesture had
already been marked as consumed, so the release was swallowed and never started
playback.

Measured, with nothing playing:

| Press duration | Track started |
|---|---|
| 80 ms | yes |
| 200 ms | yes |
| 500 ms | yes |
| 650 ms | **no** |
| 900 ms | **no** |

A relaxed press on a clicker easily exceeds 600 ms, so this reads as a player
that works sometimes and not others, with no pattern the operator can see.

**Fixed** in `controls.js`: a hold only counts as a fade when something is
sounding. Otherwise the gesture falls through and the release starts the track.

### 18. A press during a fade was ignored in silence

For the whole fade, three seconds by default, `play()` refused every press
because the transport reported itself as sounding, and `fadeOut()` refused
because the state was already FADING. Nothing happened and nothing was
displayed.

**Fixed** in `player.js`: a press during a fade now closes the fade out over a
quarter of a second and arms the next track, so the operator is never locked
out. Every press also flashes the button, and a lone press during playback
answers with "press twice to fade out" rather than appearing dead.

### 16. Smaller items

- `preloadNext` was dead code. Its audio branch created an unused variable and
  returned; every file was already decoded at load.
- `STEP = 128` was declared and never used.
- `analyseAudio` made two full passes over every sample where one suffices,
  measured at 51 ms versus 25 ms per minute of 44.1 kHz stereo.
- Soundfont samples were decoded one `await` at a time; they now decode in
  parallel.
- `reloadNotice()` told the user to reload files after changing normalisation,
  but `calcGain` read the slider at playback time, so no reload was needed. The
  README repeated the incorrect advice.
- `--orange` was referenced in JavaScript but never defined in CSS.
- Debug `console.log` calls were left in the press handler.
- `advance()` could be reached from both `onended` and the fade timer.
- `SETUP.bat` downloaded a Python runtime that the distribution zip already
  contained.
- `generate_manifest.py` wrote JSON in the machine's ANSI code page and
  non-atomically.

## Normalisation

Recorded audio and MIDI now reach the same formula.

Both are reduced to an RMS and a peak. RMS is measured over the loudest window
of the track rather than its whole length, because a hymn that opens with a quiet
introduction has a low average and whole-file RMS over-boosts it: the
congregation then gets a wall of sound at the first verse. MIDI gets its numbers
by rendering the piece through an `OfflineAudioContext` using the same
voice-building code as live playback, so what is measured is exactly what is
heard.

Gain is `target / rms`, limited so the peak cannot exceed 0.98, and capped
against over-boosting. The cap differs by source: recorded audio is limited to
8x, because boosting a quiet, noisy recording amplifies tape hiss and room
rumble into the sanctuary; MIDI is limited to 24x, because it is synthesised here
and has no noise floor, leaving the peak ceiling as the only real constraint.

Measured on a test playlist at a 0.20 target:

| Track | Measured RMS | Gain | Levelled RMS |
|---|---|---|---|
| Loud WAV | 0.3535 | 0.57 | 0.200 |
| MIDI hymn | 0.0166 | 10.13 (peak-limited) | 0.168 |
| Quiet WAV | 0.0353 | 5.66 | 0.200 |

Under the original, the two WAVs levelled correctly and the MIDI played at a
fixed gain of 1.



## Instruments: what was researched and what changed

The bundled sounds are MIDI.js soundfonts from the
[gleitz/midi-js-soundfonts](https://github.com/gleitz/midi-js-soundfonts)
collection, which offers three sets. MusyngKite is the highest quality of them
and is what this project already used, so the original choice was right.
FluidR3 is smaller and plainer; FatBoy sits between the two.

The genuinely better church organ sounds available for free, such as hedOrgan,
Jeux and Steffan's Cathedral, are all `.sf2` SoundFont files. This player cannot
use them. It needs each note as a separate encoded sample in the MIDI.js
JavaScript format, and converting an `.sf2` means rendering every note offline
through a synthesiser first. That is a worthwhile project on its own; it is not
a change to this codebase.

What was done instead was to widen the bundled set from 7 instruments to 12,
chosen for what a parish actually needs across a service rather than for
General MIDI coverage.

| Added | Why |
|---|---|
| Harp | Communion, Marian hymns |
| Flute | Gentle melody line |
| Tubular Bells | Angelus, Advent |
| Trumpet | Easter and festal occasions |
| Strings (slow) | Reflective settings |

Each instrument now carries a group and a one-line description, so the chooser
reads as "Organ: Church Organ, hymns, entrance and recessional" rather than a
flat alphabetical list. Anything dropped into the soundfonts folder later still
appears automatically, under "Other", with no code change.

## Per-track instruments

Each MIDI track now chooses its own instrument, set from a dropdown on its
playlist row. A parish can put the organ on the entrance hymn and recessional
and a piano on the Communion motet, decided in the sacristy beforehand, with
nothing to change during the service.

Two consequences had to be handled.

**Levelling is per instrument.** The same MIDI file played on a harp and on an
organ are different pieces of audio at different loudness. Changing a track's
instrument discards its measurement and redoes it in the background against the
new one. Measured on one test hymn: organ 5.33x, piano 15.92x, both arriving at
the same target level.

**Memory is bounded.** One decoded instrument is about 100 MB, so holding all
twelve is not possible. Decoded instruments live in a small cache holding two,
which is all that is ever needed: the track that is sounding and the one queued
behind it. The next track's instrument is decoded while the current one plays,
and the pair in use cannot be evicted. Measuring a playlist temporarily decodes
more, so the cache is trimmed back once measuring finishes.

Measured across a four-hymn service using three different instruments:

| | Result |
|---|---|
| Memory, steady state | 202 MB, flat across the whole service |
| Press-to-sound, every track | 12 ms, regardless of instrument change |
| Cold start, nothing decoded yet | 343 ms, once, before anyone presses play |

Downmixing the samples to mono would halve the memory. It was checked and
rejected: the samples are genuinely stereo, not dual mono, so it would audibly
narrow the sound.

## Splitting the interface

Everything the person running the service touches is on the Player tab: the
list, what is playing, and one button. Every setting moved to a Setup tab.
The reasoning is the same one behind ignoring a lone press during playback. A
volunteer should not be one stray click away from changing the levelling in the
middle of Mass.

The clicker settings gained a teaching mode. The README previously told anyone
whose clicker sent unexpected keys to raise an issue and wait for a release.
Now they click Learn, press the button on their clicker, and it is mapped and
saved. Verified: an unusual key was taught, displayed, persisted to storage, and
cleared again by Reset.

## Trigger latency

The delay between the press and the first sound matters more than anything else
in a live service, so it was measured rather than assumed. Timings are from the
release of the button to the audio clock time of the first scheduled sample,
median of seven runs.

| Path | Latency |
|---|---|
| Recorded audio | 0 ms |
| MIDI | 12 ms |
| Sound card output, unavoidable | 40 ms |

Recorded audio starts on the very next render quantum, because files are fully
decoded at load and playback is only a buffer source and a `start()` call.

Three changes got MIDI there:

- The scheduler used to start the first chord 80 ms in the future as a
  comfortable margin. That margin is pure latency; it is now 12 ms, roughly one
  render quantum, which is enough to avoid scheduling behind the clock.
- MIDI files are parsed once at load, not on every press.
- Loudness measurement no longer blocks playback. Measuring means rendering the
  piece offline, which can take seconds on a modest PC. It now runs in the
  background and applies from the next play, rather than making the operator
  wait at the moment they press.

The instrument is decoded as soon as a MIDI file enters the playlist, typically
minutes before the service, so the first press does not pay for it. It is not
decoded unconditionally at start-up: one soundfont is about 100 MB of audio once
decoded, and a parish that only plays recordings should not pay that.

## Control mapping

The brief asks for a double press to fade rather than stop dead, which is a
change from the shipped mapping. An abrupt cut is far more conspicuous in a
church than a three-second fade, so the change is right, and instant stop stays
available for genuine emergencies.

| Gesture | Original | Now |
|---|---|---|
| Single press, armed | Play | Play |
| Single press, playing | Restart from zero | Ignored, with an on-screen hint |
| Single press, fading | Ignored | Completes the fade and arms the next track |
| Press longer than the threshold, nothing playing | Ignored | Plays |
| Double press | Instant stop | Fade out |
| Hold | Fade out | Fade out |
| Escape | — | Instant stop |
| Right arrow / Page Down / Enter / B | Right arrow only | Play |
| Left arrow / Page Up / F | Left arrow, F | Fade out |
| Bluetooth media buttons | Not supported | Play, pause, next, previous |

Play never waits to see whether a second press is coming, because a double press
only means anything while a track is sounding. There is no added latency on the
gesture that starts the music.

Bluetooth media buttons need the Media Session API, which browsers only engage
while something is registered as playing media; a Web Audio graph alone does not
qualify. A silent looping audio element claims the session, and as a side effect
marks the page audible so its timers are not throttled.

## Packaging: what changed and why

The brief asks for a PyInstaller build bundling `fluidsynth.dll`, SDL2 and `.sf2`
files. The application uses none of them.

What a volunteer previously had to do: unzip a folder, run `SETUP.bat`, clear a
SmartScreen warning, wait for a Python download, then run `Launch.vbs` every
Sunday — which opened the player as a tab in whatever browser was default, with
an address bar, alongside whatever else was open, leaving a hidden server process
behind.

What they do now: run one installer, then click a Start menu entry that opens a
dedicated window with no address bar and no browser.

`app.py` serves the bundled files on the loopback interface and opens them in an
embedded WebView2 window, the Edge engine already present on Windows 10 and 11.
A local server is still required because the page uses ES modules and fetches its
instrument manifest, neither of which browsers permit from `file://`.

The build is verified end to end, not just specified. See
[PACKAGING.md](PACKAGING.md).

| | Result |
|---|---|
| Bundle size | 53.6 MB, including all twelve instruments |
| Python needed on the target PC | No |
| Browser needed | No |
| Build exit code | 0 |
| Executable launched and served all modules | Yes |
| Orphan process after closing | None |


## Findings from real parish files

Everything above was found against synthesised test files. Running three real
hymn files from a parish service (`Hymns 6th Easter`) found five more problems,
four of them mine.

### 19. Sysex events desynchronised the parser

The worst of them, and a regression I introduced while tidying the parser. The
system-exclusive branch read:

```javascript
p += varLen();
```

`varLen()` advances `p` itself, but the compound assignment had already captured
the old `p` and then overwrote it, swallowing the length byte. Every sysex event
threw the parse one byte out.

The original code used a temporary variable and was correct. Files exported from
a keyboard are full of sysex, and these hymns had dozens.

| | Reported by the player | Actual |
|---|---|---|
| Duration of a 3-minute hymn | 3,122 s | 185 s |
| First note begins at | 2,921 s | 1.9 s |
| Measured level | silence | normal |

Pressing play produced nothing, because the first note was scheduled 48 minutes
in. Fixed, with the reasoning recorded in a comment so it is not tidied back.

### 20. Every hymn began with two seconds of silence

All three files opened with an empty bar: the first note fell 1.88 seconds in.
The operator presses at the moment the music is wanted, hears nothing, and
concludes the player has failed. This is the likeliest single cause of the
original "it doesn't play" report.

**Fixed** in `midi-parser.js`: silence before the first note is trimmed, leaving
an 80 ms lead. Nothing musical is lost, because what is removed is silence.
Measured press-to-audible afterwards: 0.05 s to 0.11 s.

### 21. Short notes rang for 2.4 seconds

The release model was inverted: the shorter the note, the longer its tail, up to
1.2 seconds before the user's multiplier was applied. At the default a 30 ms
passing note rang for 2.4 seconds.

A real hymn setting is full of such notes. One of these files had 81 notes under
100 ms out of 522, and up to 18 voices overlapping at once. The result was a
continuous wash rather than a played line.

Neither instrument behaves that way. An organ pipe stops when the key releases
and a piano damper falls on the string; the ring a congregation hears afterwards
is the building. The tail is now short and grows slightly with note length
instead of shrinking. Overlapping voices roughly halved, from 18, 18 and 20 to
9, 10 and 12.

### 22. Levels were measured from the opening, and hymns clipped

Loudness was measured from the first 45 seconds. Hymns build: on these three
files the loudest moment fell at 166 s, 41 s and 195 s. Two of the three had
their level taken from a quiet early verse, were given too much gain, and
clipped during the final verse.

Rendering the whole piece fixed it but took 11 seconds for one hymn, far too
slow across a service. The loudest passages are now located arithmetically, by
sweeping the sum of sounding note velocities, and only twenty seconds around
each of the top three are rendered.

| | Before | After |
|---|---|---|
| Load and measure, 3 hymns | 21.4 s | 1.9 s |
| Load and measure, full 8-track service | — | 2.7 s |
| Clipped samples, verified against a full render | 31 | 0 |

The peak ceiling also moved from 0.98 to 0.89, about a decibel of headroom. The
old value left 0.2 dB, so a track levelled against it clipped as soon as
anything varied.

### 23. The levelling target was set too high to be reachable

A commercially mastered recording can already sit at full scale and cannot be
raised without clipping. Aiming high strands those tracks below everything else.
One track in the service, an Amen, had a true peak of exactly 1.000.

Lowering the default target from 0.20 to 0.12 costs overall level, which the
amplifier is set for once, and buys consistency:

| Levelling target | Spread across the service |
|---|---|
| 0.20 | 5.5 dB |
| 0.16 | 3.6 dB |
| 0.13 | 1.8 dB |
| **0.12** | **1.1 dB** |

At 0.12, seven of the eight tracks in a real mixed MP3-and-MIDI service land
exactly on target and the eighth, the maximised Amen, sits 1.1 dB below.


### 24. A piano performance played on an organ

The three hymn files carry Yamaha system-exclusive data and turned out to be
performances recorded on a digital piano. That matters, because a piano
performance carries two habits an organ cannot reproduce.

**Touch.** A piano gets louder when struck harder, so a player shapes the line
with velocity. An organ pipe cannot: air is flowing or it is not. Played
literally on an organ, the quiet notes nearly vanish and the line drops in and
out. Measured dynamic range on one hymn: 39.6 dB as performed, which is
pianistic, against 2.2 dB after compressing velocity towards full, which is how
pipes behave.

**Articulation.** A pianist lifts between notes and lets the string ring on; an
organist holds, because lifting stops the sound dead. About a third of the notes
in these files are detached.

Instruments are now voiced according to what they are. Organ, voices, strings
and wind compress velocity and close gaps up to 0.35s; piano, harp, bells,
harpsichord and celesta are left exactly as performed. The instrument's group
comes from the manifest, so a new soundfont is classified without code changes.

### 25. Sustain came from note tails rather than from the room

This is the same mistake as defect 21, seen from the other side. What makes an
organ sound sustained in a church is the building. The original faked it by
holding every note on for up to 2.4 seconds, which is why a busy hymn turned to
mud; shortening the tails then exposed the real articulation and the result was
audibly start-stop.

A convolution reverb does the job properly: one diffuse tail shared by
everything sounding, so gaps fill in while each note still stops when it should.
The impulse response is generated rather than shipped, so it costs nothing in
the download. It is applied to MIDI only, since a recording already carries the
acoustic of wherever it was made.

Measured on one hymn, as the proportion of time sound is present and the number
of audible gaps longer than 120 ms:

| | Sounding | Gaps |
|---|---|---|
| Original, 2.4s tails | 97% | 0 |
| Short tails alone | 90% | 33 |
| Organ voicing, no reverb | 90% | 33 |
| Organ voicing with church acoustic | 96% | 4 |

The four remaining gaps are phrase breaks that belong in the music. Peak level
was re-checked with the reverb included and no track clips.


### 26. The sustain pedal was thrown away

The largest single cause of the player sounding wrong, and the last to be found.

The parser skipped every controller event. Controller 64 is the sustain pedal,
and these files are performances recorded on a digital piano, where the pedal is
worked constantly. Discarding it means every note stops the instant the key
lifts.

| File | Notes | Sustain pedal events |
|---|---|---|
| Alleluia, Sing to Jesus | 2,222 | 2,380 |
| Immaculate Mary | 2,024 | 638 |
| Dear Lord and Father | 1,428 | 480 |

Between 91% and 96% of the notes in these hymns are held by the pedal. Median
sounding length goes from 0.41s as played to 1.21s as heard, so without the
pedal roughly two thirds of every note was being cut off.

The pedal is honoured for instruments that have one. A piano's pedalled notes
decay by themselves and overlap harmlessly. An organ has no sustain pedal at
all, and holding every note through a pedalled passage would pile into a drone,
so organ-family instruments get legato filling instead, which is what an
organist does by hand.

Measured on one hymn, proportion of time sound is present and audible gaps over
120 ms:

| | Sounding | Gaps |
|---|---|---|
| Piano, pedal discarded | 84% | 45 |
| Piano, pedal honoured | 95% | 1 |
| Organ, voicing and acoustic | 96% | 4 |

Re-checked against a full-length render with reverb: no clipping, and at most
14 voices sounding at once.


### 27. Harmony-aware holding for organ

With the pedal honoured, piano playback was right but organ was not. The reason
is specific and measurable: a pianist's pedal blurs across harmony changes,
which is harmless on an instrument whose notes are already dying away, but an
organ holds everything at full volume until released.

Measured across three real hymns, as the largest number of the twelve pitch
classes sounding simultaneously:

| | Max pitch classes | Notes at once | Time sounding |
|---|---|---|---|
| As played, on piano | 5 | 6 | 80% |
| Pedal applied blindly to organ | 7 | 10 | 96% |
| Held to the next chord | 5 | 6 | 99% |

Seven of twelve pitch classes ringing at constant volume is over half the
chromatic scale, and that was the muddiness.

Organ-family instruments now hold each note until the next chord is struck,
which is what an organist does by hand: hold through the harmony, release on the
change. At that moment the note is either dropped from the harmony, so releasing
it is right, or struck again, so the new note takes over cleanly.

Two details were settled by measurement rather than intuition.

**Which rule.** An earlier version held each note until the next chord that did
not contain its pitch. That sounds more careful but leaves the old and new note
of a re-struck pitch overlapping, 64 to 184 times per hymn. Holding to the next
chord onset regardless produces none, and the same harmonic density.

**How far to bridge.** Gaps longer than 0.6s are left alone, because they are
rests the player intended. That figure reproduces each performance's own
phrasing exactly, breath for breath, while closing the small lifts between
notes:

| Bridging limit | Breaths kept | Time sounding |
|---|---|---|
| As played | 3, 8, 9 | 70-95% |
| 0.6s | 3, 8, 9 | 99% |
| 1.0s and above | 0 | 100% |

A limit of one second or more erases every phrase break in the music.

Verified afterwards: no clipping with the reverb included, harmonic density
unchanged from the performance, and piano tracks untouched, still following
their recorded pedal.

### 28. The instrument dropdown would not stay open

Reported from real use: choosing an instrument was "a bit fiddly". The list
opened and closed again unless the mouse was held perfectly still.

A playlist row is a drag source, so the service order can be rearranged. A press
anywhere inside the row arms that drag, the dropdown included, and as soon as
the pointer moved a pixel the browser began dragging the row, which dismissed
the list that had just opened.

The original code tried to prevent this from inside the picker:

    wrap.draggable = false;
    wrap.addEventListener('dragstart', e => e.preventDefault());

Neither line can work. `draggable = false` on a descendant does not stop an
ancestor being the drag source, and `dragstart` fires on that ancestor, so it
never passes through the picker and the listener never runs.

**Fixed** in `ui.js`: the row's own draggability is suspended while the pointer
is over the dropdown and restored when it leaves. Because the open list is drawn
by the operating system and can swallow the pointer, `pointerleave` is not
guaranteed to arrive, so any press elsewhere in the playlist restores every row.
Reordering is otherwise unchanged.

### 29. The application had no icon

`parish_music_player.spec` looks for `build/app.ico` and silently builds without
one if it is missing. It was missing, so the executable carried PyInstaller's
default icon, and the desktop and Start menu shortcuts inherited it. A volunteer
looking for the player on the desktop had nothing to recognise.

**Fixed**: `build/make_icon.py` generates `build/app.ico` from `src/logo.png`,
the same rose window shown at the top of the player, at the seven sizes Windows
draws. `SetupIconFile` now puts it on the Setup file too, so the download, the
installed program, both shortcuts and the page itself all match.

### 30. Gold on navy was hard to read, and light mode was broken

Reported from real use: the dark blue and gold "can be a little hard to read".
Measured on the Player tab, as the contrast ratio of each piece of text against
what is actually behind it, 8 of 22 were below the 4.5 to 1 minimum for body
text. The worst was 2.82.

The gold was not the main culprit. It measured 6.7 to 8.2 and passes; it reads
weakly because it is a mid-brightness colour carrying 13 pixel text. Almost all
the failures traced to one token, `--text3`, used for track numbers, the drag
handles, the "Up next" label, the "audio" badge, the Setup tab and the hint
line.

Worse, the scheme followed the machine's own light or dark setting, and only
swapped the text colours, never the background. A PC set to light mode drew
near-black text on the navy ground: the next track's name measured 1.79, which
is invisible. Any parish PC not set to dark mode was affected.

**Fixed**: the stylesheet now holds three complete schemes as three sets of
custom properties, white, parchment and blue, chosen from a switch on the Setup
tab and saved. Parchment is white's ink and bronze on a paper-coloured ground,
so it costs one block of surface colours and nothing else. Nothing follows the
operating system any more, so the whole class of half-applied scheme is gone. The scheme is applied by a small script in the
document head, before the modules load, so the player does not flash the wrong
one on the way up.

Three changes were needed beyond the background colour.

**Gold cannot carry text on a pale ground.** At its existing lightness it
measures about 2 to 1 on cream. In the white scheme it is a deep bronze
instead, and still reads as gold.

**Hymn names are no longer gold in either scheme.** The playing row is marked
by a gold edge down its left side and a tint behind it, and the name itself is
ordinary body text. Gold lettering was the specific thing that read worst.

**The transport button is a solid block in the white scheme.** On a pale page
it has to be the one strong area of colour, or the eye has nothing to land on.

Every rule now reads the tokens rather than naming a colour, including the thin
washes behind progress bars and badges, which were white at low alpha and
assumed a dark ground throughout. A rule can no longer work in one scheme and
fail in the other.

| | Text checked | Below the minimum | Lowest ratio |
|---|---|---|---|
| Before | 22 | 8 | 2.82 |
| White | 83 | 0 | 5.66 |
| Parchment | 83 | 0 | 5.18 |
| Blue | 83 | 0 | 7.28 |

The later figures cover the Setup tab as well, which the first measurement did
not reach.

### 31. One narrow column on a widescreen monitor

The player was built as a single 700 pixel column, which is the shape of what
it does: a list, then what is playing, then one button. On the monitor a parish
PC actually has, that leaves most of the screen empty and pushes the Play button
below the fold as soon as a service has more than about five items in it.
Measured at a 1320 by 800 window with five items, the layout needs 958 pixels of
height. Setup needs 1,585, about two screens.

**Fixed**: a second layout, chosen from Setup beside the colour scheme and
saved. Wide is the default. It puts the service list beside the transport, lays
the header on its side, and closes the spacing. The same window then needs 800
pixels for the Player tab and 756 for Setup, so both are one screen.

Below 900 pixels wide, the wide layout behaves as the tall one, so a small
screen or a half-width window is never left with columns too narrow to read.

Sound and MIDI instruments moved from Setup to the Player tab at the same time,
at the parish's request, so the controls that get adjusted are on the first
screen. This gives up something the split was meant to protect: the Player tab
previously held only what is touched during a service, so that a volunteer could
not be one stray click from changing the sound mid-Mass. Levelling and Church
acoustic now sit on that screen. Moving them back is two blocks of markup.

| | Player tab | Setup tab |
|---|---|---|
| Tall | 958px | 1,585px |
| Wide | 800px | 756px |

One trap worth recording. `#panelPlayer { display: grid }` beats the browser's
own rule for the `hidden` attribute, so both tabs rendered at once. The layout
rules are written against `:not([hidden])`.

### 32. The instrument dropdown closed the instant it opened

Reported twice from real use, and the first attempt at it, in defect 28, fixed
only part of the cause.

The real one is in `controls.js`. To keep the spacebar and the clicker working
after any setting is touched, value controls hand focus back as soon as the
interaction finishes:

    document.addEventListener('pointerup', e => {
      if (isValueControl(e.target)) setTimeout(() => e.target.blur(), 0);
    });

`isValueControl` is true for every `<select>`. A dropdown opens its list on
pointer-down, so the pointer-up a fraction of a second later arrives while the
list is open, and blurring it there closes it again. The list appeared and
vanished within the same click. Correct for a slider, wrong for a dropdown.

Measured by watching focus events either side of a real click on the chooser:

| | Focus events | Where focus ended |
|---|---|---|
| Before | in, then immediately out | `body` |
| After | in | still on the dropdown after 2.5s |

**Fixed**: the pointer-up rule now applies to range sliders only. A dropdown
still gives focus back when a choice is made, which is the `change` handler
beside it, and when anything else is clicked, which is the handler below it.
Both were re-tested: choosing an instrument applies it and returns focus to the
body, and clicking the header does the same. The spacebar protection is intact.

A caveat worth knowing. With the list genuinely staying open, a spacebar press
while it is open still reaches the transport and starts the music. That was
always so and is unchanged here.

### 33. The console looked stuck when it was ready to play

Reported as a MIDI file the player "didn't like". It was playing perfectly. The
status said otherwise.

Loading an instrument reports progress to the console. The same decode also runs
in the background, to measure a track's loudness and to warm the next track's
instrument, and that reporting overwrote the status after the player had already
reached its ready state. Nothing put it back, so the console sat on an amber
"Preparing instrument: 87 of 88" indefinitely, next to a Play button that
worked. The count stops one short because the completion update is deliberately
suppressed.

Checked first that the files themselves were sound: all eight of the parish's
real MIDI files parse, between 184 and 1,111 notes, 78 to 240 seconds, and a
track plays with notes scheduled and no errors.

**Fixed** in `player.js`: progress is reported only while the player is actually
waiting on the instrument. The console now reads "Ready - press play" once
loading finishes.

### 34. The levelling slider had no setting better than its default

Asked by the parish, once the Sound card was on the first screen: what is
Levelling for, and is it needed given the player levels anyway?

It is not. The slider never switched levelling on or off. Every track is
measured and brought to a target regardless, and the matching between tracks
comes out of the ratio of target to measured loudness, so the target cancels.
What the slider changed was the level everything lands on, and it could only
make things worse:

  - Raised, the quiet hymns follow it up but a commercially mastered recording
    is already near full scale and is stopped by the peak guard. The loud items
    stay put while the quiet ones climb, and the spread the levelling exists to
    close opens up again. Measured on a real eight-item service: 1.1 dB spread
    at 0.12, 5.5 dB at 0.20.
  - Lowered, it does what the master volume already does.

Its one honest use was as a last resort when the master volume is at 100% and
the amplifier is flat out, at the cost of the matching.

**Removed.** The target is now `TARGET_RMS` in `loudness.js`, beside the peak
ceiling and the boost limits it works with, which is where the other numbers
that must not be fiddled with already live. Verified afterwards on two hymns and
one recording: gains of 2.39, 2.45 and 0.93, all three landing on 0.12, a spread
of 0.00 dB.

A player upgrading from a version where somebody had moved the slider is
unaffected: the saved value is simply not read, because settings are restored
only for keys the current version defines. Tested by planting 0.42 in the saved
settings and reloading.

### 35. A third layout, kept alongside the second rather than replacing it

The parish asked for the wide layout revised so the sound controls and one
full-width Play button are fixed to the bottom of the window, with the service
list taking whatever height is left and scrolling only when it runs out. Tried
in the real player, the two people who use it disagreed about which they
preferred, so both are kept.

`Wide` leaves the transport in the right-hand column and lets the page scroll if
it must. `Anchored` makes the window the frame: the page cannot scroll at all,
only the list can.

| At 1320 by 800, four items | Play button | Its bottom edge | Page height |
|---|---|---|---|
| Wide | 515px wide | 395 | 800 |
| Anchored | 1132px wide | 801 | 801 |
| Tall | 652px wide | 817 | 1,337 |

The two wide layouts are one layout with a variation, not two copies. Their
stored values both begin "wide" and everything they share is matched on that
prefix, `html[data-layout^="wide"]`, so a change to the shared part cannot
apply to one and not the other. The anchored rules are the 22 selectors that
differ.

Two details settled while building it. Sound runs horizontally, because a
full-width card two rows deep would eat the height the list was meant to gain.
The hold bar moved above the button: it is the only sign that a press-and-hold
is registering, and below the button it was the row that fell off the bottom
edge of the window.

Anchoring needs a window tall enough for the fixed parts. Below 620px of height
the page gives its scrollbar back rather than crushing the list to nothing.

## A real pipe organ

Everything above improved how a performance is adapted to an organ. None of it
could improve the organ, because the player renders MIDI from recordings of
single notes and the recordings were the ceiling. The bundled `church_organ`
comes from MusyngKite, a general MIDI collection; it is serviceable and it is
not a pipe organ.

Three instruments have been added, converted from a recording of one:

| Key | Registration | For |
|---|---|---|
| `pipe_organ` | Principal 8', Oktava 4' | most hymns |
| `pipe_organ_full` | Principal 8', Oktava 4', Oktava 2', Mixtur V, Trumpet 8' | last verse, recessional |
| `pipe_organ_flute` | Gedakt 8' | Communion |

The source is the Bureå church sample set: the 1967 Hammarberg organ in Bureå,
Sweden, recorded pipe by pipe in May 2010 by Lars Palo and prepared for
GrandOrgue by Lars Palo and Graham Goode. Every note of every instrument above is
a recording of that organ sounding that note.

### Why this set and not a better-known one

The licence decided it, not the sound. The player redistributes its samples
inside the installer, so a set that cannot be redistributed cannot be used
however good it is.

| Candidate | Outcome |
|---|---|
| hedOrgan | "No public or private licence, this soundfont is completely free." Free of charge is not a grant of redistribution, and no terms are stated anywhere. Rejected as ambiguous. |
| Jeux d'orgues | Free to download, but the terms found say private use, and no modification without the author's written consent. A conversion is a modification. Rejected. |
| Aeolus soundfont | GPL-3, so redistributable, but it is a recording of a synthesiser rather than of pipes, and GPL data inside an MIT project needs care. Rejected on both counts. |
| musical-artifacts.com mirrors | The site's own listings were readable, but every file download is behind bot detection. Not pursued. |
| Bureå church, familjenpalo.se | Creative Commons Attribution-ShareAlike 2.5 Sweden, stated on the download page and again inside the organ definition file. Chosen. |

Those three files therefore carry the sample set's licence, not this project's.
`LICENSE` now says so, names Lars Palo and Graham Goode, and states that anyone
redistributing them must do so under the same terms. The rest of the project,
the converter included, remains MIT.

### What the conversion had to do

`tools/build_soundfont.py`, with `tools/grandorgue_reader.py`. The source is a
780 MB `.orgue` package, which is a ZIP of one definition file and a folder of
recordings per rank. Three things about it are not what the player wants.

**A stop is a folder of keys, not of pitches.** The recording filed under a 4'
stop's key 36 already sounds an octave above key 36, because that is the pipe the
key opens. Two consequences, both good: a stop needs no transposing, and drawing
several stops is addition. `pipe_organ_full` is five recordings summed per note,
which is what those five drawstops do on the real console. Mixtures and the
Sesquialtera, which sound several pipes per key at odd intervals, come out right
without any modelling because they were recorded that way.

**A pipe is recorded for a few seconds, with loop marks.** The player holds a
sample one-shot for as long as the note lasts, so each note is built here into a
finished 3.19-second sustained note by repeating the marked region.

**There is a recorded release on the end.** The player applies its own release.
A recorded one left in place would be looped over, which dips audibly, so
everything from the release cue onwards is discarded.

The definition file also carries a measured tuning correction for individual
pipes, in cents, and a level for each stop and some individual pipes. Both are
applied. They are the sample set author's voicing of a real instrument, and
discarding them would be discarding the part that makes it sound like one organ
rather than forty recordings.

Below the manual compass, which stops at C2, the bottom octave is built from the
pedal ranks: Subbas 16' carries the note itself and the pedal Principal 8' and
Oktava 4' sit above it. That is a real pedal registration rather than a manual
pipe resampled down an octave.

### The loop the player makes, made seamless

`midi-engine.js` loops between 55% and 95% of a sample when a note outlasts the
recording. The converter builds the tail as one chunk placed so that it starts
at 55% and ends at 95%, closed by a crossfade into the frames just before it
begins, so the player's loop is a loop of something built to be looped.

Two obstacles, both measured rather than guessed.

**MP3 moves everything.** The encoder prepends 1105 frames of delay and pads the
end to a whole frame, so 140544 frames in come back as 141696 out. Placing the
chunk by the input's geometry put it in the wrong place. It is now measured once
per build by encoding and decoding a noise probe, and the chunk is placed where
it will land after the round trip. The player runs in WebView2, whose decoder is
the same FFmpeg that takes the measurement.

**Rounding the chunk to whole cycles was wrong.** Rounding it to a whole number
of the note's own periods puts the crossfade in phase and avoids combing, and it
was built that way first. It is worse: rounding moves the wrap by up to half a
cycle, and half a cycle at the wrap is the largest discontinuity available.
Measured as the size of the jump at the wrap against the average step between
neighbouring samples at that point:

All three rows are the same 88 notes of `pipe_organ`, except the last:

| | Median | Worst |
|---|---|---|
| Chunk rounded to whole cycles | 12.2x | 338x |
| Chunk placed exactly | 1.3x | 4.9x |
| Bundled `church_organ`, for comparison | 9.9x | 89x |

A jump of 1.3 times the ordinary step between samples is no jump at all. The
crossfade now uses an equal-power curve, which holds the level steady on the
occasions when the two stretches it blends are out of phase.

### Level, and why these are not normalised to full scale

Normalising each set so its loudest note peaks near full scale is the obvious
thing and it is wrong here. `player.js` measures a track's loudness in the
background and gives it a gain of 1 until that measurement finishes, so the
first play of any hymn runs at the sample's own level. Full-scale samples are
four times hotter than the bundled ones, and a rendered hymn peaked at 1.125.
That first play clips.

The three instruments are instead normalised as a set to the mean RMS of
`church_organ`, 0.030, with one gain applied to every note so the differences
between notes stay the organ's own. Rendering the same hymn through each:

| Instrument | Peak of a 32-second render, track gain 1 |
|---|---|
| `church_organ` | 0.268 |
| `pipe_organ` | 0.263 |
| `pipe_organ_full` | 0.264 |
| `pipe_organ_flute` | 0.217 |

This costs something real and it is worth recording. LAME allocates bits by
audibility, so encoding a quiet signal spends fewer of them. Measured on middle
C of the full plenum, that note encodes to 33.5 dB signal-to-noise at full scale
and 26.1 dB at the shipped level. Recovering it would mean VBR quality 2 instead
of 5, which on that note is 167 kbps against 114, and about half again the file
size across the set. It was not taken. The
bundled organ these replace averages 65 kbps at a similar level, against 90 and
99 for the two principal registrations, and level surprises during a service are
worse than an encoder's noise floor.

### What it costs

| | `church_organ` | `pipe_organ` | `pipe_organ_full` | `pipe_organ_flute` |
|---|---|---|---|---|
| File on disk | 2.85 MB | 4.06 MB | 4.44 MB | 3.05 MB |
| Average bitrate | 65 kbps | 90 kbps | 99 kbps | 68 kbps |
| Decoded in the browser | 101 MB | 104 MB | 104 MB | 104 MB |
| Notes recorded, A0 to C8 | 88 | 88 | 88 | 88 |

The three files add 11.5 MB to what the installer carries. Decoded memory is
unchanged, which is the figure that matters: `MAX_RESIDENT_INSTRUMENTS` is still 2 and the footprint is
still near 200 MB.

### Sustain

Samples must hold rather than decay, or a held chord collapses. Measured as the
RMS envelope of middle C in 50 ms frames, as a percentage of that note's peak,
the lowest value after the attack:

| `church_organ` | `pipe_organ` | `pipe_organ_full` | `pipe_organ_flute` |
|---|---|---|---|
| 53% | 62% | 54% | 71% |

Across all 88 notes the median is 63-72% depending on the instrument, and the
low outliers are not decay. Two causes, both the organ's own: two ranks an
octave apart beat against each other at the top of the compass, which swings the
envelope without lowering it, and a high stopped flute has a pronounced chiff
that is louder than the note it settles into. The Gedakt's B6 reads 8% by this
measure and sounds entirely steady.

### What was not done

The Bureå set has 33 stops and three manuals. Converting more of them is a few
lines in the `RECIPES` dictionary, and was left alone: three registrations cover
what a parish service asks for, and each one added is another 4 MB in the
installer for an instrument most volunteers will never choose.

## Verification

Eleven behavioural checks were run against the refactor in a browser, driving the
real input layer rather than calling the transport directly. All pass.

| # | Check | Result |
|---|---|---|
| 1 | A lone press during playback does not restart the track | pass |
| 2 | A double press starts a fade | pass |
| 3 | A fade auto-advances and arms the next track | pass |
| 4 | A track started during a fade is not stopped by the old timer | pass |
| 5 | MIDI played after a MIDI fade is audible | pass |
| 6 | The spacebar works after a slider has been used | pass |
| 7 | A filename containing HTML is escaped | pass |
| 8 | Soundfont base64 and script tags are released | pass |
| 9 | A track ending naturally auto-advances | pass |
| 10 | A MIDI track ends on the audio clock and auto-advances | pass |
| 11 | Escape stops immediately; no chain, player or timer is left behind | pass |
| 12 | A press of 650 ms or 1200 ms starts the track | pass |
| 13 | A press during a fade completes it and arms the next track | pass |
| 14 | A lone press during playback leaves the music alone and shows a hint | pass |
| 15 | Pressing through a whole MP3, MIDI, MP3 playlist works track to track | pass |
| 16 | MP3 loads, decodes, normalises, plays, fades and auto-advances | pass |
| 17 | Each MIDI row shows an instrument chooser; audio rows show a badge | pass |
| 18 | Changing one track's instrument re-levels only that track | pass |
| 19 | Instrument cache stays at two, 202 MB, across a four-hymn service | pass |
| 20 | Latency stays at 12 ms when the instrument changes between tracks | pass |
| 21 | An unusual clicker key can be taught, is saved, and can be reset | pass |
| 22 | The spacebar still works after using a slider on the Setup tab | pass |
| 23 | Three real parish hymns parse to correct durations, 185/115/212 s | pass |
| 24 | Real hymns are audible 0.05-0.11 s after the press | pass |
| 25 | No clipping on any real hymn, verified against a full-length render | pass |
| 26 | A real 8-track MP3 and MIDI service levels to a 1.1 dB spread | pass |
| 27 | Pressing through a real service plays, fades and advances correctly | pass |
| 28 | Organ voicing compresses a piano performance's 39.6 dB range to 2.2 dB | pass |
| 29 | Church acoustic restores continuity, 33 audible gaps down to 4 | pass |
| 30 | No clipping once the reverb send is included in a full-length render | pass |
| 31 | Sustain pedal is read and holds 91-96% of notes in real hymn files | pass |
| 32 | Piano audible gaps fall from 45 to 1 once the pedal is honoured | pass |
| 33 | Pedalled notes do not clip and stay within 14 simultaneous voices | pass |
| 34 | Transport still plays, fades, advances and stops with pedal handling on | pass |
| 35 | Organ holds 96% of notes into the next chord, none doubled | pass |
| 36 | Organ harmonic density matches the performance, 5 pitch classes not 7 | pass |
| 37 | Phrase breaks survive: same breath count as played, at 99% sounding | pass |
| 38 | Piano still follows its recorded pedal; organ and piano differ per track | pass |
| 39 | Each new organ loads: 88 notes decoded, 61 of 61 exact, no resampling | pass |
| 40 | Decoded footprint 104 MB per instrument; cache still trims back to two | pass |
| 41 | Loop wrap jump is 1.3x the ordinary step between samples, against 9.9x | pass |
| 42 | A 32 s hymn render peaks at 0.26, matching church_organ, no clipping | pass |
| 43 | Middle C holds at 54-71% of peak; no note decays to silence | pass |
| 44 | A row stops being draggable while the pointer is over its dropdown | pass |
| 45 | A row stranded undraggable recovers on the next press in the playlist | pass |
| 46 | Changing an instrument still re-levels only that track | pass |
| 47 | Setup.exe and the application carry the player's own rose window | pass |
| 48 | Every piece of text passes 4.5 to 1 in all three schemes, 83 checked | pass |
| 49 | The scheme is saved and survives a restart with no flash of the other | pass |
| 50 | Both layouts show exactly one tab panel, switching either way | pass |
| 51 | Wide fits the Player tab in 800px at a 1320 by 800 window | pass |
| 52 | The instrument dropdown stays open until a choice or a click away | pass |
| 53 | Choosing an instrument still hands focus back, so the clicker works | pass |
| 54 | The console reaches "Ready - press play" and stays there | pass |
| 55 | Two hymns and a recording all level to 0.12, a 0.00 dB spread | pass |
| 56 | A saved levelling value from an older version is ignored | pass |
| 57 | All three layouts apply, save, and show one tab panel each | pass |
| 58 | Anchored pins the button at the window's bottom edge; only the list scrolls | pass |

## Not addressed

- **The stylesheet still fetches Cinzel and Inter from Google Fonts.** On a PC
  with no internet the page falls back to Georgia and the system sans-serif, and
  renders correctly. Making the packaged build genuinely self-contained means
  bundling the two font files. Worth doing; it changes the visual result, so it
  is left as a decision rather than an assumption.
- **`parish-music-player-dist.zip` is still committed.** It is now superseded by
  `src/` and the build pipeline, and it puts 25 MB of binaries in the history.
  Removing it is a judgement call about the release process, not a code fix.
- **No automated test suite.** The eleven checks above were run interactively.
  They would transfer to Playwright with little change, and the `window.parishPlayer`
  hook exists to make that straightforward.
- **Program change and channel volume are ignored.** All melodic channels play
  the one selected instrument. That matches how the application presents itself
  and how hymn accompaniment is used here, but a multi-timbral arrangement will
  not sound as its author intended.
