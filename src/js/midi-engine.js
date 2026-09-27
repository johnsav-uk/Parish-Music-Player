/**
 * MIDI rendering: turns a note schedule into Web Audio voices.
 *
 * The same voice-building code serves live playback and the offline render used
 * to measure MIDI loudness, so what gets normalised is exactly what gets heard.
 *
 * Fixes over the original:
 *   - Samples are one-shot by default and only loop when a note genuinely
 *     outlasts the recording. The original looped every note over a fixed
 *     10%-90% slice, which is correct for an organ but makes a piano sample
 *     loop its own decay — the "out of tune / distorted" complaint in the
 *     troubleshooting notes.
 *   - Playback ends on the audio clock, not a wall-clock setTimeout, so a
 *     throttled timer can no longer cut a hymn short or leave it hanging.
 *   - The lookahead window survives timer throttling.
 *   - MIDI gets a real level meter instead of Math.random().
 */

import { SoundfontLibrary } from './soundfont.js';
import { measureLoudestWindow } from './loudness.js';

const ATTACK = 0.012;        // seconds; short enough to keep articulation
const VELOCITY_SCALE = 0.8;  // headroom before the per-track normalisation gain

/**
 * Voicing: how a performance should be adapted to the instrument playing it.
 *
 * Hymn MIDI files are very often recorded on a digital piano. That performance
 * carries two pianistic habits which sound wrong on an organ:
 *
 *   Touch. A piano gets louder when struck harder, so a player shapes the line
 *   with velocity. An organ pipe cannot do that at all: air is either flowing or
 *   it is not. Playing a piano performance's velocities on an organ makes the
 *   quiet notes nearly vanish, and the line appears to drop in and out.
 *
 *   Articulation. A pianist lifts between notes and lets the string ring on. An
 *   organist holds, because the moment the key lifts the sound stops dead. The
 *   same detached playing that sounds natural on a piano sounds chopped on an
 *   organ.
 *
 * So a sustaining instrument compresses velocity towards full and holds each
 * note into the next chord, while a struck instrument is left exactly as
 * performed.
 */
export const VOICING = {
  // velocityFloor: 1 ignores touch entirely, 0 reproduces it exactly.
  // holdToChord:   hold each note into the next chord, bridging gaps up to this
  //                many seconds. 0 disables it.
  // usePedal:      honour the recorded sustain pedal.
  //
  // The pedal is honoured only for instruments that have one. A piano's
  // pedalled notes decay by themselves, so they overlap harmlessly.
  //
  // An organ has no sustain pedal, and applying the piano's pedalling to it
  // sounded wrong for a specific, measurable reason: a pianist's pedal blurs
  // across harmony changes, which is fine on an instrument whose notes are
  // already dying away, but an organ holds everything at full volume. On three
  // real hymns that piled up to seven of the twelve pitch classes sounding at
  // once, against five as played. That is the muddiness.
  //
  // So organ-family instruments hold to the next chord instead, which is what
  // an organist does by hand: hold through the harmony, release on the change.
  sustained: { velocityFloor: 0.72, holdToChord: 0.6, usePedal: false },
  struck:    { velocityFloor: 0.0,  holdToChord: 0,   usePedal: true },
};

/** Instrument groups whose real counterpart holds a note for as long as it is played. */
const SUSTAINING_GROUPS = new Set(['Organ', 'Voices', 'Strings and Harp', 'Wind and Brass']);

export function voicingForGroup(group) {
  // Harp is in a string group but is plucked, so it is handled by name below.
  return SUSTAINING_GROUPS.has(group) ? VOICING.sustained : VOICING.struck;
}

export function voicingForInstrument(key, group) {
  const struckByName = ['orchestral_harp', 'harp', 'tubular_bells', 'celesta',
                        'music_box', 'harpsichord', 'timpani'];
  if (struckByName.includes(key)) return VOICING.struck;
  if (key.includes('piano')) return VOICING.struck;
  return voicingForGroup(group);
}

/**
 * Chord onsets: the times at which a new chord is struck.
 *
 * Notes within CHORD_WINDOW of each other are one chord, because a human
 * playing a four-note chord does not land all four on the same millisecond.
 * Cached on the schedule, since it does not depend on the instrument.
 */
