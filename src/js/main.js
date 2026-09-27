/**
 * Application entry point: builds the pieces and wires them together.
 */

import { Settings } from './settings.js';
import { Player, State } from './player.js';
import { Controls, Intent, describeKey } from './controls.js';
import { UI } from './ui.js';

const $ = id => document.getElementById(id);

// On an iPhone or iPad, Web Audio counts as incidental sound by default and is
// silenced by the ring/silent switch, so the online player would play nothing
// on a phone left on silent in church. Declaring it playback, as a music app
// is, keeps it audible. Only Safari has this; elsewhere it is skipped.
try {
  if (navigator.audioSession) navigator.audioSession.type = 'playback';
} catch (e) {}

const settings = new Settings();
const player = new Player(settings);
const ui = new UI(player, settings);

// -- Settings controls --------------------------------------------------------

/**
 * Bind a range input to a setting.
 * @param {string} id                    input element id
 * @param {string} key                   property on Settings
 * @param {(v:number)=>string} format    label text
 * @param {(v:number)=>void} [apply]     extra work while dragging
 * @param {()=>void} [commit]            work to do once, on release
 */
function bindRange(id, key, format, apply, commit) {
  const input = $(id);
  const label = $(id + 'Val');
  input.value = settings[key];
  label.textContent = format(settings[key]);

  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    settings[key] = v;
    label.textContent = format(v);
    if (apply) apply(v);
  });
  input.addEventListener('change', () => {
    settings.save();
    if (commit) commit();
  });
}

function bindCheckbox(id, key, commit) {
  const input = $(id);
  input.checked = settings[key];
  input.addEventListener('change', () => {
    settings[key] = input.checked;
    settings.save();
    if (commit) commit();
  });
}

// Levelling and note release are read when a track starts, so a change applies
// from the next track with no reloading. MIDI levels are re-measured quietly.
let remeasureTimer = null;
const scheduleRemeasure = () => {
  clearTimeout(remeasureTimer);
  remeasureTimer = setTimeout(() => player.remeasureAll().catch(() => {}), 400);
};

bindRange('fadeDur', 'fadeSeconds', v => v.toFixed(1) + 's');
bindRange('holdThresh', 'holdThresholdMs', v => v + 'ms');
bindRange('masterVol', 'masterVolume', v => Math.round(v * 100) + '%', v => player.setMasterVolume(v));
bindRange('releaseMult', 'releaseMultiplier', v => v.toFixed(1) + 'x', null, scheduleRemeasure);

// The acoustic is a send, not part of the measured signal, so changing it needs
// no re-measurement and takes effect on the next note.
bindRange('reverbAmount', 'reverbAmount', v => Math.round(v * 100) + '%');
bindRange('reverbSeconds', 'reverbSeconds', v => v.toFixed(1) + 's', null,
          () => player.setReverbSeconds(settings.reverbSeconds));

bindCheckbox('sustainLoop', 'sustainLoop', scheduleRemeasure);
bindCheckbox('dropPercussion', 'dropPercussion', () => {
  ui.setStatus('Reload your MIDI files to apply', player.state);
});
bindCheckbox('mediaKeys', 'mediaKeys', () => {
  if (settings.mediaKeys) controls.enableMediaKeys();
});

// -- Appearance ---------------------------------------------------------------

/**
 * Apply a colour scheme.
 *
 * Only the attribute changes; both schemes live in app.css as two sets of
 * custom properties, so nothing here knows what either one looks like.
 */
const SCHEMES = ['white', 'parchment', 'blue'];

function applyTheme(name) {
  const scheme = SCHEMES.includes(name) ? name : SCHEMES[0];
  document.documentElement.dataset.theme = scheme;
  for (const btn of document.querySelectorAll('.scheme-btn[data-scheme]')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.scheme === scheme));
  }
}

// The two wide layouts share a prefix on purpose: app.css matches the rules
// they have in common on `[data-layout^="wide"]`, so the anchored one is a
// variation rather than a second copy.
const LAYOUTS = ['wide', 'wide-anchored', 'standard'];

function applyLayout(name) {
  const layout = LAYOUTS.includes(name) ? name : LAYOUTS[0];
  document.documentElement.dataset.layout = layout;
  for (const btn of document.querySelectorAll('.scheme-btn[data-layout]')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.layout === layout));
  }
}

applyTheme(settings.theme);
applyLayout(settings.layout);

for (const btn of document.querySelectorAll('.scheme-btn[data-scheme]')) {
  btn.addEventListener('click', () => {
    settings.theme = btn.dataset.scheme;
    settings.save();
    applyTheme(settings.theme);
  });
}
for (const btn of document.querySelectorAll('.scheme-btn[data-layout]')) {
  btn.addEventListener('click', () => {
    settings.layout = btn.dataset.layout;
    settings.save();
    applyLayout(settings.layout);
  });
}

