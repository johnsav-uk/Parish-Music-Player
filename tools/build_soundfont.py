"""
Build a player soundfont from a GrandOrgue sample set.

    python tools/build_soundfont.py BureaChurch.orgue --out src/soundfonts

Writes one `<key>-mp3.js` per recipe below: 88 notes, A0 to C8, each a complete
MP3 encoded as a base64 `data:` URI, which is the format
`src/js/soundfont.js` loads.

Why this exists
---------------
The player renders MIDI from recordings of single notes, so the ceiling on how
a hymn sounds is the recordings themselves. A GrandOrgue sample set is a real
organ recorded pipe by pipe, which is a far better source than a general MIDI
collection, but its shape is wrong for this player in three ways, and the whole
of this script is about those three.

**One file per key, not per pitch.** A rank's folder holds one recording per
key, already at that stop's pitch: under a 4' stop, the file named for key 36
sounds an octave above key 36. So a stop plays straight, and stacking stops is
just addition: Principal 8' plus Oktava 4' plus Oktava 2' plus Mixtur is what an
organist draws for a hymn, and summing those four recordings is what it sounds
like.

**Short recordings with loop points.** A pipe is recorded for a few seconds and
made to last by repeating a marked region. The player instead plays a sample
one-shot for as long as the note lasts, so the sample itself has to already be a
sustained note of the right length, built by repeating that region here.

**A recorded release on the end.** The player applies its own release. A
recorded one left on the end of the sample would be looped over, which dips
audibly, so everything from the release cue onwards is discarded.

The loop the player will make
-----------------------------
When a note outlasts the recording, `midi-engine.js` loops the region between
55% and 95% of the sample. Rather than leave that to chance, the tail here is
one seamless chunk laid down so that its start falls at 55% and its end at 95%,
which makes the player's loop a loop of something built to be looped.

Two things make that awkward, and both are handled.

MP3 shifts everything. The encoder prepends its own delay and pads the end to a
whole frame, so the decoded sample is neither the length nor the alignment of
what went in. The offset is the same for every note of a given length, so it is
measured once, by encoding and decoding a test signal, and the chunk is then
placed where it will land after the round trip. The player runs in WebView2,
whose decoder is the same FFmpeg that measures it here.

The chunk ends by crossfading into the frames that come just before it starts,
which is what makes the wrap continuous. Rounding the chunk to a whole number of
the note's own cycles would put that crossfade in phase and avoid any combing,
but it was measured and rejected: rounding moves the wrap by up to half a cycle,
and half a cycle at the wrap is the loudest discontinuity available, heard on
every repeat. Exact placement wins, and the crossfade uses an equal-power curve,
which holds the level steady when the two stretches happen to be out of phase.

Licence
-------
The sample set and this script's output inherit the set's licence. The Bureå
church set is CC BY-SA 2.5 Sweden, which requires attribution and share-alike;
see LICENSE. Check before converting any other set.
"""

from __future__ import annotations

import argparse
import base64
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from grandorgue_reader import SAMPLE_RATE, Pipe, SampleSet, find_ffmpeg   # noqa: E402


# --------------------------------------------------------------------------
# Shape of the output
# --------------------------------------------------------------------------

# 3.19 seconds, matching the bundled MusyngKite samples. One decoded instrument
# is then about 100 MB of PCM, and `soundfont.js` keeps two resident, so the
# player's footprint stays near the 200 MB these old parish machines can spare.
# Longer samples buy nothing: hymn writing does not hold a chord past three
# seconds often enough to pay for the memory.
#
# Every note is this same length, which is what lets one measurement of the MP3
# round trip serve the whole set.
TOTAL_FRAMES = 140544

# Where the player loops, from `midi-engine.js`.
LOOP_LO, LOOP_HI = 0.55, 0.95

# Long enough to close the loop smoothly, short enough that any combing between
# the two stretches it blends passes before the ear settles on it.
CROSSFADE_SECONDS = 0.040

# Level of the finished set, as the mean RMS of its 88 notes, with the peak of
# the loudest note capped below full scale. Notes keep their recorded level
# relative to each other, so the compass stays as even as the organ itself is.
#
# The number is measured from the bundled church_organ, and matching it is not
# cosmetic. `player.js` measures a track's loudness in the background and gives
# a track gain of 1 until that finishes, so the very first play of any hymn runs
# at the sample's own level. A set normalised to full scale is four times hotter
# than the ones already bundled, and that first play clips.
TARGET_RMS = 0.030
PEAK_CEILING = 0.95