const CHORD_WINDOW = 0.06;

function chordOnsets(schedule) {
  if (schedule._chordOnsets) return schedule._chordOnsets;
  const onsets = [];
  for (const n of schedule.notes) {          // already sorted by start time
    if (!onsets.length || n.sec - onsets[onsets.length - 1] >= CHORD_WINDOW) onsets.push(n.sec);
  }
  schedule._chordOnsets = onsets;
  return onsets;
}

/**
 * How long a note actually sounds, once the instrument's own behaviour is
 * applied to the performance.
 *
 * For an instrument with a sustain pedal, the pedal decides outright.
 *
 * For an organ, each note is held until the next chord is struck. At that
 * moment it is either dropped from the harmony, in which case releasing it is
 * correct, or struck again, in which case the new note takes over cleanly. An
 * earlier attempt held each note until the next chord that did not contain its
 * pitch, which sounds more careful but leaves the old and new note of a
 * re-struck pitch overlapping: 64 to 184 such doublings per hymn, against none
 * here.
 *
 * Gaps longer than the voicing's limit are left alone, because they are rests
 * the player intended. At 0.6s this reproduces the performance's own phrasing
 * exactly, breath for breath, while closing the small lifts between notes.
 */
function soundingDuration(note, schedule, voicing) {
  if (voicing.usePedal && note.pedalDur) return note.pedalDur;

  const limit = voicing.holdToChord;
  if (!limit) return note.dur;

  const onsets = chordOnsets(schedule);
  const end = note.sec + note.dur;

  // First chord struck after this note has finished.
  let lo = 0, hi = onsets.length - 1, next = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (onsets[mid] > end + 0.005) { next = onsets[mid]; hi = mid - 1; }
    else lo = mid + 1;
  }
  if (next < 0) return note.dur;                    // nothing follows; let it end

  const gap = next - end;
  if (gap > limit) return note.dur;                 // a real rest; let it breathe
  return next - note.sec;
}

/**
 * Release tail length, in seconds, for a note of the given played duration.
 *
 * The original scaled this inversely: the shorter the note, the longer it rang
 * on, up to 1.2 seconds before the user's multiplier was even applied. At the
 * default multiplier a 30 ms passing note rang for 2.4 seconds. A real hymn
 * setting is full of such notes, and with a dozen of them overlapping the
 * result was a continuous wash rather than a played line.
 *
 * Neither instrument behaves that way. An organ pipe stops when the key
 * releases and a piano damper falls on the string; what a congregation hears
 * ringing afterwards is the building, not the note. So the tail is short, and
 * grows slightly with note length rather than shrinking, because a held chord
 * genuinely does decay into the room more than a passing note does.
 *
 * The Note release setting still lengthens it for anyone who wants more ring.
 */
const MIN_RELEASE = 0.04;
const MAX_RELEASE = 1.5;

function releaseFor(dur, multiplier) {
  const base = 0.18 + Math.min(dur, 2) * 0.06;     // 0.18s for a grace note, 0.30s for a held one
  return Math.max(MIN_RELEASE, Math.min(base * multiplier, MAX_RELEASE));
}

/**
 * Schedule one note. Returns the created source so the caller can stop it.
 * `when` is an absolute time on the target context's clock.
 */
function scheduleNote(ctx, destination, samples, note, when, releaseMult, sustainLoop, voicing = VOICING.struck) {
  const sample = SoundfontLibrary.nearestSample(samples, note.note);
  if (!sample) return null;

  const rate = Math.pow(2, (note.note - sample.midi) / 12);
  const dur = note.soundingDur !== undefined ? note.soundingDur : note.dur;
  const release = releaseFor(dur, releaseMult);
  const stopAt = when + dur;

  const src = ctx.createBufferSource();
  src.buffer = sample.buffer;
  src.playbackRate.value = rate;

  // How much recorded material is actually available at this pitch.
  const availableSeconds = sample.buffer.duration / rate;
  const neededSeconds = dur + release;

  // Looping only makes sense for an instrument that genuinely holds a note. A
  // pedalled piano note simply decays, which the recording already does.
  if (sustainLoop && voicing.velocityFloor > 0 && neededSeconds > availableSeconds) {
    // Only now is looping justified. Loop a window in the back half of the
    // sample, where an organ or string recording is in steady state.
    const d = sample.buffer.duration;
    src.loop = true;
    src.loopStart = d * 0.55;
    src.loopEnd = d * 0.95;
  }

  const gain = ctx.createGain();
  // Velocity is compressed towards full for instruments that have no touch
  // response of their own.
  const floor = voicing.velocityFloor;
  const touch = floor + (1 - floor) * (note.vel / 127);
  const level = touch * VELOCITY_SCALE;
  gain.gain.setValueAtTime(0, when);
  gain.gain.linearRampToValueAtTime(level, when + ATTACK);
  gain.gain.setValueAtTime(level, stopAt);
  gain.gain.setTargetAtTime(0, stopAt, release / 3);

  src.connect(gain);
  gain.connect(destination);
  src.start(when);
  src.stop(stopAt + release + 0.1);
  return src;
}

