/**
 * Settings, persisted to a file by the launcher, with localStorage as a copy.
 *
 * The original kept every setting in the DOM and re-read slider values deep
 * inside the audio scheduler. Holding them here means the audio code has no
 * opinion about the user interface, and a volunteer's preferences survive a
 * restart, so the player comes up on Sunday exactly as it was left.
 */

import { DEFAULT_TRIGGER_CODES, DEFAULT_FADE_CODES } from './controls.js';

const KEY = 'parish-music-player/settings/v4';

/**
 * The launcher (app.py) keeps the settings in a file, because localStorage
 * alone never survived a restart: it belongs to an origin, the origin includes
 * the port, and the port is new on every launch.
 *
 * The read is synchronous on purpose. It is one small request to a server on
 * the same machine, and everything that follows, from the colour scheme to the
 * default instrument, needs the answer before it can draw anything.
 *
 * When the page is served by something else, such as a plain development
 * server, the request fails and localStorage carries on as before.
 */
const FILE_URL = 'settings';

function readFile() {
  try {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', FILE_URL, false);
    xhr.send();
    if (xhr.status !== 200) return null;
    const parsed = JSON.parse(xhr.responseText);
    return parsed && typeof parsed === 'object' && Object.keys(parsed).length ? parsed : null;
  } catch (e) {
    return null;
  }
}

function writeFile(json) {
  try {
    fetch(FILE_URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Parish-Player': '1' },
      body: json,
      keepalive: true,            // still delivered if the window is closing
    }).catch(() => {});
  } catch (e) {}
}

const DEFAULTS = {
  fadeSeconds: 3.0,
  holdThresholdMs: 600,
  doublePressMs: 400,
  masterVolume: 1.0,
  releaseMultiplier: 2.0,
  instrument: 'church_organ',
  // Church acoustic applied to MIDI. This is what makes an organ sound
  // sustained; see reverb.js. Recorded audio is left alone, as it carries the
  // acoustic of wherever it was recorded.
  reverbAmount: 0.38,
  reverbSeconds: 2.6,
  sustainLoop: true,
  dropPercussion: true,
  mediaKeys: true,
  // 'white', 'parchment' or 'blue'. White is the default because it is the
  // plainest and needs no decision from a volunteer who never opens Setup.
  // index.html reads this key directly, before the modules load, so the player
  // does not flash the wrong scheme on the way up.
  theme: 'white',
  // 'wide', 'wide-anchored' or 'standard'. Wide is the default: it fits a whole
  // service and the Play button on one screen, and both wide layouts fall back
  // to the tall column by themselves on anything narrower than 900px, so any of
  // the three is safe on any monitor.
  layout: 'wide',
  // Key codes the clicker sends. Editable from Setup so an unusual remote can
  // be taught rather than reported as a bug.
  triggerKeys: DEFAULT_TRIGGER_CODES,
  fadeKeys: DEFAULT_FADE_CODES,
  // What each hymn was last set to, keyed by its file name in lower case:
  // { "320 hail redeemer": { tempo: 94, instrument: "soft_grand_piano" } }.
  // Only what somebody changed is stored. See Player._remember.
  hymns: {},
};

export class Settings {
  constructor() {
    Object.assign(this, structuredClone(DEFAULTS), this._read());
  }

  _read() {
    try {
      let parsed = readFile();
      if (!parsed) {
        const raw = localStorage.getItem(KEY);
        if (!raw) return {};
        parsed = JSON.parse(raw);
      }
      // Only accept keys we know about, with the type of the default.
      const clean = {};
      for (const k of Object.keys(DEFAULTS)) {
        if (!(k in parsed)) continue;
        const want = DEFAULTS[k], got = parsed[k];
        if (Array.isArray(want)) {
          if (Array.isArray(got) && got.every(v => typeof v === 'string')) clean[k] = got;
        } else if (want && typeof want === 'object') {
          if (got && typeof got === 'object' && !Array.isArray(got)) clean[k] = got;
        } else if (typeof got === typeof want) {
          clean[k] = got;
        }
      }
      return clean;
    } catch (e) {
      return {};
    }
  }

  save() {
    try {
      const out = {};
      for (const k of Object.keys(DEFAULTS)) out[k] = this[k];
      const json = JSON.stringify(out);
      writeFile(json);
      try {
        // Also read by index.html before the modules load, to paint the right
        // colour scheme from the first frame.
        localStorage.setItem(KEY, json);
      } catch (e) {
        // Private browsing or a locked-down profile.
      }
    } catch (e) {}
  }

  reset() {
    Object.assign(this, structuredClone(DEFAULTS));
    this.save();
  }
}