LOWEST, HIGHEST = 21, 108                      # A0 to C8

NOTE_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]


def note_name(midi: int) -> str:
    """MIDI number to the flat spelling the bundled soundfonts use."""
    return "%s%d" % (NOTE_NAMES[midi % 12], midi // 12 - 1)


# --------------------------------------------------------------------------
# Recipes
# --------------------------------------------------------------------------

@dataclass
class Layer:
    """One rank sounding as part of an instrument.

    `key_shift` is added to the target note to pick the recording, which is how
    the bottom of the compass is covered. The manual ranks stop at key 36, but
    the pedal Subbas 16' recorded for key 36 sounds an octave lower, so below
    36 the layers shift up by twelve and the 16' rank carries the unison while
    the pedal 8' and 4' sit above it. That is a real pedal registration, not a
    resampling trick, and it keeps the bottom octave sounding like the organ.
    """
    folder: str
    gain: float = 1.0
    key_shift: int = 0
    lo: int = LOWEST
    hi: int = HIGHEST


# The pedal 16/8/4 that covers everything below the manual compass.
def _pedal_bottom(gain: float) -> list:
    return [
        Layer("PEDSubbas16",   gain * 1.00, key_shift=12, hi=35),
        Layer("PEDPrincipal8", gain * 0.55, key_shift=12, hi=35),
        Layer("PEDOktava4",    gain * 0.30, key_shift=12, hi=35),
    ]


RECIPES = {
    # Principal 8' and Oktava 4': the registration an organist reaches for
    # first, and the one most hymns want. Warm, carries a congregation, and
    # does not tire over four verses.
    "pipe_organ": [
        Layer("HVPrincipal8", 1.00, lo=36),
        Layer("HVOktava4",    0.85, lo=36),
    ] + _pedal_bottom(1.0),

    # The full plenum, principal chorus crowned by the Mixtur. For a
    # recessional, and for the last verse. The Mixtur is held back from its
    # recorded level: it is voiced for a stone church, and the player adds its
    # own reverb on top.
    "pipe_organ_full": [
        Layer("HVPrincipal8", 1.00, lo=36),
        Layer("HVOktava4",    0.90, lo=36),
        Layer("HVOktava2",    0.70, lo=36),
        Layer("HVMixtur",     0.55, lo=36),
        Layer("HVTrumpet8",   0.45, lo=36),
    ] + _pedal_bottom(1.0),

    # A single stopped flute. Quiet enough to accompany Communion without
    # covering the singing, which is what the Gedakt is for on the real organ.
    "pipe_organ_flute": [
        Layer("HVGedakt8", 1.00, lo=36),
    ] + [Layer("PEDSubbas16", 1.00, key_shift=12, hi=35)],
}


# --------------------------------------------------------------------------
# Building one sustained sample
# --------------------------------------------------------------------------

def _reader(rec):
    """A function giving *n* frames from any position, looping where it must.

    The recording is finite and ends in a release that must not be used, so
    positions past the usable end wrap through the marked loop. The set's author
    chose those marks to join seamlessly, which is why the wrap needs no
    crossfade of its own.
    """
    audio = rec.audio
    end = rec.sustain_end
    if rec.has_loop and rec.loop_end <= end:
        loop_start, loop_end = rec.loop_start, rec.loop_end
    else:
        # No usable marks: manufacture a loop from the last second before the
        # release, which for a pipe is steady state anyway.
        loop_end = end
        loop_start = max(0, end - SAMPLE_RATE)
    period = max(1, loop_end - loop_start)

    def take(start: int, n: int) -> np.ndarray:
        idx = np.arange(start, start + n)
        past = idx >= loop_end
        idx[past] = loop_start + (idx[past] - loop_start) % period
        np.clip(idx, 0, len(audio) - 1, out=idx)
        return audio[idx]

    return take


def render_note(rec, total: int, start: int, chunk: int) -> np.ndarray:
    """A sustained sample of *total* frames whose tail repeats every *chunk*.

    Laid out so the player's own loop is seamless:

        0                     start            start+chunk        total
        |-- attack, as recorded --|--- one seamless chunk ---|- its head -|
                                 55%                       95%

    The chunk ends by crossfading back into the frames immediately before it
    begins, so playing it end to end and jumping back to its start is
    continuous. Whatever follows 95% is the head of the same chunk, so a note
    that is not long enough to loop still runs on smoothly.
    """
    take = _reader(rec)
    head = take(0, start)

    fade = min(int(CROSSFADE_SECONDS * SAMPLE_RATE), chunk // 3)
    body = take(start, chunk).copy()
    if fade > 0:
        before = take(start - fade, fade)
        angle = np.linspace(0.0, np.pi / 2, fade, dtype=np.float32)[:, None]
        body[chunk - fade:] = (body[chunk - fade:] * np.cos(angle)
                               + before * np.sin(angle))

    tail = body[:max(0, total - start - chunk)]
    out = np.concatenate([head, body, tail])[:total]

    # A pipe recording starts at the attack, but guard against a click if a
    # sample happens to begin mid-waveform.
    lead = min(64, len(out))
    out[:lead] *= np.linspace(0.0, 1.0, lead, dtype=np.float32)[:, None]
    return out


# --------------------------------------------------------------------------
# Building one instrument
# --------------------------------------------------------------------------

def pick_pipe(sample_set, stop, key):
    """The recording for *key*, or the nearest one, and the shift needed.

    Preference order: the stop's own pipe, because the definition file carries
    its measured tuning and trim; then any extra recording in the rank folder,
    since folders usually hold more pipes than the stop's compass, cut so the
    couplers have something to sound; and only then the nearest pipe resampled,
    which is the one case where a note is not a recording of itself.
    """
    if key in stop.pipes:
        return stop.pipes[key], 0

    extra = sample_set.pipes_in_folder(stop.folder)
    if key in extra:
        return Pipe(path=extra[key], key=key), 0

    nearest = min(stop.pipes, key=lambda k: (abs(k - key), k))
    pipe = stop.pipes[nearest]
    return pipe, key - pipe.key


def measure_loop_window(ffmpeg: str, quality: int) -> tuple:
    """Where the player's 55%-to-95% loop lands in the signal fed to the encoder.

    MP3 prepends the encoder's delay and pads the tail to a whole frame, so the
    sample the browser decodes is longer than the one built here and offset
    inside it. Both are fixed for a given input length and encoder setting, so
    measuring them once with noise, which correlates sharply, places the loop
    for every note in the set.
    """
    rng = np.random.default_rng(0)
    probe = (rng.standard_normal((TOTAL_FRAMES, 2)) * 0.2).astype(np.float32)
    decoded = decode_mp3(ffmpeg, encode_mp3(ffmpeg, probe, quality))

    window = 1 << 14
    a = probe[:window, 0].astype(np.float64)
    b = decoded[:window * 2, 0].astype(np.float64)
    corr = np.correlate(b - b.mean(), a - a.mean(), mode="valid")
    delay = int(np.argmax(corr))

    start = int(round(LOOP_LO * len(decoded))) - delay
    end = int(round(LOOP_HI * len(decoded))) - delay
    return start, end - start, delay, len(decoded)


def build_instrument(sample_set, layers, start, chunk_target, progress=None):
    """Every note of one instrument, as float arrays, before normalisation."""
    notes = {}
    for midi in range(LOWEST, HIGHEST + 1):
        active = [l for l in layers if l.lo <= midi <= l.hi]
        if not active:
            continue

        rendered = []
        for layer in active:
            stop = sample_set.by_folder[layer.folder]
            pipe, shift = pick_pipe(sample_set, stop, midi + layer.key_shift)
            ratio = 2.0 ** ((shift * 100.0 + pipe.cents) / 1200.0)
            rec = sample_set.read_pipe(pipe.path, ratio)
            gain = layer.gain * stop.amplitude * pipe.amplitude
            rendered.append(render_note(rec, TOTAL_FRAMES, start, chunk_target) * gain)

        notes[midi] = np.sum(rendered, axis=0)
        if progress:
            progress(midi, notes[midi])
    return notes


def set_gain(notes: dict) -> float:
    """One gain for the whole set: the same level as the soundfonts it joins.

    Applied to every note equally, never note by note, because the differences
    between notes are the organ's own and flattening them would be wrong.
    """
    mean_rms = float(np.mean([np.sqrt(np.mean(a.astype(np.float64) ** 2))
                              for a in notes.values()]))
    scale = TARGET_RMS / mean_rms if mean_rms else 1.0
    peak = max(float(np.abs(a).max()) for a in notes.values())
    return min(scale, PEAK_CEILING / peak) if peak else scale


def encode_mp3(ffmpeg: str, audio: np.ndarray, quality: int) -> bytes:
    """One note as an MP3 file.

    Variable bitrate, joint stereo, 44.1 kHz: the same shape as the bundled
    soundfonts. Bitrate changes the download only, never the decoded footprint,
    so it is chosen for how the organ sounds rather than for the file size.
    """
    pcm = np.clip(audio, -1.0, 1.0).astype("<f4").tobytes()
    cmd = [ffmpeg, "-hide_banner", "-loglevel", "error",
           "-f", "f32le", "-ar", str(SAMPLE_RATE), "-ac", "2", "-i", "pipe:0",
           "-c:a", "libmp3lame", "-q:a", str(quality), "-joint_stereo", "1",
           "-f", "mp3", "pipe:1"]
    return subprocess.run(cmd, input=pcm, capture_output=True, check=True).stdout


def decode_mp3(ffmpeg: str, data: bytes) -> np.ndarray:
    """An MP3 back to float frames, as the browser's decoder will hear it."""
    cmd = [ffmpeg, "-hide_banner", "-loglevel", "error",
           "-f", "mp3", "-i", "pipe:0",
           "-f", "f32le", "-acodec", "pcm_f32le",
           "-ac", "2", "-ar", str(SAMPLE_RATE), "pipe:1"]
    out = subprocess.run(cmd, input=data, capture_output=True, check=True).stdout
    return np.frombuffer(out, dtype="<f4").reshape(-1, 2)


def emit_js(key: str, entries: dict) -> str:
    """The soundfont file itself, in the MIDI.js format the player loads."""
    lines = ["if (typeof(MIDI) === 'undefined') var MIDI = {};",
             "if (typeof(MIDI.Soundfont) === 'undefined') MIDI.Soundfont = {};",
             "MIDI.Soundfont.%s = {" % key]
    for midi in sorted(entries):
        b64 = base64.b64encode(entries[midi]).decode("ascii")
        lines.append('"%s": "data:audio/mp3;base64,%s",' % (note_name(midi), b64))
    lines.append("")
    lines.append("}")
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("sampleset", help=".orgue package or extracted directory")
    ap.add_argument("--out", default="src/soundfonts", help="output directory")
    ap.add_argument("--only", action="append", help="build just this recipe (repeatable)")
    ap.add_argument("--quality", type=int, default=5,
                    help="libmp3lame VBR quality, 0 best to 9 smallest (default 5)")
    args = ap.parse_args(argv)

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    ffmpeg = find_ffmpeg()

    sample_set = SampleSet(args.sampleset)
    print("%s: %d stops" % (Path(args.sampleset).name, len(sample_set.stops)))

    start, chunk_target, delay, decoded = measure_loop_window(ffmpeg, args.quality)
    print("  round trip: %d frames in, %d out, %d frames of encoder delay"
          % (TOTAL_FRAMES, decoded, delay))
    print("  player will loop decoded %d..%d, so built %d..%d"
          % (start + delay, start + chunk_target + delay, start, start + chunk_target))

    for key, layers in RECIPES.items():
        if args.only and key not in args.only:
            continue
        missing = [l.folder for l in layers if l.folder not in sample_set.by_folder]
        if missing:
            print("  skipping %s, sample set has no %s" % (key, ", ".join(missing)))
            continue

        started = time.time()
        print("  %s ..." % key, end="", flush=True)
        notes = build_instrument(sample_set, layers, start, chunk_target)

        scale = set_gain(notes)
        entries = {m: encode_mp3(ffmpeg, a * scale, args.quality)
                   for m, a in notes.items()}

        text = emit_js(key, entries)
        path = out_dir / ("%s-mp3.js" % key)
        # newline="" so the file keeps the LF endings the bundled soundfonts
        # use, rather than picking up CRLF from the platform.
        with open(path, "w", encoding="utf-8", newline="") as f:
            f.write(text)
        print(" %d notes, %.1f MB, %.0fs"
              % (len(entries), len(text) / 1048576, time.time() - started))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