/**
 * Render a MIDI schedule offline and measure its loudness, so MIDI tracks can
 * be normalised on the same scale as recorded audio.
 */
/**
 * Find, without rendering anything, the moment in a piece where the most
 * amplitude is sounding at once.
 *
 * Each note is treated as a rectangle of its velocity level, lasting from its
 * start until the end of its release tail, and the sweep finds where the sum of
 * those rectangles is greatest. It is only an estimate of amplitude, since real
 * partials do not add arithmetically, but it reliably locates the loudest
 * passage, which is all that is needed to know where to point the renderer.
 */
function loudestMoments(notes, releaseMult, count, minSeparation) {
  if (!notes.length) return [0];
  const edges = [];
  for (const n of notes) {
    const level = n.vel / 127;
    const d = n.soundingDur !== undefined ? n.soundingDur : n.dur;
    const until = n.sec + d + releaseFor(d, releaseMult);
    edges.push([n.sec, level], [until, -level]);
  }
  edges.sort((a, b) => a[0] - b[0]);

  const profile = [];
  let running = 0;
  for (const [time, delta] of edges) {
    running += delta;
    profile.push([time, running]);
  }
  profile.sort((a, b) => b[1] - a[1]);

  // Several separated candidates, not just the single highest. The arithmetic
  // sum of velocities is only a proxy: partials do not add in phase, so the
  // busiest moment is not always the one that peaks highest once rendered. On
  // one real hymn the top candidate alone under-read the peak and the track
  // clipped by a couple of samples. Checking the three loudest passages costs
  // almost nothing and removes the guesswork.
  const chosen = [];
  for (const [time] of profile) {
    if (chosen.length >= count) break;
    if (chosen.every(t => Math.abs(t - time) >= minSeparation)) chosen.push(time);
  }
  return chosen.length ? chosen : [0];
}

/**
 * Render a MIDI schedule offline and measure its loudness, so MIDI tracks can
 * be normalised on the same scale as recorded audio.
 *
 * Only a window around the loudest passage is rendered, not the whole piece.
 *
 * Measuring the opening was wrong: hymns build, and on three real parish files
 * the loudest moment fell at 166s, 41s and 195s. Two of the three therefore had
 * their level taken from a quiet early verse, were given too much gain, and
 * clipped during the final verse.
 *
 * Rendering the whole piece fixed that but cost 11 seconds for a single hymn,
 * which is far too slow across a service. Locating the loudest passage
 * arithmetically and rendering twenty seconds around it gives the same answer
 * for a fraction of the work.
 */
const MEASURE_WINDOW = 20;      // seconds rendered around each candidate passage
const MEASURE_RATE = 22050;     // plenty for an RMS and peak estimate
const MEASURE_PASSAGES = 3;     // how many candidate passages to render