$('midiInst').addEventListener('change', async e => {
  const previous = settings.instrument;
  settings.instrument = e.target.value;
  settings.save();
  try {
    await player.defaultInstrumentChanged(previous);
    ui.showSoundfontWarning(false);
  } catch (err) {
    ui.showSoundfontWarning(true);
  }
});

// -- Files --------------------------------------------------------------------

ui.el.fileIn.addEventListener('change', async e => {
  const files = e.target.files;
  if (files && files.length) await player.loadFiles(files);
  e.target.value = '';               // allows re-selecting the same files later
});

// Dropping files onto the window loads them too.
['dragover', 'drop'].forEach(type => {
  window.addEventListener(type, e => {
    if (!e.dataTransfer || !e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    if (type === 'drop' && e.dataTransfer.files.length) {
      ui.showPlayerTab();
      player.loadFiles(e.dataTransfer.files);
    }
  });
});

// -- Transport controls -------------------------------------------------------

const controls = new Controls({
  button: $('mainBtn'),
  holdBar: $('holdBar'),
  settings,
  isSounding: () => player.isSounding,
  onIntent: intent => {
    if (intent === Intent.TRIGGER) player.play();
    else if (intent === Intent.FADE) player.fadeOut();
    else if (intent === Intent.PANIC) player.stop({ advance: true });
    else if (intent === Intent.NUDGE) player.nudge();
    acknowledge();
  },
});

/** Flash the button so every press is visibly received, acted on or not. */
const mainBtn = $('mainBtn');
function acknowledge() {
  mainBtn.classList.remove('pressed');
  void mainBtn.offsetWidth;            // restart the animation
  mainBtn.classList.add('pressed');
}
mainBtn.addEventListener('animationend', () => mainBtn.classList.remove('pressed'));

player.on('change', p => controls.setMediaPlaybackState(p.isSounding));

// -- Clicker teaching ---------------------------------------------------------

function renderKeyMap(map = controls.keyMap()) {
  const show = codes => codes.length ? codes.map(describeKey).join(', ') : 'none set';
  $('keysPlay').textContent = show(map.trigger);
  $('keysFade').textContent = show(map.fade);
}

for (const button of document.querySelectorAll('.learn-btn[data-learn]')) {
  button.addEventListener('click', () => {
    for (const b of document.querySelectorAll('.learn-btn[data-learn]')) {
      b.classList.remove('listening');
      b.textContent = 'Learn';
    }
    button.classList.add('listening');
    button.textContent = 'Press a key…';
    controls.learnKey(button.dataset.learn, map => {
      button.classList.remove('listening');
      button.textContent = 'Learn';
      renderKeyMap(map);
    });
  });
}
$('resetKeys').addEventListener('click', () => renderKeyMap(controls.resetKeys()));
renderKeyMap();

// -- Start --------------------------------------------------------------------

if (settings.mediaKeys) {
  // Media-key registration needs a user gesture on some platforms, so arm it on
  // the first interaction rather than at load.
  const arm = () => {
    controls.enableMediaKeys();
    window.removeEventListener('pointerdown', arm);
    window.removeEventListener('keydown', arm);
  };
  window.addEventListener('pointerdown', arm);
  window.addEventListener('keydown', arm);
}

// Build the audio graph and decode the first instrument on the first
// interaction with the window, well before anyone presses play. Browsers will
// not start an audio context without a gesture, so this is the earliest
// possible moment; doing it here keeps the press-to-sound delay near zero.
const warm = () => {
  player.warmUp();
  window.removeEventListener('pointerdown', warm);
  window.removeEventListener('keydown', warm);
};
window.addEventListener('pointerdown', warm);
window.addEventListener('keydown', warm);

ui.loadInstruments().then(() => ui.render());
ui.render();

// -- Diagnostics --------------------------------------------------------------

setInterval(() => {
  if ($('panelSetup').hidden) return;
  const midi = player.midi;
  const track = player.currentTrack;
  $('dState').textContent = player.state;
  $('dClock').textContent = player.ctx ? player.ctx.currentTime.toFixed(1) : '—';
  $('dNodes').textContent = midi ? midi.sources.length : '0';
  $('dSched').textContent = midi ? midi.scheduledCount : '0';
  $('dTotal').textContent = midi && midi.schedule ? midi.schedule.notes.length : '0';
  $('dLate').textContent = midi ? midi.lateCount : '0';
  $('dGain').textContent = track ? player.gainFor(track).toFixed(2) + 'x' : '—';
  $('dRms').textContent = track && track.measured ? track.measured.rms.toFixed(4) : '—';
  $('dResident').textContent = player.soundfonts ? (player.soundfonts.resident.join(', ') || 'none') : '—';
}, 400);

// Support hook. Modules have their own scope, so without this there is no way
// to inspect a misbehaving player from the developer console on a parish PC,
// and no way for the test suite to drive the transport.
window.parishPlayer = { player, settings, controls, ui, State };

// Warn on close only while music is actually playing.
window.addEventListener('beforeunload', e => {
  if (player.state === State.PLAYING || player.state === State.FADING) {
    e.preventDefault();
    e.returnValue = '';
  }
});
