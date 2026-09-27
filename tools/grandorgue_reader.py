"""
Reading a GrandOrgue sample set: the organ definition file, and the pipes.

A GrandOrgue sample set is a `.orgue` package (a plain ZIP) or an extracted
directory. Inside it are one `.organ` definition file and a folder of recordings
per rank, named by the key that sounds them:

    HVPrincipal8/036-C.wav
    HVPrincipal8/037-C#.wav

Those names are key numbers, not pitches. The recording under a 4' stop's key 36
already sounds an octave above key 36, because that is the pipe the key opens,
so a stop needs no transposing to play from.

The `.wav` extension is a lie in most sets. The files are WavPack, which carries
the original RIFF header verbatim in a wrapper block, so the loop points and the
release cue can be read straight out of the bytes while the audio itself is
decoded by ffmpeg.

Three things about a pipe recording matter here:

  loop start / loop end   The steady part of the note. A pipe is recorded for a
                          few seconds only, so anything longer is made by
                          repeating this region.
  release cue             Where the recorded release begins. Everything from
                          here on is the note stopping, and must never appear in
                          a sample the player will hold or loop.
  pitch tuning            A per-pipe correction in cents from the definition
                          file. Real pipes are not perfectly in tune and the
                          set's author measured each one.
"""

from __future__ import annotations

import re
import struct
import subprocess
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

SAMPLE_RATE = 44100


# --------------------------------------------------------------------------
# ffmpeg
# --------------------------------------------------------------------------

def find_ffmpeg() -> str:
    """Locate an ffmpeg binary, preferring one on PATH."""
    from shutil import which
    exe = which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError as exc:                              # pragma: no cover
        raise RuntimeError(
            "ffmpeg not found. Install it, or `pip install imageio-ffmpeg`."
        ) from exc


# --------------------------------------------------------------------------
# The organ definition file
# --------------------------------------------------------------------------

@dataclass
class Pipe:
    """One recording, and what the definition file says about it."""
    path: str
    key: int                       # the MIDI key that sounds this pipe
    amplitude: float = 1.0         # per-pipe trim, 1.0 = as recorded
    cents: float = 0.0             # per-pipe tuning correction


@dataclass
class Stop:
    """One drawstop: a rank of pipes, one per key, plus its overall level."""
    name: str
    amplitude: float = 1.0
    pipes: dict = field(default_factory=dict)

    @property
    def folder(self) -> str:
        """The rank folder, which is how a recipe names a stop."""
        first = self.pipes[min(self.pipes)]
        return first.path.split("/")[0]

    def keys(self) -> list:
        return sorted(self.pipes)


_PIPE_RE = re.compile(r"^Pipe(\d+)$")
_PIPE_ATTR_RE = re.compile(r"^Pipe(\d+)(AmplitudeLevel|PitchTuning)$")


def parse_odf(text: str) -> list:
    """Stops, with their pipes, from the text of a `.organ` file.

    Only stops whose pipes are plain file references are returned. Stops built
    out of shared [Rank] sections, and the action, stop and blower noises every
    set carries, are skipped: none of them is a sustained musical note.
    """
    stops = []
    section = None
    section_name = ""

    def flush():
        if section is None or not section_name.startswith("Stop"):
            return
        if "Name" not in section:
            return
        first_key = int(section.get("FirstMidiNoteNumber", 36))
        paths, attrs = {}, {}
        for key, value in section.items():
            m = _PIPE_RE.match(key)
            if m:
                if value.lower().endswith(".wav"):
                    paths[int(m.group(1))] = value.replace("\\", "/")
                continue
            m = _PIPE_ATTR_RE.match(key)
            if m:
                attrs.setdefault(int(m.group(1)), {})[m.group(2)] = float(value)
        if len(paths) < 12:                    # a noise, not a rank
            return
        stop = Stop(section["Name"], float(section.get("AmplitudeLevel", 100)) / 100.0)
        for index, path in paths.items():
            extra = attrs.get(index, {})
            key = first_key + index - 1
            stop.pipes[key] = Pipe(
                path=path,
                key=key,
                amplitude=extra.get("AmplitudeLevel", 100.0) / 100.0,
                cents=extra.get("PitchTuning", 0.0),
            )
        stops.append(stop)

    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith(";"):
            continue
        if line.startswith("["):
            flush()
            section_name = line[1:].split("]")[0]
            section = {}
            continue
        if section is None or "=" not in line:
            continue
        key, _, value = line.partition("=")
        section[key.strip()] = value.strip()
    flush()
    return stops


# --------------------------------------------------------------------------
# The sample set as a whole
# --------------------------------------------------------------------------