/** Render one window and measure it. */
async function measureWindow(notes, samples, from, to, releaseMult, sustainLoop, voicing) {
  const span = Math.max(to - from, 1);
  const offline = new OfflineAudioContext(1, Math.ceil((span + 2) * MEASURE_RATE), MEASURE_RATE);

  for (const note of notes) {
    if (note.sec > to) break;
    const when = note.sec - from;

    if (when >= 0) {
      scheduleNote(offline, offline.destination, samples, note, when, releaseMult, sustainLoop, voicing);
      continue;
    }

    // The note began before the window. A chord held across the boundary is
    // part of what makes this passage loud, so the remainder of it is scheduled
    // at the start of the window rather than dropped. Negative start times are
    // not permitted, hence the shortened copy.
    const remaining = note.dur + when;
    if (remaining > 0.01) {
      scheduleNote(offline, offline.destination, samples,
                   { ...note, dur: remaining, soundingDur: remaining }, 0,
                   releaseMult, sustainLoop, voicing);
    }
  }

  const rendered = await offline.startRendering();
  // A shorter window than recorded audio gets: a hymn setting often leaves bars
  // of rest between phrases, and counting that silence would under-read the
  // level and then over-boost the notes that do sound.
  return measureLoudestWindow(rendered, 4);
}

export async function measureMidiLoudness(schedule, samples,
    { releaseMult = 2, sustainLoop = true, voicing = VOICING.struck } = {}) {
  const notes = schedule.notes;
  if (!schedule.duration || !notes.length) return { rms: 0, peak: 0 };

  // Measure what will actually be heard, voicing included.
  for (const n of notes) n.soundingDur = soundingDuration(n, schedule, voicing);

  const centres = loudestMoments(notes, releaseMult, MEASURE_PASSAGES, MEASURE_WINDOW * 0.75);

  let rms = 0, peak = 0;
  for (const centre of centres) {
    const from = Math.max(0, centre - MEASURE_WINDOW * 0.35);
    const to = Math.min(schedule.duration, from + MEASURE_WINDOW);
    const m = await measureWindow(notes, samples, from, to, releaseMult, sustainLoop, voicing);
    if (m.rms > rms) rms = m.rms;
    if (m.peak > peak) peak = m.peak;
  }
  return { rms, peak };
}

/**
 * Live MIDI playback with a rolling lookahead scheduler.
 */
export class MidiPlayer {
  /**
   * @param {AudioContext} ctx
   * @param {AudioNode} destination  normally the per-track gain node
   */
  constructor(ctx, destination) {
    this.ctx = ctx;
    this.destination = destination;
    this.reset();
  }

  reset() {
    this.sources = [];
    this.timer = null;
    this.startedAt = 0;
    this.duration = 0;
    this.noteIndex = 0;
    this.schedule = null;
    this.playing = false;
    this.onEnded = null;
    this.scheduledCount = 0;
    this.lateCount = 0;
    this.rate = 1;
  }

  get elapsed() {
    return this.playing ? this.ctx.currentTime - this.startedAt : 0;
  }

  /**
   * Where the performance has got to, in the file's own seconds.
   *
   * At a rate other than 1 this runs faster or slower than the clock, which is
   * the point: it is the place in the hymn, not the time since pressing play.
   */
  get position() {
    return this.playing ? Math.max(0, (this.ctx.currentTime - this.startedAt) * this.rate) : 0;
  }

  /** Audio-clock time at which the file's second `sec` sounds. */
  _when(sec) {
    return this.startedAt + sec / this.rate;
  }

  /** A note with its timings scaled to the current rate. */
  _scaled(note, dur = note.dur, soundingDur = note.soundingDur) {
    if (this.rate === 1) return dur === note.dur && soundingDur === note.soundingDur
      ? note : { ...note, dur, soundingDur };
    return { ...note, dur: dur / this.rate, soundingDur: soundingDur / this.rate };
  }

  _schedule(note, when) {
    const src = scheduleNote(this.ctx, this.destination, this.samples, note, when,
                             this.releaseMult, this.sustainLoop, this.voicing);
    if (!src) return;
    src.__when = when;
    // Marked when finished, so the pump can drop it from `sources`. Nothing
    // used to set this, and the list grew for the whole of every hymn.
    src.onended = () => { src.__done = true; };
    this.sources.push(src);
    this.scheduledCount++;
  }

