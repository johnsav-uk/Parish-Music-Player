# tools/

Off-line tools for preparing what the player ships. None of this is part of the
application and none of it is bundled by `build/parish_music_player.spec`, which
collects only `src/`.

```bash
python -m pip install -r tools/requirements.txt
```

## build_soundfont.py

Converts a GrandOrgue sample set into the soundfont files `src/js/soundfont.js`
loads. See the docstring at the top of the script for how it works and why.

```bash
python tools/build_soundfont.py BureaChurch.orgue --out src/soundfonts
```

The sample set is a `.orgue` package or a directory extracted from one. The
instruments it produces, and the ranks each one draws, are the `RECIPES`
dictionary in the script; add an entry there to add an instrument.

The source used for the three pipe organ instruments now in `src/soundfonts/` is
the Bureå church set, 780 MB, from
<http://familjenpalo.se/vpo/download/>. It is CC BY-SA 2.5 Sweden. **Check the
licence of any other set before converting it**: the player redistributes its
samples inside the installer, so a set that cannot be redistributed cannot be
used, however good it sounds.

## render_ab.js

Renders the same hymn through two instruments so they can be compared by ear.
It runs in the player's own engine, so what comes out is what the congregation
would hear, reverb and organ voicing included. See the comment at the top of the
file for how to run it.

## build_sf2.py

Converts one preset of an SF2 soundfont into the same format, reusing
`build_soundfont.py` for the looping, level and encoding.

```bash
python tools/build_sf2.py "C:\Program Files\VideoLAN\VLC\Maggoth2.sf2" --key magnificent_gothic
```

Then add the key to `INSTRUMENTS` in `generate_manifest.py` for its name, group
and hint.

`magnificent_gothic` was made this way from `Maggoth2.sf2`, the soundfont VLC is
set to use on the parish PC. It is a 1995 Sound Blaster AWE32 bank with no
author or copyright recorded in the file. **Its licence is unknown**, so find
out whether it may be redistributed before it goes out in an installer.

The three FreePats pianos were built from their soft velocity layers, as
one-shots, from the SF2 downloads on
<https://freepats.zenvoid.org/Piano/acoustic-grand-piano.html>:

```bash
python tools/build_sf2.py SalamanderGrandPiano-V3+20200602.sf2 --key soft_grand_piano   --velocity 50 --one-shot
python tools/build_sf2.py UprightPianoKW-20220221.sf2          --key upright_piano      --velocity 64 --one-shot
python tools/build_sf2.py YDP-GrandPiano-20160804.sf2          --key yamaha_grand_piano --velocity 64 --one-shot
```

Salamander and YDP are CC BY 3.0 and Upright KW is CC0; the credits are in
`LICENSE`.