class SampleSet:
    """A `.orgue` package or an extracted directory, opened for reading."""

    def __init__(self, source):
        self.source = Path(source)
        self._zip = zipfile.ZipFile(self.source) if self.source.is_file() else None
        if self._zip is not None:
            names = self._zip.namelist()
            self._index = {n.lower(): n for n in names}
            odf = next(n for n in names if n.lower().endswith(".organ"))
            text = self._zip.read(odf).decode("cp1252", "replace")
        else:
            self._index = {}
            for p in self.source.rglob("*"):
                if p.is_file():
                    rel = str(p.relative_to(self.source)).replace("\\", "/")
                    self._index[rel.lower()] = rel
            odf = next(self.source.rglob("*.organ"))
            text = odf.read_text(encoding="cp1252", errors="replace")
        self.odf_text = text
        self.stops = parse_odf(text)
        self.by_folder = {}
        for stop in self.stops:
            self.by_folder.setdefault(stop.folder, stop)
        self._folders = {}
        self._ffmpeg = find_ffmpeg()

    def pipes_in_folder(self, folder: str) -> dict:
        """Every recording in a rank folder, by the key number in its name.

        A rank folder usually holds more pipes than its stop's compass, cut so
        the couplers have something to sound. They are real recordings of real
        pipes, so the top and bottom of the player's 88-note compass are better
        served by reaching for them than by resampling.
        """
        cached = self._folders.get(folder.lower())
        if cached is not None:
            return cached
        found = {}
        prefix = folder.lower() + "/"
        for lower, real in self._index.items():
            if not lower.startswith(prefix) or not lower.endswith(".wav"):
                continue
            stem = real.split("/")[-1].split("-")[0]
            if stem.isdigit():
                found[int(stem)] = real
        self._folders[folder.lower()] = found
        return found

    def read_bytes(self, path: str) -> bytes:
        real = self._index.get(path.lower())
        if real is None:
            raise KeyError(path)
        if self._zip is not None:
            return self._zip.read(real)
        return (self.source / real).read_bytes()

    def read_pipe(self, path: str, ratio: float = 1.0) -> "Recording":
        """Decode one pipe, optionally re-pitched by *ratio* (2.0 = an octave up).

        Re-pitching is done by ffmpeg's resampler rather than by interpolating
        here, because a pipe resampled by a wide interval is exactly where a
        naive interpolator starts to sound gritty, and out-of-range notes are
        the only ones that need it.
        """
        raw = self.read_bytes(path)
        meta = parse_riff_header(raw)

        cmd = [self._ffmpeg, "-hide_banner", "-loglevel", "error",
               "-f", "wv", "-i", "pipe:0"]
        if abs(ratio - 1.0) > 1e-9:
            cmd += ["-af", "asetrate=%d,aresample=%d"
                    % (max(1, round(meta["rate"] * ratio)), SAMPLE_RATE)]
        cmd += ["-f", "f32le", "-acodec", "pcm_f32le",
                "-ac", "2", "-ar", str(SAMPLE_RATE), "pipe:1"]
        out = subprocess.run(cmd, input=raw, capture_output=True, check=True).stdout
        audio = np.frombuffer(out, dtype="<f4").reshape(-1, 2).astype(np.float32)

        # Marks in the RIFF header are in source frames; the decode above is at
        # SAMPLE_RATE and re-pitched, so both have to be folded in.
        scale = (SAMPLE_RATE / meta["rate"]) / ratio
        release = int(meta["release"] * scale) if meta["release"] else len(audio)
        return Recording(
            audio=audio,
            loop_start=int(meta["loop_start"] * scale),
            loop_end=int(meta["loop_end"] * scale),
            release=min(release, len(audio)),
        )


@dataclass
class Recording:
    audio: np.ndarray              # (frames, 2) float32
    loop_start: int
    loop_end: int
    release: int                   # first frame of the recorded release

    @property
    def sustain_end(self) -> int:
        """Last frame that is still the note sounding, not the note stopping."""
        return min(self.release, len(self.audio))

    @property
    def has_loop(self) -> bool:
        return self.loop_end > self.loop_start + 1000


# --------------------------------------------------------------------------
# The RIFF header WavPack keeps a copy of
# --------------------------------------------------------------------------

def parse_riff_header(raw: bytes) -> dict:
    """Sample rate, loop points and release cue from a WavPack or WAV file.

    WavPack stores the source file's RIFF header in a metadata block so the
    original can be reconstructed byte for byte. That block is where GrandOrgue
    keeps the loop (`smpl`) and the release cue (`cue `), and neither survives
    decoding, so it is read from the raw bytes.
    """
    start = raw.find(b"RIFF")
    if start < 0 or raw[start + 8:start + 12] != b"WAVE":
        raise ValueError("no RIFF header found")

    meta = {"rate": SAMPLE_RATE, "loop_start": 0, "loop_end": 0, "release": 0}
    i = start + 12
    while i + 8 <= len(raw):
        cid = raw[i:i + 4]
        size = struct.unpack("<I", raw[i + 4:i + 8])[0]
        body = raw[i + 8:i + 8 + size]
        if cid == b"fmt " and size >= 16:
            meta["rate"] = struct.unpack("<HHIIHH", body[:16])[2]
        elif cid == b"smpl" and size >= 36:
            fields = struct.unpack("<9I", body[:36])
            if fields[7]:
                loop = struct.unpack("<6I", body[36:60])
                meta["loop_start"], meta["loop_end"] = loop[2], loop[3]
        elif cid == b"cue " and size >= 4:
            count = struct.unpack("<I", body[:4])[0]
            positions = [struct.unpack("<6I", body[4 + n * 24:28 + n * 24])[5]
                         for n in range(count)]
            if positions:
                meta["release"] = min(positions)
        elif cid == b"data":
            break
        i += 8 + size + (size & 1)
    return meta
