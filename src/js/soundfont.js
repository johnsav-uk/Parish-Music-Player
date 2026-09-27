/**
 * Soundfont loading for the gleitz / MusyngKite MIDI.js format.
 *
 * Each soundfont file is a ~3 MB script that assigns
 * MIDI.Soundfont[<instrument>] = { "A4": "data:audio/mp3;base64,..." }.
 *
 * Fixes over the original loader:
 *   - Samples decode in parallel rather than one await at a time.
 *   - The raw base64 blob and the injected <script> tag are released once the
 *     samples are decoded, instead of being retained on window forever. The
 *     original leaked roughly 3 MB of base64 plus the decoded PCM for every
 *     instrument the user tried.
 *   - Decoded instruments are held in a small, bounded cache rather than
 *     accumulating. Each track can pick its own instrument, so more than one has
 *     to be resident, but not all of them.
 *   - A sample index sorted by MIDI number supports O(log n) nearest lookup.
 */

const NATURAL = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const NOTE_RE = /^([A-G])([#b]?)(-?\d+)$/;

/**
 * "Eb3" or "D#3" -> MIDI note number.
 *
 * The accidental may be a flat or a sharp. This matters: the bundled
 * MusyngKite soundfonts name every black note with a flat (Bb, Db, Eb, Gb, Ab),
 * and the original accepted sharps only. That silently discarded 36 of the 88
 * recorded samples, so every black note in a hymn was produced by resampling a
 * white-note recording a semitone away — audible as the out-of-tune, slightly
 * wrong-sounding MIDI the troubleshooting notes describe.
 */
function noteNameToMidi(name) {
  const m = NOTE_RE.exec(name);
  if (!m) return null;
  const semitone = NATURAL[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  return (parseInt(m[3], 10) + 1) * 12 + semitone;
}

function base64ToArrayBuffer(dataUrl) {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = () => resolve(el);
    el.onerror = () => { el.remove(); reject(new Error('Soundfont file not found: ' + src)); };
    document.head.appendChild(el);
  });
}

/**
 * How many instruments stay decoded in memory at once.
 *
 * One instrument is roughly 100 MB of PCM once decoded, so this cannot be
 * unbounded now that every track can choose its own.
 *
 * Two is enough, and is chosen over three to keep the footprint near 200 MB on
 * the old machines parishes tend to use. The player only ever needs the track
 * that is sounding and the one queued behind it, it decodes that next one while
 * the current track plays, and the pair in use are protected from eviction. An
 * instrument that does get evicted is reloaded in the background during the
 * previous track, so it costs no delay at the press.
 *
 * The samples are genuinely stereo, not dual mono, so halving this by
 * downmixing would audibly narrow the sound.
 */
const MAX_RESIDENT_INSTRUMENTS = 2;

export class SoundfontLibrary {
  constructor(audioContext, { onProgress = () => {}, maxResident = MAX_RESIDENT_INSTRUMENTS } = {}) {
    this.ctx = audioContext;
    this.onProgress = onProgress;
    this.maxResident = maxResident;
    // Insertion-ordered, so the first key is the least recently used.
    this.cache = new Map();    // name -> samples [{ midi, buffer }]
    this._inflight = new Map();
  }

  /** Instruments currently decoded, most recently used last. */
  get resident() { return [...this.cache.keys()]; }

  _touch(name) {
    const samples = this.cache.get(name);
    if (samples) { this.cache.delete(name); this.cache.set(name, samples); }
    return samples;
  }

  /**
   * Drop instruments back to the resident limit.
   *
   * Measuring a playlist has to decode every instrument it uses, which can push
   * the cache past its limit while the current and next instruments are held
   * protected. Calling this once measuring is done returns the footprint to the
   * steady-state two.
   */
  trim(keep = []) { this._evictIfNeeded(keep); }

  _evictIfNeeded(keep = []) {
    while (this.cache.size > this.maxResident) {
      const oldest = [...this.cache.keys()].find(k => !keep.includes(k));
      if (!oldest) break;
      this.cache.delete(oldest);
    }
  }

  /** MIDI number -> nearest available sample, via binary search. */
  static nearestSample(samples, target) {
    if (!samples.length) return null;
    let lo = 0, hi = samples.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (samples[mid].midi < target) lo = mid + 1; else hi = mid;
    }
    const a = samples[lo], b = samples[Math.max(0, lo - 1)];
    return Math.abs(a.midi - target) <= Math.abs(b.midi - target) ? a : b;
  }

  /**
   * Decoded samples for an instrument, or null if it is not resident.
   * Lets the caller take the zero-latency path without awaiting a promise.
   */
  samplesFor(name) {
    return this._touch(name) || null;
  }

  /**
   * Load an instrument by key (e.g. "church_organ").
   * Resolves to a sorted array of { midi, buffer }.
   *
   * @param {string} name
   * @param {string[]} keep instruments that must not be evicted to make room,
   *                        normally the one currently playing.
   */
  load(name, keep = []) {
    const cached = this._touch(name);
    if (cached) return Promise.resolve(cached);
    if (this._inflight.has(name)) return this._inflight.get(name);

    const job = this._load(name)
      .then(samples => { this._evictIfNeeded([name, ...keep]); return samples; })
      .finally(() => this._inflight.delete(name));
    this._inflight.set(name, job);
    return job;
  }

  async _load(name) {
    const scriptEl = await loadScript(`soundfonts/${name}-mp3.js`);

    const raw = window.MIDI && window.MIDI.Soundfont && window.MIDI.Soundfont[name];
    if (!raw) {
      scriptEl.remove();
      throw new Error('Soundfont data not found for: ' + name);
    }

    const entries = Object.entries(raw);
    let done = 0;
    this.onProgress(0, entries.length);

    const decoded = await Promise.all(entries.map(async ([noteName, dataUrl]) => {
      const midi = noteNameToMidi(noteName);
      if (midi === null) return null;
      try {
        const buffer = await this.ctx.decodeAudioData(base64ToArrayBuffer(dataUrl));
        return { midi, buffer };
      } catch {
        return null;                       // a single bad sample must not fail the set
      } finally {
        this.onProgress(++done, entries.length);
      }
    }));

    // Release the base64 payload and the script element now that we hold PCM.
    delete window.MIDI.Soundfont[name];
    scriptEl.remove();

    const samples = decoded.filter(Boolean).sort((a, b) => a.midi - b.midi);
    if (!samples.length) throw new Error('No usable samples in soundfont: ' + name);

    this.cache.set(name, samples);
    return samples;
  }
}