  /**
   * Change speed while playing, without a gap or a repeated note.
   *
   * Notes already sounding are left alone to finish, which at the few percent
   * anyone would change by mid-hymn is inaudible. Notes scheduled ahead but not
   * yet started are cancelled and scheduled again at the new speed from the
   * current place in the hymn. Stopping a source before its start time simply
   * means it never sounds.
   *
   * @param {number} rate  1 as written, 0.9 ten per cent slower
   */
  setRate(rate) {
    if (!(rate > 0) || rate === this.rate) return;
    if (!this.playing) { this.rate = rate; return; }

    const now = this.ctx.currentTime;
    const here = this.position;

    const kept = [];
    for (const s of this.sources) {
      if (s.__when > now) { try { s.stop(0); } catch {} }
      else kept.push(s);
    }
    this.sources = kept;

    // Everything from here on is to be scheduled again.
    const notes = this.schedule.notes;
    let lo = 0, hi = notes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (notes[mid].sec > here) hi = mid; else lo = mid + 1;
    }
    this.noteIndex = Math.min(this.noteIndex, lo);

    this.rate = rate;
    this.startedAt = now - here / rate;
    this._pump();
  }

  /**
   * @param {{notes:Array, duration:number}} schedule
   * @param {Array} samples
   */
  start(schedule, samples,
        { releaseMult = 2, sustainLoop = true, voicing = VOICING.struck,
          lookahead = 8, tickMs = 250, offset = 0, at = null, rate = 1 } = {}) {
    this.stop();
    this.schedule = schedule;
    this.samples = samples;
    this.releaseMult = releaseMult;
    this.sustainLoop = sustainLoop;
    this.voicing = voicing;
    for (const n of schedule.notes) n.soundingDur = soundingDuration(n, schedule, voicing);
    this.lookahead = lookahead;
    this.scheduledCount = 0;
    this.lateCount = 0;
    this.duration = schedule.duration;
    this.rate = rate > 0 ? rate : 1;
    // A small lead so the opening chord is scheduled just ahead of the clock
    // rather than fractionally behind it, which would drop it. This is pure
    // added latency between the press and the first sound, so it is kept to
    // roughly one audio render quantum rather than a comfortable margin.
    const begin = at !== null ? at : this.ctx.currentTime + 0.012;
    // startedAt is where second zero of the piece falls on the audio clock,
    // which for a piece started part-way through lies in the past.
    this.startedAt = begin - offset / this.rate;
    this.playing = true;

    this.noteIndex = 0;
    if (offset > 0) this._resumeHeldNotes(offset, begin);

    this._pump();
    this.timer = setInterval(() => this._pump(), tickMs);
  }

  /**
   * Starting part-way through: skip every note that began before the offset,
   * but sound the remainder of any that would still be ringing there.
   *
   * Without this, jumping into the middle of a held chord gives silence until
   * the next chord is struck, which on a slow hymn can be two seconds and reads
   * as the jump having failed.
   */
  _resumeHeldNotes(offset, begin) {
    const notes = this.schedule.notes;
    while (this.noteIndex < notes.length && notes[this.noteIndex].sec < offset) {
      const note = notes[this.noteIndex++];
      const remaining = note.sec + note.soundingDur - offset;
      if (remaining <= 0.05) continue;
      this._schedule(this._scaled(note, remaining, remaining), begin);
    }
  }

  _pump() {
    if (!this.playing) return;
    const now = this.ctx.currentTime;
    const until = now + this.lookahead;
    const notes = this.schedule.notes;

    while (this.noteIndex < notes.length) {
      const note = notes[this.noteIndex];
      const when = this._when(note.sec);
      if (when > until) break;
      this.noteIndex++;

      if (when < now - 0.05) { this.lateCount++; continue; }  // already past; skip

      this._schedule(this._scaled(note), when);
    }

    // Drop references to voices that have finished so the array cannot grow
    // without bound across a long hymn.
    if (this.sources.length > 512) {
      this.sources = this.sources.filter(s => s.__done !== true);
    }

    // End detection runs on the audio clock. A throttled interval delays the
    // check but cannot shorten or lengthen the piece.
    if (this.noteIndex >= notes.length && now >= this._when(this.duration) + 0.5) {
      const cb = this.onEnded;
      this.stop();
      if (cb) cb();
    }
  }

  /** @param {number} [when] audio-clock time to silence at; now if omitted */
  stop(when) {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    for (const s of this.sources) { try { s.stop(when); } catch {} }
    this.sources = [];
    this.playing = false;
  }
}
