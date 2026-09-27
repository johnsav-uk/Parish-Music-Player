/**
 * Transport: playlist, playback state machine, fades and auto-advance.
 *
 * State machine
 *   EMPTY    no playlist loaded
 *   READY    a track is queued and armed, waiting for a trigger
 *   LOADING  decoding files or an instrument
 *   PLAYING  audio or MIDI is sounding
 *   FADING   a fade-out is in progress; the track is still sounding
 *
 * After a track ends naturally, is faded out, or is stopped, the next track is
 * queued automatically and the transport returns to READY. That is the
 * waiting-for-trigger state the operator relies on: one click per hymn, with no
 * need to look at the screen.
 *
 * Every playback is stamped with a generation number. Timers and callbacks
 * carry the generation they were created under and do nothing if the transport
 * has moved on. In the original build an in-flight fade timer would fire after
 * the operator had already started a different track, stop it, and advance the
 * playlist, producing silence in the middle of a service.
 *
 * Each playback also builds a fresh gain chain. The original faded a persistent
 * shared MIDI gain node to zero and then reset its value by hand, racing its own
 * automation.
 */

import { parseMidi, midiToSchedule } from './midi-parser.js';
import { SoundfontLibrary } from './soundfont.js';
import { MidiPlayer, measureMidiLoudness, voicingForInstrument } from './midi-engine.js';
import { createChurchImpulse } from './reverb.js';
import { measureLoudestWindow, normalisationGain,
         MAX_BOOST_RECORDED, MAX_BOOST_SYNTHESISED, TARGET_RMS } from './loudness.js';

export const State = {
  EMPTY: 'EMPTY',
  READY: 'READY',
  LOADING: 'LOADING',
  PLAYING: 'PLAYING',
  FADING: 'FADING',
};

export const isMidiName = name => /\.(mid|midi)$/i.test(name);
export const displayName = name => name.replace(/\.[^.]+$/, '');

/** Tempo, as a percentage of the file's own. */
export const TEMPO_MIN = 70;
export const TEMPO_MAX = 130;
const clampTempo = pct => Math.max(TEMPO_MIN, Math.min(TEMPO_MAX, Math.round(pct)));

/**
 * How a hymn is recognised from one service to the next: its file name,
 * without the extension or the case. "320 Hail Redeemer.MID" in this week's
 * folder is the same hymn as in last month's.
 */
const hymnKey = name => displayName(name).trim().toLowerCase();

export class Player {
  constructor(settings) {
    this.settings = settings;
    this.tracks = [];
    this.index = -1;
    this.state = State.EMPTY;
    this.generation = 0;

    this.ctx = null;
    this.masterGain = null;
    this.analyser = null;
    this.soundfonts = null;

    this.chain = null;      // { trackGain, fadeGain, wetGain } for this playback
    this.reverb = null;     // shared convolver, fed by MIDI playback
    this.source = null;     // AudioBufferSourceNode, recorded audio only
    this.midi = null;       // MidiPlayer instance
    this.startedAt = 0;
    this.currentDuration = 0;
    this.fadeTimer = null;

    this.listeners = { change: [], status: [] };
  }

  on(event, fn) { this.listeners[event].push(fn); return this; }
  _emit(event, ...args) { for (const fn of this.listeners[event]) fn(...args); }

  _setState(state, message) {
    this.state = state;
    this._emit('change', this);
    if (message) this._emit('status', message, state);
  }

  // -- Audio graph -----------------------------------------------------------

