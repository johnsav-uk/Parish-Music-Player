"""
Build a player soundfont from one preset of an SF2 file.

    python tools/build_sf2.py Maggoth2.sf2 --key magnificent_gothic --out src/soundfonts

Writes `<key>-mp3.js`: 88 notes, A0 to C8, in the format `src/js/soundfont.js`
loads, exactly as `build_soundfont.py` does for a GrandOrgue set. The sustained
sample, the placement of the player's loop, the level and the MP3 encoding are
all that script's, imported rather than repeated; only the reading differs.

What is honoured
----------------
Enough of the SF2 specification for a sampled instrument of the ordinary kind,
which is what a single-preset bank like Maggoth2 is:

  - key ranges, so each note uses the recording the bank's author meant for it;
  - the root key (the zone's override, else the sample's own), coarse and fine
    tuning and scale tuning, so every note lands where fluidsynth would put it;
  - the sample's loop points, which become the steady tail of each note;
  - initial attenuation, as a level difference between zones;
  - pan, which is how an SF2 stores a stereo recording: a left and a right
    sample in two zones panned hard apart.

What is not
-----------
Envelopes, filters, LFOs and effects sends. The player has its own attack,
release and church acoustic, applied to every instrument alike, so taking the
bank's as well would apply them twice.

Velocity layers
---------------
The player holds one recording per note and gets louder or quieter by gain
alone, so one layer has to be chosen, with `--velocity`. For a piano that
choice is the tone of the instrument: a string struck gently has far less of
the upper harmonics that make a hard-struck one sound bright, and turning a
loud recording down does not take them away. A soft layer is how to get a
softer piano, not a quieter one.

Sustained or struck
-------------------
An organ recording is built into a note that holds, with a loop the player can
repeat (`build_soundfont.render_note`). A piano recording should instead just
decay, so `--one-shot` takes it as recorded, trimmed to the player's sample
length with a short fade. The player never loops a struck instrument.

Licence
-------
The output inherits the licence of the SF2 it was made from. Check it before
shipping: the player redistributes its samples inside the installer.
"""

from __future__ import annotations

import argparse
import struct
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from grandorgue_reader import SAMPLE_RATE, Recording, find_ffmpeg            # noqa: E402
from build_soundfont import (HIGHEST, LOWEST, TOTAL_FRAMES, emit_js,        # noqa: E402
                             encode_mp3, measure_loop_window, render_note,
                             set_gain)

# Generator numbers, from the SF2 2.04 specification, section 8.1.2.
GEN_PAN = 17
GEN_INSTRUMENT = 41
GEN_KEY_RANGE = 43
GEN_VEL_RANGE = 44
GEN_ATTENUATION = 48
GEN_COARSE_TUNE = 51
GEN_FINE_TUNE = 52
GEN_SAMPLE_ID = 53
GEN_SCALE_TUNING = 56
GEN_ROOT_KEY = 58

RANGE_GENS = (GEN_KEY_RANGE, GEN_VEL_RANGE)
VELOCITY = 100


# --------------------------------------------------------------------------
# Reading the file
# --------------------------------------------------------------------------

@dataclass
class Sample:
    name: str
    start: int
    end: int
    loop_start: int
    loop_end: int
    rate: int
    root: int
    correction: int                # cents
    rom: bool


@dataclass
class Zone:
    gens: dict = field(default_factory=dict)

    def range(self, gen: int) -> tuple[int, int]:
        v = self.gens.get(gen)
        return (0, 127) if v is None else (v & 0xFF, v >> 8)

    def signed(self, gen: int, default: int = 0) -> int:
        v = self.gens.get(gen)
        if v is None:
            return default
        return v - 0x10000 if v >= 0x8000 else v


