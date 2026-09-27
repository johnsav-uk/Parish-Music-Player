# Handoff: a better pipe organ for Parish Music Player

A self-contained brief for a fresh session. It assumes no knowledge of the
conversations that led here.

## The job

Convert a high-quality pipe organ SoundFont (`.sf2`) into the JavaScript
soundfont format this player uses, add it to `src/soundfonts/`, and verify it
sounds better than the organ already bundled.

## Why this and not something else

The player renders MIDI itself, in the browser, from recorded samples of single
notes. How good a hymn sounds is therefore capped by how good those recordings
are, and nothing in the note-handling code can lift that ceiling.

A previous round of work fixed the note handling and it is now correct: the
sustain pedal is read, organ-family instruments hold each note into the next
chord the way an organist does, velocity is flattened because pipes have no
touch response, and a convolution reverb supplies the church acoustic. Those
changes are documented in [AUDIT.md](AUDIT.md), defects 21 to 27. The remaining
complaint is the sound of the organ itself.

The bundled organ comes from the MusyngKite set, which is a general-purpose
General MIDI collection. It is serviceable but it is not a recording of a real
pipe organ. Free SoundFonts that genuinely are, such as hedOrgan, exist and are
considerably better. The player cannot read `.sf2` directly, hence this job.

## The target format, exactly

Each instrument is one JavaScript file at `src/soundfonts/<key>-mp3.js`. The key
must match `[A-Za-z0-9_]+`. Verified structure, taken from the current files:

```javascript
if (typeof(MIDI) === 'undefined') var MIDI = {};
if (typeof(MIDI.Soundfont) === 'undefined') MIDI.Soundfont = {};
MIDI.Soundfont.church_organ = {
"A0": "data:audio/mp3;base64,//uQZAAAAAAAAAAA…",
"Bb0": "data:audio/mp3;base64,…",
…
"C8": "data:audio/mp3;base64,…",

}
```

Facts confirmed against `src/soundfonts/church_organ-mp3.js`:

| | |
|---|---|
| Entries | 88, A0 through C8, the full piano compass |
| Accidentals | Flats: `Bb`, `Db`, `Eb`, `Gb`, `Ab` |
| Each value | A complete MP3 file, base64-encoded, as a `data:` URI |
| Sample length | 3.13 seconds |
| Channels | Genuine stereo, not dual mono |
| File size | About 3 MB per instrument |

The player's parser accepts sharps as well as flats, so either naming works, but
match the existing files unless there is a reason not to.

A note on that: the parser originally accepted sharps only, which silently
discarded 36 of the 88 samples and resampled every black note from a neighbour.
That is fixed, but it is why the note-name convention is worth getting right.

## Constraints the player imposes

Read `src/js/soundfont.js` and `src/js/midi-engine.js` before starting. The
constraints that actually bite:

**Samples must sustain, not decay.** The player plays a note one-shot for as
long as the note lasts. If the recording dies away after a second, so does the
note, and a held chord collapses. The current organ samples hold between 53% and
100% of peak across their full 3.13 seconds. Render the new ones with the key
held down for the whole duration.

**Memory is the real limit.** One decoded instrument is about 100 MB of PCM once
the browser has expanded it, and `MAX_RESIDENT_INSTRUMENTS` in
`src/js/soundfont.js` is 2, so the player's ceiling is roughly 200 MB. Sample
length and channel count scale that directly. Doubling the sample to 6 seconds
doubles the memory. These machines are old parish PCs; treat 100 MB per
instrument as a budget, not a target to exceed.

**Looping is conditional.** The player loops the region between 55% and 95% of a
sample, but only when a note outlasts the recording and the instrument is a
sustaining one. A steady, loopable back half therefore matters. Avoid a
recorded release tail at the end of the sample, because looping across it
produces an audible dip.

**The group name drives the musical behaviour.** In `generate_manifest.py`, add
an entry to the `INSTRUMENTS` dictionary as `key: (label, group, use)`:

```python
"hed_pipe_organ": ("Pipe Organ", "Organ", "Hymns, entrance and recessional"),
```

The group must be exactly `Organ`. `SUSTAINING_GROUPS` in
`src/js/midi-engine.js` keys off it to decide that this instrument flattens
velocity and holds notes into the next chord. Get the group wrong and the
instrument will be voiced as though it were a piano.

Instruments not listed in that dictionary still appear, under "Other", with a
title-cased name. That fallback is fine for experiments and wrong for a
shipped instrument.

## Candidate sources

None of these has been auditioned. Listen before committing to one.

| Source | Notes |
|---|---|
| hedOrgan, hedsound.com | Free, sf2 and sf3, well regarded, actively maintained |
| Jeux Pipe Organ | Long-standing free pipe organ SoundFont |
| Steffan's Cathedral Pipe Organ | Free, cathedral character |
| jOrgan sets, familjenpalo.se/vpo/sf2 | Several instruments, sf2 downloads |

**Check the licence before anything else.** This project is MIT and
redistributes its samples inside the installer, so the licence has to permit
redistribution. The existing samples are MIT via gleitz/midi-js-soundfonts and
that is recorded in `LICENSE`. Add the new one's terms there too. If a promising
SoundFont turns out to be non-redistributable, say so and stop rather than
shipping it.

## Conversion pipeline

