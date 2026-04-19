# Parish-Music-Player
A player to help play various music files in a mass situation (or similar)
Parish Music Player
A free, open-source music player designed specifically for Catholic and Christian parish churches. Plays both standard audio files (MP3, WAV, OGG, FLAC) and MIDI files from a single playlist, with simple one-button control designed to work with a Bluetooth presentation clicker.
Free for all parishes.

Features

Audio and MIDI support — plays MP3, WAV, OGG, FLAC and MIDI files from the same playlist
Single button control — short press to play, hold to fade out, double-tap to stop instantly
Presentation clicker support — right arrow plays, left arrow fades
Automatic normalisation — balances volume between tracks so nothing jumps out unexpectedly
Drag and drop playlist — reorder tracks on the fly
MIDI instrument selection — 7 bundled instruments including Church Organ, Choir Aahs, Strings and more
Organ-style sustain — MIDI notes ring naturally rather than cutting off
Beautiful liturgical design — deep navy and gold, works in light and dark mode
Completely free — no subscriptions, no ads, no data collection


Screenshots
Coming soon

Getting Started
Requirements

Windows PC (Windows 10 or 11)
Chrome or Edge browser
Internet connection for first-time setup only

Installation

Download the latest release from the Releases page
Unzip the folder anywhere on your PC (Desktop, Documents, etc.)
Double-click SETUP.bat — this downloads a small Python runtime (~15MB) needed to run the player. You only need to do this once.
From then on, just double-click Launch.vbs to start the player


Note: Windows may show a security warning when running the setup files. Click "More info" then "Run anyway" — this is normal for software downloaded from the internet that hasn't been signed with a commercial certificate.


How to Use
Loading music

Click + Load audio / MIDI files
Hold Ctrl to select multiple files at once
Files are sorted alphabetically — name them to control the order:

  01 - Entrance Hymn.mp3
  02 - Kyrie.mid
  03 - Gloria.mp3
  04 - Offertory.mp3
  05 - Agnus Dei.mid
Controls
ActionButtonKeyboardClickerPlay current trackShort pressSpace or →Right arrowFade out and stopHoldHold SpaceLeft arrowInstant stopDouble-tapDouble Space—
Settings
SettingDescriptionFade durationHow long the fade takes (default 3 seconds)Hold thresholdHow long to hold before fade triggers (default 600ms)Master volumeOverall loudnessNormalisationBalances volume between tracks — reload files after adjustingNote releaseHow long MIDI notes ring on — increase if notes sound clippedMIDI instrumentWhich instrument plays MIDI files (Church Organ recommended)

Adding More Instrument Sounds
The player comes with 7 bundled instruments. You can add more by downloading soundfont files from:
https://gleitz.github.io/midi-js-soundfonts/MusyngKite/
Save the .js file into the soundfonts/ folder inside the player folder, then restart the player. The new instrument will appear automatically in the instrument list.

Troubleshooting
Player won't start
Run SETUP.bat again. If it still doesn't work, make sure you have Chrome or Edge installed.
Music too loud or too quiet between tracks
Adjust the Normalisation slider in Settings, then reload your files.
MIDI sounds clipped or notes cut off too soon
Increase the Note release slider in Settings.
MIDI sounds out of tune or distorted
Try a different MIDI instrument in Settings. Church Organ works best for most hymn files.
Presentation clicker not working
Most clickers send arrow keys — make sure the player window is selected (click on it first). If yours sends Page Up/Page Down instead of arrow keys, please raise an issue and we can add support.

For Developers
The player is built entirely with vanilla HTML, CSS and JavaScript — no frameworks, no build tools. The MIDI parser and soundfont synthesiser are written from scratch and embedded directly in index.html.
The Python component is only used to serve the files via a local HTTP server (required for Chrome's security model). The actual player logic is pure browser JavaScript.
Pull requests are welcome!

Licence
MIT Licence — free to use, modify and distribute. See LICENSE for details.

Acknowledgements

Soundfonts from gleitz/midi-js-soundfonts
Logo designed with Google Gemini
Built with the assistance of Claude by Anthropic