class SoundFont:
    def __init__(self, path: str):
        self.data = Path(path).read_bytes()
        if self.data[:4] != b"RIFF" or self.data[8:12] != b"sfbk":
            raise ValueError("%s is not an SF2 file" % path)

        lists = {}
        for cid, p, ln in self._chunks(12, len(self.data)):
            if cid == b"LIST":
                lists[self.data[p:p + 4]] = (p + 4, p + ln)
        sdta, pdta = lists[b"sdta"], lists[b"pdta"]

        self.smpl = None
        for cid, p, ln in self._chunks(*sdta):
            if cid == b"smpl":
                self.smpl = np.frombuffer(self.data, dtype="<i2", count=ln // 2, offset=p)
        if self.smpl is None:
            raise ValueError("no 16-bit sample data")

        sub = {cid: (p, ln) for cid, p, ln in self._chunks(*pdta)}

        def records(name: bytes, size: int):
            p, ln = sub[name]
            return [self.data[p + i:p + i + size] for i in range(0, ln, size)]

        def text(raw: bytes) -> str:
            return raw.split(b"\0")[0].decode("latin-1").strip()

        self.presets = [(text(r[:20]),) + struct.unpack("<HHH", r[20:26]) for r in records(b"phdr", 38)]
        self.pbag = [struct.unpack("<HH", r) for r in records(b"pbag", 4)]
        self.pgen = [struct.unpack("<HH", r) for r in records(b"pgen", 4)]
        self.insts = [(text(r[:20]), struct.unpack("<H", r[20:22])[0]) for r in records(b"inst", 22)]
        self.ibag = [struct.unpack("<HH", r) for r in records(b"ibag", 4)]
        self.igen = [struct.unpack("<HH", r) for r in records(b"igen", 4)]

        self.samples = []
        for r in records(b"shdr", 46)[:-1]:
            s, e, ls, le, rate, root, corr, _link, kind = struct.unpack("<IIIIIBbHH", r[20:46])
            self.samples.append(Sample(text(r[:20]), s, e, ls, le, rate, root, corr,
                                       rom=bool(kind & 0x8000)))

    def _chunks(self, p: int, end: int):
        while p + 8 <= end:
            cid = self.data[p:p + 4]
            ln = struct.unpack("<I", self.data[p + 4:p + 8])[0]
            yield cid, p + 8, ln
            p += 8 + ln + (ln & 1)

    def _zones(self, bags, gens, first: int, last: int) -> tuple[Zone | None, list[Zone]]:
        """(global zone or None, other zones) for one preset or instrument."""
        zones = [Zone({op: amt for op, amt in gens[bags[b][0]:bags[b + 1][0]]})
                 for b in range(first, last)]
        terminal = GEN_INSTRUMENT if gens is self.pgen else GEN_SAMPLE_ID
        if zones and terminal not in zones[0].gens:
            return zones[0], zones[1:]
        return None, zones

    def preset_index(self, bank: int, program: int) -> int:
        for i, (_name, prog, b, _bag) in enumerate(self.presets[:-1]):
            if prog == program and b == bank:
                return i
        raise KeyError("no preset at bank %d program %d" % (bank, program))

    def voices(self, preset: int, key: int, velocity: int = VELOCITY):
        """(sample, merged instrument generators, merged preset generators) sounding *key*.

        Instrument generators replace the instrument's global zone; preset
        generators are added on top, as the specification says.
        """
        p_first, p_last = self.presets[preset][3], self.presets[preset + 1][3]
        p_global, p_zones = self._zones(self.pbag, self.pgen, p_first, p_last)
        for pz in p_zones:
            if not _covers(pz, key, velocity):
                continue
            inst = pz.gens[GEN_INSTRUMENT]
            i_first, i_last = self.insts[inst][1], self.insts[inst + 1][1]
            i_global, i_zones = self._zones(self.ibag, self.igen, i_first, i_last)
            for iz in i_zones:
                if not _covers(iz, key, velocity):
                    continue
                merged = Zone({**(i_global.gens if i_global else {}), **iz.gens})
                preset_gens = Zone({**(p_global.gens if p_global else {}), **pz.gens})
                yield self.samples[iz.gens[GEN_SAMPLE_ID]], merged, preset_gens


def _covers(zone: Zone, key: int, velocity: int) -> bool:
    klo, khi = zone.range(GEN_KEY_RANGE)
    vlo, vhi = zone.range(GEN_VEL_RANGE)
    return klo <= key <= khi and vlo <= velocity <= vhi


# --------------------------------------------------------------------------
# Rendering
# --------------------------------------------------------------------------

def read_sample(sf: SoundFont, sample: Sample, ffmpeg: str, ratio: float) -> Recording:
    """One sample, re-pitched by *ratio* and decoded to stereo at SAMPLE_RATE.

    ffmpeg's resampler does the re-pitching, as in the GrandOrgue reader, rather
    than interpolation here: each recording in a bank like this one covers an
    octave, so most notes are several semitones from their recording.
    """
    pcm = sf.smpl[sample.start:sample.end].astype("<i2").tobytes()
    cmd = [ffmpeg, "-hide_banner", "-loglevel", "error",
           "-f", "s16le", "-ar", str(sample.rate), "-ac", "1", "-i", "pipe:0",
           "-af", "asetrate=%d,aresample=%d" % (max(1, round(sample.rate * ratio)), SAMPLE_RATE),
           "-f", "f32le", "-acodec", "pcm_f32le", "-ac", "2", "-ar", str(SAMPLE_RATE), "pipe:1"]
    out = subprocess.run(cmd, input=pcm, capture_output=True, check=True).stdout
    audio = np.frombuffer(out, dtype="<f4").reshape(-1, 2).astype(np.float32)

    scale = (SAMPLE_RATE / sample.rate) / ratio
    length = sample.end - sample.start
    # Banks often put the loop end a frame or two past the data; clamp it.
    loop_start = min(max(0, sample.loop_start - sample.start), length)
    loop_end = min(max(0, sample.loop_end - sample.start), length)
    return Recording(audio=audio,
                     loop_start=int(loop_start * scale),
                     loop_end=min(int(loop_end * scale), len(audio)),
                     release=len(audio))


def pitch_ratio(sample: Sample, inst: Zone, preset: Zone, key: int) -> float:
    """Playback rate for *key*, following the SF2 pitch rules fluidsynth uses."""
    root = inst.signed(GEN_ROOT_KEY, -1)
    if root < 0:
        root = sample.root
    scale = inst.signed(GEN_SCALE_TUNING, 100) + preset.signed(GEN_SCALE_TUNING, 0)
    coarse = inst.signed(GEN_COARSE_TUNE) + preset.signed(GEN_COARSE_TUNE)
    fine = inst.signed(GEN_FINE_TUNE) + preset.signed(GEN_FINE_TUNE)
    cents = (key - root) * scale + coarse * 100 + fine + sample.correction
    return 2.0 ** (cents / 1200.0)


ONE_SHOT_FADE = 0.25                 # seconds, the end of a trimmed struck note


def render_one_shot(rec: Recording, total: int) -> np.ndarray:
    """A struck note as recorded, trimmed to *total* frames and faded out."""
    out = np.zeros((total, 2), dtype=np.float32)
    n = min(total, len(rec.audio))
    out[:n] = rec.audio[:n]
    fade = int(ONE_SHOT_FADE * SAMPLE_RATE)
    if n > total - fade:
        out[total - fade:] *= np.cos(np.linspace(0.0, np.pi / 2, fade, dtype=np.float32))[:, None]
    lead = min(64, n)
    out[:lead] *= np.linspace(0.0, 1.0, lead, dtype=np.float32)[:, None]
    return out


def channel_gains(inst: Zone, preset: Zone) -> np.ndarray:
    """Left and right gain for a zone's pan, -500 hard left to +500 hard right.

    Linear, so a stereo pair panned hard apart lands one sample in each channel
    at full level, and a centred mono sample reaches both at full level too.
    """
    pan = max(-500, min(500, inst.signed(GEN_PAN) + preset.signed(GEN_PAN)))
    return np.array([min(1.0, (500 - pan) / 500.0), min(1.0, (500 + pan) / 500.0)],
                    dtype=np.float32)


def build(sf: SoundFont, preset: int, ffmpeg: str, start: int, chunk: int,
          velocity: int = VELOCITY, one_shot: bool = False) -> dict:
    notes = {}
    for key in range(LOWEST, HIGHEST + 1):
        layers = []
        for sample, inst, pre in sf.voices(preset, key, velocity):
            if sample.rom:
                continue                     # lives in a sound card's ROM, not the file
            rec = read_sample(sf, sample, ffmpeg, pitch_ratio(sample, inst, pre, key))
            attenuation = inst.signed(GEN_ATTENUATION) + pre.signed(GEN_ATTENUATION)
            gain = 10.0 ** (-attenuation / 200.0)          # centibels
            audio = (render_one_shot(rec, TOTAL_FRAMES) if one_shot
                     else render_note(rec, TOTAL_FRAMES, start, chunk))
            layers.append(audio * gain * channel_gains(inst, pre))
        if layers:
            notes[key] = np.sum(layers, axis=0)
    return notes


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("sf2", help="the .sf2 file")
    ap.add_argument("--key", required=True,
                    help="instrument key, which names the output file and the entry in generate_manifest.py")
    ap.add_argument("--bank", type=int, default=0)
    ap.add_argument("--program", type=int, default=0)
    ap.add_argument("--velocity", type=int, default=VELOCITY,
                    help="which velocity layer to take, 1-127 (default %d)" % VELOCITY)
    ap.add_argument("--one-shot", action="store_true",
                    help="struck instrument: take each note as recorded instead of building a held note")
    ap.add_argument("--out", default="src/soundfonts", help="output directory")
    ap.add_argument("--quality", type=int, default=5,
                    help="libmp3lame VBR quality, 0 best to 9 smallest (default 5)")
    args = ap.parse_args(argv)

    started = time.time()
    ffmpeg = find_ffmpeg()
    sf = SoundFont(args.sf2)
    preset = sf.preset_index(args.bank, args.program)
    print("%s: preset '%s', velocity %d%s" % (Path(args.sf2).name, sf.presets[preset][0],
                                               args.velocity, ", one-shot" if args.one_shot else ""))

    start, chunk, delay, decoded = measure_loop_window(ffmpeg, args.quality)
    notes = build(sf, preset, ffmpeg, start, chunk, args.velocity, args.one_shot)
    if not notes:
        print("  nothing to build: every zone uses ROM samples or the preset is empty")
        return 1

    scale = set_gain(notes)
    entries = {m: encode_mp3(ffmpeg, a * scale, args.quality) for m, a in notes.items()}
    text = emit_js(args.key, entries)

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / ("%s-mp3.js" % args.key)
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text)
    print("  %s: %d notes, %.1f MB, %.0fs"
          % (path, len(entries), len(text) / 1048576, time.time() - started))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