  context() {
    if (!this.ctx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctor({ latencyHint: 'interactive' });

      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.settings.masterVolume;

      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.75;

      // Everything is metered, so the level bar reflects MIDI as well as audio.
      this.masterGain.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);

      // One shared reverb, built once. Its tail outlives any single playback,
      // which is the point: a chord should decay into the room after the note
      // itself has stopped, exactly as it would in the building.
      this.reverb = this.ctx.createConvolver();
      this.reverb.buffer = createChurchImpulse(this.ctx, this.settings.reverbSeconds);
      this.reverb.connect(this.masterGain);

      this.soundfonts = new SoundfontLibrary(this.ctx, {
        onProgress: (done, total) => {
          // Only while the player is genuinely waiting on the instrument.
          //
          // The same decode also runs in the background, to measure a track's
          // loudness and to warm the next track's instrument, and reporting
          // that overwrote the console's status with "Preparing instrument: 87
          // of 88" and left it there. The player was ready and playable; it
          // looked stuck, which is worse than a wrong number.
          //
          // The count stops one short of the total on purpose: the last update
          // is suppressed so the finished message is whatever the player's own
          // state says, rather than a completion notice nobody needs.
          if (this.state !== State.LOADING) return;
          if (done < total) {
            this._emit('status', 'Preparing instrument: ' + done + ' of ' + total, State.LOADING);
          }
        },
      });
    }
    return this.ctx;
  }

  async resume() {
    const ctx = this.context();
    if (ctx.state === 'suspended') await ctx.resume();
    return ctx;
  }

  /** Rebuild the impulse response after the reverb length is changed. */
  setReverbSeconds(seconds) {
    this.settings.reverbSeconds = seconds;
    if (this.reverb) this.reverb.buffer = createChurchImpulse(this.ctx, seconds);
  }

  setMasterVolume(v) {
    this.settings.masterVolume = v;
    if (this.masterGain) {
      const now = this.ctx.currentTime;
      this.masterGain.gain.cancelScheduledValues(now);
      this.masterGain.gain.setTargetAtTime(v, now, 0.02);   // avoids zipper noise
    }
  }

  /**
   * A fresh, disposable chain: normalisation gain, then fade gain, then out.
   *
   * MIDI additionally feeds the shared reverb. Recorded audio does not: a hymn
   * recorded in a church already carries that church's acoustic, and adding
   * another one on top just smears it.
   */
  _buildChain(trackGainValue, { reverb = false } = {}) {
    const ctx = this.ctx;
    const trackGain = ctx.createGain();
    trackGain.gain.value = trackGainValue;
    const fadeGain = ctx.createGain();
    fadeGain.gain.value = 1;
    trackGain.connect(fadeGain);
    fadeGain.connect(this.masterGain);

    let wetGain = null;
    if (reverb && this.reverb && this.settings.reverbAmount > 0) {
      wetGain = ctx.createGain();
      wetGain.gain.value = this.settings.reverbAmount;
      fadeGain.connect(wetGain);
      wetGain.connect(this.reverb);
    }
    return { trackGain, fadeGain, wetGain };
  }

  _teardownChain() {
    if (!this.chain) return;
    try { this.chain.trackGain.disconnect(); } catch (e) {}
    try { this.chain.fadeGain.disconnect(); } catch (e) {}
    // Only the send is disconnected, never the convolver, so whatever is
    // already in the room is allowed to die away naturally.
    if (this.chain.wetGain) { try { this.chain.wetGain.disconnect(); } catch (e) {} }
    this.chain = null;
  }

  // -- Loading ---------------------------------------------------------------

  async loadFiles(fileList) {
    const files = Array.from(fileList)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    if (!files.length) return;

    this.stop({ advance: false });
    this.tracks = [];
    this.index = -1;
    this._setState(State.LOADING, 'Loading files...');

    await this.resume();

    const skipped = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      this._emit('status', 'Loading ' + (i + 1) + ' of ' + files.length + ': ' + f.name, State.LOADING);
      // Yield so the window keeps repainting through a long playlist.
      await new Promise(r => setTimeout(r, 0));
      try {
        this.tracks.push(isMidiName(f.name) ? await this._loadMidiTrack(f) : await this._loadAudioTrack(f));
      } catch (err) {
        console.warn('Skipping', f.name, err);
        skipped.push(f.name);
      }
    }

    if (!this.tracks.length) {
      this._setState(State.EMPTY, 'No playable files found');
      return;
    }

    this.index = 0;
    this._setState(State.READY, skipped.length
      ? 'Ready - ' + skipped.length + ' file(s) could not be read'
      : 'Ready - press play');

    // Warm the instrument and measure MIDI levels in the background so the
    // first trigger of the service is instant.
    this._prepareMidiLevels().catch(() => {});
  }

  async _loadAudioTrack(file) {
    const buffer = await this.ctx.decodeAudioData(await file.arrayBuffer());
    return {
      name: file.name,
      midi: false,
      buffer,
      measured: measureLoudestWindow(buffer, 10),
      duration: buffer.duration,
    };
  }

  async _loadMidiTrack(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    // Parsed once, at load time. The original re-parsed on every press, which
    // stalled the app at the exact moment the operator clicked.
    const parsed = parseMidi(bytes);
    const schedule = midiToSchedule(parsed, { dropPercussion: this.settings.dropPercussion });
    if (!schedule.notes.length) throw new Error('No notes in MIDI file');

    // What this hymn was set to the last time it was used, if it has been.
    const memo = this._memoFor(file.name);
    const known = key => !this.instrumentGroups || key in this.instrumentGroups;
    const remembered = typeof memo.instrument === 'string' && known(memo.instrument);

    return {
      name: file.name,
      midi: true,
      schedule,
      duration: schedule.duration,
      // Each track chooses its own instrument, so a parish can put the organ
      // on the entrance hymn and a piano on the Communion motet without
      // touching anything during the service. It starts at the default, or at
      // whatever this hymn was last given, and is changed from the playlist row.
      instrument: remembered ? memo.instrument : this.settings.instrument,
      // Chosen for this hymn, so it stays put when the default changes.
      instrumentChosen: remembered,
      tempo: typeof memo.tempo === 'number' ? clampTempo(memo.tempo) : 100,
      measured: null,        // filled in by _prepareMidiLevels
      measuredFor: null,     // instrument the measurement belongs to
    };
  }

  // -- Per-hymn memory -------------------------------------------------------

  _memoFor(name) {
    const all = this.settings.hymns;
    const memo = all && all[hymnKey(name)];
    return memo && typeof memo === 'object' ? memo : {};
  }

  /**
   * Record a choice made for one hymn, so the next service that uses it starts
   * the same way. Anything back at its default is dropped rather than stored,
   * so the file only ever holds what somebody actually changed.
   */
  _remember(track, patch) {
    const key = hymnKey(track.name);
    const memo = { ...this._memoFor(track.name), ...patch };
    if (memo.tempo === 100) delete memo.tempo;
    const hymns = { ...(this.settings.hymns || {}) };
    if (Object.keys(memo).length) hymns[key] = memo;
    else delete hymns[key];
    this.settings.hymns = hymns;
    this.settings.save();
  }

  /**
   * Render each MIDI track offline and measure it, so MIDI files and recorded
   * audio end up on one loudness scale.
   */
  async _prepareMidiLevels() {
    const pending = this.tracks.filter(t => t.midi && t.measuredFor !== t.instrument);
    if (!pending.length) return;

    // Grouped by instrument so each soundfont is decoded once, not once per
    // track that happens to use it.
    const byInstrument = new Map();
    for (const track of pending) {
      if (!byInstrument.has(track.instrument)) byInstrument.set(track.instrument, []);
      byInstrument.get(track.instrument).push(track);
    }

    for (const [instrument, tracks] of byInstrument) {
      let samples;
      try {
        samples = await this.soundfonts.load(instrument, this._instrumentsInUse());
      } catch (err) {
        console.warn('Could not load instrument', instrument, err);
        continue;
      }
      for (const track of tracks) {
        if (track.instrument !== instrument) continue;   // changed while we waited
        try {
          track.measured = await measureMidiLoudness(track.schedule, samples, {
            releaseMult: this.settings.releaseMultiplier,
            sustainLoop: this.settings.sustainLoop,
            voicing: this.voicingFor(track),
          });
          track.measuredFor = instrument;
        } catch (err) {
          console.warn('Could not measure', track.name, err);
        }
        await new Promise(r => setTimeout(r, 0));
      }
    }
    // Measuring may have decoded more instruments than the player needs to keep.
    this.soundfonts.trim(this._instrumentsInUse());
    this._emit('change', this);
  }

  /** Instruments the current and next tracks need; these must not be evicted. */
  _instrumentsInUse() {
    return [this.currentTrack, this.nextTrack]
      .filter(t => t && t.midi)
      .map(t => t.instrument);
  }

  /**
   * Change one track's instrument.
   *
   * The existing level measurement belongs to the old instrument, so it is
   * discarded and redone in the background against the new one.
   */
  setTrackInstrument(index, instrument) {
    const track = this.tracks[index];
    if (!track || !track.midi || track.instrument === instrument) return;
    track.instrument = instrument;
    track.instrumentChosen = true;
    this._remember(track, { instrument });
    track.measured = null;
    track.measuredFor = null;
    this._emit('change', this);
    this._prepareMidiLevels().catch(() => {});
  }

  _measureInBackground(track, samples) {
    const instrument = track.instrument;
    if (track._measuring) return;
    track._measuring = true;
    measureMidiLoudness(track.schedule, samples, {
      releaseMult: this.settings.releaseMultiplier,
      sustainLoop: this.settings.sustainLoop,
      voicing: this.voicingFor(track),
    }).then(measured => {
      track.measured = measured;
      track.measuredFor = instrument;
    }).catch(err => console.warn('Could not measure', track.name, err))
      .finally(() => { track._measuring = false; });
  }

  /**
   * Decode the next track's instrument while this one is playing.
   *
   * This is what keeps the press-to-sound delay near zero across a playlist
   * that changes instrument: by the time the operator presses for the Communion
   * piano, it has already been decoded.
   */
  _warmNext() {
    const next = this.nextTrack;
    if (!next || !next.midi) return;
    if (this.soundfonts.samplesFor(next.instrument)) return;
    this.soundfonts.load(next.instrument, this._instrumentsInUse()).catch(() => {});
  }

  /**
   * Get the audio path ready before anyone presses play.
   *
   * Building and resuming the context is cheap and always worth doing early,
   * because doing it at the first press costs tens of milliseconds.
   *
   * Decoding the instrument is not cheap: one soundfont is about 100 MB of PCM
   * once decoded. That is worth paying the moment a MIDI file is in the
   * playlist, and not at all for a parish that only plays recordings, so it is
   * driven by the playlist rather than done unconditionally at start-up.
   */
  async warmUp() {
    await this.resume();
    const first = this.tracks.find(t => t.midi);
    if (first) await this.soundfonts.load(first.instrument, this._instrumentsInUse()).catch(() => {});
  }

  /**
   * The default instrument changed. Tracks still sitting on the previous
   * default follow it; tracks the operator has deliberately set are left alone.
   */
  async defaultInstrumentChanged(previous) {
    for (const t of this.tracks) {
      if (t.midi && !t.instrumentChosen && t.instrument === previous) {
        t.instrument = this.settings.instrument;
        t.measured = null;
        t.measuredFor = null;
      }
    }
    this._emit('change', this);
    await this._prepareMidiLevels();
  }

  /** A setting that changes rendering moved, so every measurement is stale. */
  async remeasureAll() {
    for (const t of this.tracks) {
      if (t.midi) { t.measured = null; t.measuredFor = null; }
    }
    await this._prepareMidiLevels();
  }

  /**
   * How this track's performance should be adapted to its instrument.
   * The instrument's group comes from the manifest; see midi-engine.js.
   */
  voicingFor(track) {
    const group = this.instrumentGroups ? this.instrumentGroups[track.instrument] : undefined;
    return voicingForInstrument(track.instrument, group);
  }

  gainFor(track) {
    if (!track || !track.measured) return 1;
    const maxBoost = track.midi ? MAX_BOOST_SYNTHESISED : MAX_BOOST_RECORDED;
    return normalisationGain(track.measured, TARGET_RMS, maxBoost);
  }

  /**
   * Set one hymn's tempo, as a percentage of the file's own, and remember it.
   *
   * If that hymn is playing, it changes on the spot: this is the control for a
   * congregation dragging behind the music in the second verse. The same value
   * is what the playlist row shows and what the hymn will start at next time.
   */
  setTrackTempo(index, percent) {
    const track = this.tracks[index];
    if (!track || !track.midi) return;
    const tempo = clampTempo(percent);
    if (tempo === track.tempo) return;
    track.tempo = tempo;
    if (index === this.index && this.midi && this.isSounding) {
      this.midi.setRate(tempo / 100);
      this.startedAt = this.midi.startedAt;
    }
    this._remember(track, { tempo });
    this._emit('change', this);
  }

  /** Playback speed of the current track: 1 as written. MIDI only. */
  get rate() {
    const track = this.currentTrack;
    return track && track.midi ? (track.tempo || 100) / 100 : 1;
  }

  // -- Transport -------------------------------------------------------------

  get currentTrack() { return this.tracks[this.index] || null; }
  get nextTrack() { return this.tracks[this.index + 1] || null; }
  get isSounding() { return this.state === State.PLAYING || this.state === State.FADING; }

  /**
   * Play the armed track.
   *
   * A trigger arriving while something is already sounding is ignored. The
   * original restarted the hymn from the beginning, so one stray clicker press
   * during the entrance procession sent the music back to bar one.
   */
  async play() {
    if (this.isSounding || this.state === State.LOADING) return false;
    if (!this.tracks.length) return false;
    if (this.index < 0) this.index = 0;
    if (this.index >= this.tracks.length) return false;

    const track = this.currentTrack;
    const generation = ++this.generation;
    await this.resume();
    if (generation !== this.generation) return false;    // superseded while awaiting

    // A point chosen on the timeline before pressing play, such as the start
    // of the third verse. It applies to this one playing only.
    const offset = Math.min(track.cue || 0, Math.max(0, track.duration - 0.5));

    try {
      if (track.midi) await this._playMidi(track, generation, offset);
      else this._playAudio(track, generation, offset);
    } catch (err) {
      console.error('Playback failed', err);
      this._setState(State.READY, 'Could not play that track');
      return false;
    }
    return true;
  }

  _playAudio(track, generation, offset = 0) {
    this.chain = this._buildChain(this.gainFor(track));
    this._startAudioSource(track, generation, offset, this.ctx.currentTime);
    this.currentDuration = track.buffer.duration;
    this._setState(State.PLAYING, 'Playing');
    this._warmNext();
  }

  /** Start the recording at `offset` seconds in, sounding at audio-clock time `when`. */
  _startAudioSource(track, generation, offset, when) {
    const src = this.ctx.createBufferSource();
    src.buffer = track.buffer;
    src.connect(this.chain.trackGain);
    src.onended = () => {
      if (generation !== this.generation) return;        // stopped or superseded
      if (src !== this.source) return;                   // replaced by a jump
      this._finish({ advance: true });
    };
    this.source = src;
    this.startedAt = when - offset;
    src.start(when, offset);
  }

  async _playMidi(track, generation, offset = 0) {
    // The instrument is normally already warm, so this resolves immediately and
    // the LOADING state is never seen. It only shows on a genuinely cold start.
    let samples = this.soundfonts.samplesFor(track.instrument);
    if (!samples) {
      this._setState(State.LOADING, 'Preparing instrument...');
      samples = await this.soundfonts.load(track.instrument, this._instrumentsInUse());
      if (generation !== this.generation) return;
    }

    // Deliberately NOT awaited. Measuring means rendering the piece offline,
    // which can take seconds on a modest PC, and making the operator wait for
    // it at the moment they press is far worse than this one track playing at
    // its unlevelled gain. The measurement continues in the background and
    // applies from the next time the track is played.
    if (track.measuredFor !== track.instrument) {
      this._measureInBackground(track, samples);
    }

    this.chain = this._buildChain(this.gainFor(track), { reverb: true });
    this._startMidiPlayer(track, generation, samples, offset, null);
    this.currentDuration = track.schedule.duration;
    this._setState(State.PLAYING, 'Playing (MIDI)');
    this._warmNext();
  }

  _startMidiPlayer(track, generation, samples, offset, at) {
    const midi = new MidiPlayer(this.ctx, this.chain.trackGain);
    midi.onEnded = () => {
      if (generation !== this.generation) return;
      if (midi !== this.midi) return;                    // replaced by a jump
      this._finish({ advance: true });
    };
    this.midi = midi;
    midi.start(track.schedule, samples, {
      releaseMult: this.settings.releaseMultiplier,
      sustainLoop: this.settings.sustainLoop,
      voicing: this.voicingFor(track),
      offset,
      at,
      rate: (track.tempo || 100) / 100,
    });
    this.startedAt = midi.startedAt;
  }

  /**
   * Move to a point in the current track, in seconds.
   *
   * While playing, the music jumps there at once. While the track is armed and
   * waiting, the point is remembered and the next press of play starts there,
   * which is how a verse can be cued before the moment it is needed.
   *
   * The jump dips the level for a few hundredths of a second either side, so
   * cutting into the middle of a waveform does not click.
   */
  seek(seconds) {
    const track = this.currentTrack;
    if (!track) return false;
    const target = Math.max(0, Math.min(seconds, Math.max(0, track.duration - 0.5)));

    if (this.state === State.READY) {
      track.cue = target;
      this._emit('change', this);
      return true;
    }
    if (this.state !== State.PLAYING || !this.chain) return false;

    const DIP = 0.03;
    const now = this.ctx.currentTime;
    const at = now + DIP;
    const g = this.chain.fadeGain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, at);
    g.linearRampToValueAtTime(1, at + DIP);

    if (track.midi) {
      const samples = this.midi && this.midi.samples;
      if (!samples) return false;
      const old = this.midi;
      old.onEnded = null;
      old.stop(at);
      this._startMidiPlayer(track, this.generation, samples, target, at);
    } else {
      const old = this.source;
      if (old) { old.onended = null; try { old.stop(at); } catch (e) {} }
      this._startAudioSource(track, this.generation, target, at);
    }
    this._emit('change', this);
    return true;
  }

  /**
   * Smooth fade to silence over the configured duration, then auto-advance.
   * Calling it again while a fade is running is ignored.
   */
  fadeOut() {
    if (this.state !== State.PLAYING || !this.chain) return false;

    const seconds = this.settings.fadeSeconds;
    const generation = this.generation;
    const g = this.chain.fadeGain.gain;
    const now = this.ctx.currentTime;

    // An exponential approach sounds smoother than a straight line, with a
    // final linear ramp to guarantee true silence at the end of the fade.
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.setTargetAtTime(0, now, seconds / 4);
    g.linearRampToValueAtTime(0, now + seconds);

    this._setState(State.FADING, 'Fading out...');

    clearTimeout(this.fadeTimer);
    this.fadeTimer = setTimeout(() => {
      if (generation !== this.generation) return;        // operator moved on
      this._finish({ advance: true });
    }, seconds * 1000 + 120);
    return true;
  }

  /**
   * A press landed while a track was sounding, without forming a pair.
   *
   * While PLAYING the music is left alone and the operator is told what gesture
   * would act, because a press with no response at all reads as a dead player.
   *
   * While FADING the press means "move on": the fade is closed out over a
   * quarter of a second and the next track is armed, rather than making the
   * operator wait out the remaining seconds with the player refusing input.
   */
  nudge() {
    if (this.state === State.FADING) { this._completeFadeNow(); return 'advanced'; }
    if (this.state === State.PLAYING) {
      this._emit('status', 'Playing - press twice to fade out', State.PLAYING);
      return 'hint';
    }
    return null;
  }

  _completeFadeNow() {
    if (!this.chain) return;
    const g = this.chain.fadeGain.gain;
    const now = this.ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + 0.25);

    const generation = this.generation;
    clearTimeout(this.fadeTimer);
    this.fadeTimer = setTimeout(() => {
      if (generation !== this.generation) return;
      this._finish({ advance: true });
    }, 300);
  }

  /** Immediate silence. Reserved for the emergency stop key. */
  stop({ advance = true } = {}) {
    if (this.state === State.EMPTY) return;
    this._finish({ advance, message: advance ? null : 'Stopped' });
  }

  /** Tear down the current playback and arm the next track. */
  _finish({ advance, message }) {
    this.generation++;                  // invalidates every outstanding callback
    // A cued starting point is for one playing. Next time, the top.
    if (this.currentTrack) this.currentTrack.cue = 0;
    clearTimeout(this.fadeTimer);
    this.fadeTimer = null;

    if (this.source) {
      this.source.onended = null;
      try { this.source.stop(); } catch (e) {}
      try { this.source.disconnect(); } catch (e) {}
      this.source = null;
    }
    if (this.midi) { this.midi.stop(); this.midi = null; }
    this._teardownChain();

    this.startedAt = 0;
    this.currentDuration = 0;

    if (advance && this.index + 1 < this.tracks.length) {
      this.index++;
      this._setState(State.READY, message || 'Ready - press play');
    } else if (advance) {
      this._setState(State.READY, 'End of playlist');
    } else {
      this._setState(this.tracks.length ? State.READY : State.EMPTY, message || 'Ready - press play');
    }
  }

  /** Select a track without playing it, stopping anything already sounding. */
  jumpTo(i) {
    if (i < 0 || i >= this.tracks.length) return;
    if (this.isSounding) this._finish({ advance: false });
    if (this.currentTrack) this.currentTrack.cue = 0;
    this.index = i;
    this._setState(State.READY, 'Ready - press play');
  }

  /** Move a track within the playlist, keeping the armed track armed. */
  move(from, to) {
    const n = this.tracks.length;
    if (from === to || from < 0 || to < 0 || from >= n || to >= n) return;
    const armed = this.tracks[this.index];
    const [moved] = this.tracks.splice(from, 1);
    this.tracks.splice(to, 0, moved);
    const newIndex = this.tracks.indexOf(armed);
    if (newIndex >= 0) this.index = newIndex;
    this._emit('change', this);
  }

  /**
   * Where the current track is, in the file's own seconds: playing, or cued to
   * start. For a MIDI track at another tempo this is the place in the hymn,
   * not the time since pressing play; divide by `rate` for that.
   */
  get position() {
    if (this.isSounding) {
      const at = this.midi ? this.midi.position : this.ctx.currentTime - this.startedAt;
      return Math.max(0, Math.min(at, this.currentDuration));
    }
    const track = this.currentTrack;
    return track && track.cue ? track.cue : 0;
  }

  /** Length of the current track in seconds, or 0 if there is none. */
  get duration() {
    const track = this.currentTrack;
    return track ? track.duration : 0;
  }

  /** Progress through the current track, 0..1, on the audio clock. */
  get progress() {
    const d = this.isSounding ? this.currentDuration : this.duration;
    return d ? Math.min(1, this.position / d) : 0;
  }

  /** Output level for the meter, 0..1. */
  get level() {
    if (!this.analyser || !this.isSounding) return 0;
    if (!this._levelBuf) this._levelBuf = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(this._levelBuf);
    let sum = 0;
    for (let i = 0; i < this._levelBuf.length; i++) sum += this._levelBuf[i];
    return Math.min(1, (sum / this._levelBuf.length) / 128);
  }
}
