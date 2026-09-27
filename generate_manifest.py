"""
Build soundfonts/manifest.json so the player can list the instruments actually
present on disk.

Run automatically by app.py at every launch, and usable on its own:

    python generate_manifest.py [soundfonts-directory]

Changes from the original: the soundfont directory is an argument rather than a
constant relative to this file (the packaged build serves from a different
location), the file is written as UTF-8 explicitly rather than in the machine's
ANSI code page, and the write is atomic so a crash part-way cannot leave the
player with a truncated manifest it refuses to parse.
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

SUFFIX = "-mp3.js"

# Instrument metadata.
#
# "group" lets the player show a grouped dropdown rather than one flat list, and
# "use" is the plain-English hint a volunteer reads when choosing per track.
# Anything not listed still appears, under "Other", with a title-cased name, so
# dropping a new soundfont into the folder needs no code change.
INSTRUMENTS = {
    # The three Bureå instruments come first because they are recordings of a
    # real pipe organ and the General MIDI organs below them are not. Each is
    # one registration of the same instrument, which is the choice an organist
    # actually makes: what to draw for this piece.
    "pipe_organ":           ("Pipe Organ",        "Organ",            "Hymns, entrance and recessional"),
    "pipe_organ_full":      ("Pipe Organ (Full)", "Organ",            "Louder, for a last verse or recessional"),
    "pipe_organ_flute":     ("Pipe Organ (Flute)", "Organ",           "One quiet stop, for Communion"),
    # From Maggoth2.sf2, the soundfont this parish's VLC is set to. It holds
    # only this one instrument, so VLC plays every MIDI file with it, the
    # Clavinova piano hymns included. Built with tools/build_sf2.py.
    "magnificent_gothic":   ("Magnificent Gothic", "Organ",           "Soft pipe organ, the sound VLC plays"),
    "church_organ":         ("Church Organ",      "Organ",            "General MIDI organ, plainer"),
    "reed_organ":           ("Reed Organ",        "Organ",            "Smaller, softer than a pipe organ"),
    "drawbar_organ":        ("Drawbar Organ",     "Organ",            "Lighter parish-hall organ"),
    "rock_organ":           ("Rock Organ",        "Organ",            "Bolder, for modern settings"),
    "percussive_organ":     ("Percussive Organ",  "Organ",            "Bright attack"),
    # The three FreePats pianos, each built from the soft velocity layers of
    # its recording (tools/build_sf2.py), so they are warmer in tone rather than
    # merely quieter. Measured against the General MIDI piano below, the soft
    # grand and the upright carry roughly 40% less brightness.
    "soft_grand_piano":     ("Soft Grand Piano",  "Piano and Keys",   "Warm, gently played grand"),
    "upright_piano":        ("Upright Piano",     "Piano and Keys",   "Mellow, like a parish hall piano"),
    "yamaha_grand_piano":   ("Yamaha Grand Piano", "Piano and Keys",  "Clear concert grand"),
    "acoustic_grand_piano": ("Grand Piano",       "Piano and Keys",   "Brighter General MIDI piano"),
    "bright_acoustic_piano":("Bright Piano",      "Piano and Keys",   "Clearer, carries further"),
    "harpsichord":          ("Harpsichord",       "Piano and Keys",   "Baroque settings"),
    "celesta":              ("Celesta",           "Piano and Keys",   "Delicate, bell-like"),
    "choir_aahs":           ("Choir Aahs",        "Voices",           "Meditative, Communion"),
    "voice_oohs":           ("Voice Oohs",        "Voices",           "Softer than Choir Aahs"),
    "synth_choir":          ("Synth Choir",       "Voices",           "Smooth choral pad"),
    "string_ensemble_1":    ("Strings",           "Strings and Harp", "Warm, general purpose"),
    "string_ensemble_2":    ("Strings (slow)",    "Strings and Harp", "Slower swell, reflective"),
    "orchestral_harp":      ("Harp",              "Strings and Harp", "Communion, Marian hymns"),
    "flute":                ("Flute",             "Wind and Brass",   "Gentle melody line"),
    "pan_flute":            ("Pan Flute",         "Wind and Brass",   "Breathy, reflective"),
    "trumpet":              ("Trumpet",           "Wind and Brass",   "Easter, festal occasions"),
    "french_horn":          ("French Horn",       "Wind and Brass",   "Warm, processional"),
    "brass_section":        ("Brass Section",     "Wind and Brass",   "Bold, festal"),
    "tubular_bells":        ("Tubular Bells",     "Bells",            "Angelus, Advent, bell effects"),
    "accordion":            ("Accordion",         "Other",            "Folk settings"),
    "pad_2_warm":           ("Warm Pad",          "Other",            "Quiet underlay"),
}

# The order groups appear in. Organ first: it is what most hymns want.
GROUP_ORDER = ["Organ", "Piano and Keys", "Voices", "Strings and Harp",
               "Wind and Brass", "Bells", "Other"]

def describe(key: str) -> tuple[str, str, str]:
    """(label, group, use) for an instrument key, with a sensible fallback."""
    if key in INSTRUMENTS:
        return INSTRUMENTS[key]
    return (key.replace("_", " ").title(), "Other", "")


def scan(directory: Path) -> list[dict]:
    if not directory.is_dir():
        return []

    found = {}
    for entry in sorted(directory.iterdir()):
        if entry.is_file() and entry.name.endswith(SUFFIX):
            key = entry.name[: -len(SUFFIX)]
            if re.fullmatch(r"[A-Za-z0-9_]+", key):
                found[key] = entry.name

    entries = []
    for key, filename in found.items():
        label, group, use = describe(key)
        entries.append({"key": key, "label": label, "group": group,
                        "use": use, "file": filename})

    def sort_key(e):
        group_rank = GROUP_ORDER.index(e["group"]) if e["group"] in GROUP_ORDER else len(GROUP_ORDER)
        # Within a group, keep the curated order from INSTRUMENTS, then alphabetical.
        keys = list(INSTRUMENTS)
        own_rank = keys.index(e["key"]) if e["key"] in INSTRUMENTS else len(keys)
        return (group_rank, own_rank, e["label"])

    return sorted(entries, key=sort_key)


def write_manifest(directory: Path) -> list[dict]:
    """Write manifest.json into *directory*. Returns the instrument list."""
    directory = Path(directory)
    instruments = scan(directory)
    if not directory.is_dir():
        return instruments

    target = directory / "manifest.json"
    tmp = directory / "manifest.json.tmp"
    payload = json.dumps({"instruments": instruments}, indent=2, ensure_ascii=False)
    tmp.write_text(payload + "\n", encoding="utf-8")
    os.replace(tmp, target)          # atomic on Windows and POSIX
    return instruments


def main(argv: list[str]) -> int:
    directory = Path(argv[1]) if len(argv) > 1 else Path(__file__).resolve().parent / "src" / "soundfonts"
    instruments = write_manifest(directory)
    if not instruments:
        print(f"No soundfonts found in {directory}")
        return 1
    print(f"Manifest written: {len(instruments)} instrument(s)")
    group = None
    for inst in instruments:
        if inst["group"] != group:
            group = inst["group"]
            print(f"  [{group}]")
        print(f"    {inst['label']:<20} {inst['use']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