The reference implementation is the generator in
[gleitz/midi-js-soundfonts](https://github.com/gleitz/midi-js-soundfonts), which
drives FluidSynth and an encoder. Read it before writing anything; matching its
output exactly is the safest route.

The shape of the work:

1. For each MIDI note 21 to 108, render the note through the SoundFont with the
   key held for the full sample length, then released, capturing a little of the
   release.
2. Trim, and normalise consistently across notes so the set is internally even.
3. Encode each to MP3.
4. Base64-encode and emit the JavaScript file above.

**None of the tooling is installed on this machine.** Checked: `fluidsynth`,
`ffmpeg` and `ffprobe` are all absent. Expect to install them, or to do the
rendering in Python with a library that can read `.sf2` directly. Confirm the
approach works on one note before rendering 88.

Write the converter as a script in `tools/`, committed, so the next instrument
does not need this worked out again. It is not part of the application and must
not be bundled by `build/parish_music_player.spec`.

## Decisions to make

Recommendations, not instructions. Each is a judgement call.

**Which stops.** A pipe organ SoundFont usually contains several presets:
diapason, flute, reed, full organ. Rendering two or three as separate
instruments is more useful to a parish than one compromise. A quiet flute stop
for Communion and a full organ for the recessional is exactly the kind of choice
the per-track instrument picker exists to serve.

**Sample length.** 3 seconds matches the existing set and the memory budget.
Longer only helps if notes routinely outlast it, which with hymn writing they do
not.

**Stereo or mono.** Mono halves the memory. The current samples are genuinely
stereo and downmixing them was tested and rejected because it narrows the sound.
For a new set it is an open choice: measure the width before deciding.

**MP3 bitrate.** Match the existing files unless there is a reason. Higher
bitrate does not change decoded memory, only download size.

## How to verify it worked

Run the player from source and drive it from the browser console. There is a
support hook, `window.parishPlayer`, exposing `{ player, settings, controls, ui }`.

```bash
python app.py --browser --port 8801
```

Then in the console, with your new instrument key:

```javascript
const p = window.parishPlayer.player;
p.context();
const samples = await p.soundfonts.load('hed_pipe_organ');
const { SoundfontLibrary } = await import('./js/soundfont.js');

// 1. Every sample decoded, and every note has its own recording.
let exact = 0, worst = 0;
for (let n = 36; n <= 96; n++) {
  const s = SoundfontLibrary.nearestSample(samples, n);
  const d = Math.abs(s.midi - n);
  if (d === 0) exact++;
  if (d > worst) worst = d;
}

// 2. Memory, against the ~100 MB budget.
let bytes = 0;
for (const s of samples) bytes += s.buffer.length * s.buffer.numberOfChannels * 4;

({ decoded: samples.length, exact, worstResamplingSemitones: worst,
   memoryMB: +(bytes / 1048576).toFixed(0) });
```

Expect 88 decoded, 61 of 61 exact, worst distance 0, and memory near 100 MB.

Then confirm the samples sustain rather than decay:

```javascript
const s = samples.find(x => x.midi === 60);
const d = s.buffer.getChannelData(0), sr = s.buffer.sampleRate;
const frame = Math.floor(sr * 0.05), env = [];
for (let i = 0; i + frame < d.length; i += frame) {
  let sum = 0;
  for (let k = i; k < i + frame; k++) sum += d[k] * d[k];
  env.push(Math.sqrt(sum / frame));
}
const peak = Math.max(...env);
env.map(v => Math.round(100 * v / peak));   // should stay high, not trend to zero
```

Finally, listen. Load a real hymn, set its instrument to the new organ, and A/B
it against `church_organ`. Test files known to exercise the awkward cases live in
`C:\Users\John\Desktop\Hymns 6th Easter` and
`C:\Users\John\Desktop\2nd Sunday Easter B`. They are Clavinova recordings, full
of sustain pedal and Yamaha system-exclusive data, and they were the files that
exposed most of the defects in AUDIT.md. Copy them somewhere under `src/` to
serve them over the dev server, and delete the copies afterwards.

**The judgement is by ear.** The measurements above prove the file is correct.
They cannot tell you whether the organ sounds good, and the reason for doing this
work at all is that the current one does not sound good enough.

## Done when

- One or more organ instruments in `src/soundfonts/`, each about 3 MB
- Entries added to `INSTRUMENTS` in `generate_manifest.py`, group `Organ`
- Licence checked and recorded in `LICENSE`
- Converter committed under `tools/` with a note on how to run it
- Verification above passing, and an A/B listen that is clearly better
- `.\build\build.ps1` still produces a working executable
- A short section added to [AUDIT.md](AUDIT.md) recording what was chosen and why

## Out of scope

Do not change the note handling. The voicing, pedal handling, harmony-aware
holding, levelling and reverb were all arrived at by measurement against real
files and are documented in AUDIT.md. If the new samples seem to want different
treatment, measure first and record the evidence, exactly as those entries do.

Do not attempt to embed a full virtual pipe organ. Hauptwerk and GrandOrgue
exist and are far beyond what a browser sample player should attempt. The aim
here is a better sample set in the format the player already understands.

## Orientation

```
src/index.html          two tabs: Player for the service, Setup for everything else
src/js/player.js        transport, state machine, fades, auto-advance, levelling
src/js/midi-parser.js   MIDI parsing, sustain pedal, tempo map
src/js/midi-engine.js   voicing, note scheduling, offline loudness measurement
src/js/soundfont.js     instrument loading, decoding, the resident cache
src/js/reverb.js        generated church impulse response
src/js/loudness.js      RMS and peak measurement, normalisation gain
generate_manifest.py    builds soundfonts/manifest.json, holds instrument metadata
app.py                  local server and embedded WebView2 window
build/                  PyInstaller spec, build script, Inno Setup installer
docs/AUDIT.md           every defect found so far and how each was verified
docs/PACKAGING.md       building the executable and installer
```

Run from source with `python app.py`, add `--browser` to use the default browser
instead of the app window, and `--debug` for a log at
`%LOCALAPPDATA%\ParishMusicPlayer\player.log`.
