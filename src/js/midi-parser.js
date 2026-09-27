/**
 * Standard MIDI File parser.
 *
 * Turns raw .mid bytes into a flat, time-ordered list of notes with absolute
 * start times in seconds, ready for the Web Audio scheduler.
 *
 * Fixes over the original inline parser:
 *   - SMPTE time division (negative division word) is handled instead of
 *     silently producing wildly wrong tempos.
 *   - Duration is computed with a loop rather than Math.max(...array), which
 *     blew the call stack on hymn files with more than ~100k note events.
 *   - Percussion (channel 10 / index 9) can be dropped, so drum tracks in a
 *     hymn file do not get played back as organ notes.
 *   - Unmatched noteOn events inherit the file's own average note length
 *     instead of a hard-coded 1.0s.
 */

const DEFAULT_TEMPO_USPB = 500000; // 120 bpm
const SUSTAIN_CONTROLLER = 64;

export function parseMidi(bytes) {
  let p = 0;

  const read = n => { const s = bytes.subarray(p, p + n); p += n; return s; };
  const u32 = () => { const b = read(4); return ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0; };
  const u16 = () => { const b = read(2); return (b[0] << 8) | b[1]; };
  function varLen() {
    let v = 0;
    for (let i = 0; i < 4; i++) {
      const b = bytes[p++];
      v = (v << 7) | (b & 0x7f);
      if (!(b & 0x80)) break;
    }
    return v;
  }

  if (String.fromCharCode(...read(4)) !== 'MThd') throw new Error('Not a MIDI file');
  const headerLen = u32();
  const format = u16();
  const numTracks = u16();
  const divisionWord = u16();
  p += Math.max(0, headerLen - 6); // tolerate non-standard extended headers

  // Bit 15 set means SMPTE: upper byte is a negative frame rate, lower byte is
  // ticks per frame. Convert to an equivalent ticks-per-quarter-note so the
  // rest of the pipeline can stay tempo-map driven.
  let ticksPerQuarter, smpte = false;
  if (divisionWord & 0x8000) {
    smpte = true;
    const fps = 256 - (divisionWord >> 8);   // 24, 25, 29 or 30
    const ticksPerFrame = divisionWord & 0xff;
    ticksPerQuarter = fps * ticksPerFrame * 0.5; // ticks per second -> per quarter at 120bpm
  } else {
    ticksPerQuarter = divisionWord || 480;
  }

  const trackEvents = [];
  for (let t = 0; t < numTracks && p < bytes.length; t++) {
    const tag = String.fromCharCode(...read(4));
    const len = u32();
    if (tag !== 'MTrk') { p += len; continue; }

    const end = Math.min(p + len, bytes.length);
    const events = [];
    let tick = 0, lastStatus = 0;

    while (p < end) {
      tick += varLen();
      let status = bytes[p];
      if (status & 0x80) { lastStatus = status; p++; }
      else { status = lastStatus; }            // running status

      const type = status & 0xf0;
      const ch = status & 0x0f;

      if (type === 0x80 || type === 0x90) {
        const note = bytes[p++], vel = bytes[p++];
        const isOn = type === 0x90 && vel > 0;
        events.push({ tick, type: isOn ? 'noteOn' : 'noteOff', ch, note, vel });
      } else if (type === 0xb0) {
        const controller = bytes[p++], value = bytes[p++];
        // Controller 64 is the sustain pedal. Hymn files recorded on a digital
        // piano are full of it, and discarding it, as this parser used to,
        // makes every note stop dead the instant the key lifts. The result is
        // a performance that sounds relentlessly staccato.
        if (controller === SUSTAIN_CONTROLLER) {
          events.push({ tick, type: 'sustain', ch, down: value >= 64 });
        }
      } else if (type === 0xa0 || type === 0xe0) {
        p += 2;
      } else if (type === 0xc0 || type === 0xd0) {
        p += 1;
      } else if (status === 0xff) {
        const meta = bytes[p++], mLen = varLen();
        if (meta === 0x51 && mLen === 3) {
          const d = read(3);
          events.push({ tick, type: 'tempo', uspb: (d[0] << 16) | (d[1] << 8) | d[2] });
        } else {
          p += mLen;
        }
      } else if (status === 0xf0 || status === 0xf7) {
        // The length must be read into a variable first. Writing this as
        // "p += varLen()" is wrong: varLen() advances p itself, but the
        // compound assignment has already captured p's old value and then
        // overwrites it, swallowing the length byte. Every sysex event would
        // desynchronise the parse by one byte, and a hymn exported from a
        // keyboard is full of them.
        const sysexLength = varLen();
        p += sysexLength;
      } else {
        p++;                                    // unknown byte, resynchronise
      }
    }
    p = end;
    trackEvents.push(events);
  }

  return { format, ticksPerQuarter, smpte, tracks: trackEvents };
}

/**
 * Flatten a parsed file into { notes, duration }.
 * notes: [{ sec, note, vel, ch, dur }] sorted by start time.
 */
export function midiToSchedule(parsed, { dropPercussion = true, trimLeadIn = true } = {}) {
  const { ticksPerQuarter, smpte, tracks } = parsed;

  // A tempo map is global to the file even in format 1, so gather tempo
  // changes from every track and sort them by tick.
  const tempoChanges = [];
  for (const track of tracks) {
    for (const ev of track) if (ev.type === 'tempo') tempoChanges.push(ev);
  }
  tempoChanges.sort((a, b) => a.tick - b.tick);

  const tempoMap = [{ tick: 0, sec: 0, uspb: DEFAULT_TEMPO_USPB }];
  let tempo = DEFAULT_TEMPO_USPB, lastTick = 0, lastSec = 0;
  for (const ev of tempoChanges) {
    // SMPTE division encodes real time directly, so tempo meta events do not
    // change the tick rate and must not be folded into the map.
    if (smpte) break;
    lastSec += ((ev.tick - lastTick) / ticksPerQuarter) * (tempo / 1e6);
    lastTick = ev.tick;
    tempo = ev.uspb;
    tempoMap.push({ tick: ev.tick, sec: lastSec, uspb: tempo });
  }

  function tickToSec(tick) {
    let lo = 0, hi = tempoMap.length - 1, seg = tempoMap[0];
    while (lo <= hi) {                          // binary search, not linear scan
      const mid = (lo + hi) >> 1;
      if (tempoMap[mid].tick <= tick) { seg = tempoMap[mid]; lo = mid + 1; }
      else hi = mid - 1;
    }
    return seg.sec + ((tick - seg.tick) / ticksPerQuarter) * (seg.uspb / 1e6);
  }

  const noteEvents = [];
  const pedalEvents = [];
  for (const track of tracks) {
    for (const ev of track) {
      if (ev.type === 'sustain') {
        if (!(dropPercussion && ev.ch === 9)) pedalEvents.push({ ...ev, sec: tickToSec(ev.tick) });
        continue;
      }
      if (ev.type !== 'noteOn' && ev.type !== 'noteOff') continue;
      if (dropPercussion && ev.ch === 9) continue;
      noteEvents.push({ ...ev, sec: tickToSec(ev.tick) });
    }
  }
  pedalEvents.sort((a, b) => a.sec - b.sec);
  noteEvents.sort((a, b) => a.sec - b.sec || (a.type === 'noteOff' ? -1 : 1));

  const pending = new Map();                    // "ch_note" -> [{ sec, vel }]
  const notes = [];
  let durSum = 0;

  for (const ev of noteEvents) {
    const key = ev.ch * 128 + ev.note;
    if (ev.type === 'noteOn') {
      if (!pending.has(key)) pending.set(key, []);
      pending.get(key).push({ sec: ev.sec, vel: ev.vel });
    } else {
      const stack = pending.get(key);
      if (!stack || !stack.length) continue;
      const on = stack.shift();
      const dur = ev.sec - on.sec;
      if (dur > 0.01) {                         // ignore zero-length artefacts
        notes.push({ sec: on.sec, note: ev.note, vel: on.vel, ch: ev.ch, dur });
        durSum += dur;
      }
    }
  }

  // Hanging noteOns (a truncated or malformed file): give them the file's own
  // average note length rather than an arbitrary one second.
  const fallbackDur = notes.length ? durSum / notes.length : 1.0;
  for (const [key, stack] of pending) {
    const ch = Math.floor(key / 128), note = key % 128;
    for (const on of stack) notes.push({ sec: on.sec, note, vel: on.vel, ch, dur: fallbackDur });
  }

  notes.sort((a, b) => a.sec - b.sec);

  applySustainPedal(notes, pedalEvents);

  // Drop the silence before the first note.
  //
  // Hymn files exported from a keyboard routinely open with an empty bar: all
  // three files from one real parish began 1.88 seconds in. The operator presses
  // at the moment the music is wanted, hears nothing for two seconds, and
  // reasonably concludes the player is broken. Nothing musical is lost, because
  // what is removed is silence. A short lead is kept so the first chord is not
  // absolutely instantaneous.
  const LEAD_IN = 0.08;
  if (trimLeadIn && notes.length && notes[0].sec > LEAD_IN) {
    const offset = notes[0].sec - LEAD_IN;
    for (const n of notes) n.sec -= offset;
  }

  let duration = 0;
  for (const n of notes) {
    const e = n.sec + Math.max(n.dur, n.pedalDur || 0);
    if (e > duration) duration = e;
  }

  return { notes, duration };
}

/**
 * Work out how long each note actually rings once the sustain pedal is taken
 * into account, and record it as `pedalDur` alongside the played duration.
 *
 * A note released while the pedal is down keeps sounding until the pedal comes
 * up. The played duration is left untouched, because whether the pedal should
 * be honoured depends on the instrument: a piano has one, an organ does not.
 * midi-engine.js chooses per instrument.
 *
 * @param {Array} notes   sorted by start time; modified in place
 * @param {Array} pedal   sustain events, sorted, as { sec, ch, down }
 */
const MAX_PEDAL_SUSTAIN = 12;   // seconds; guards against a pedal never released

function applySustainPedal(notes, pedal) {
  if (!pedal.length) return;

  // One timeline per channel, since each has its own pedal.
  const byChannel = new Map();
  for (const ev of pedal) {
    if (!byChannel.has(ev.ch)) byChannel.set(ev.ch, []);
    const list = byChannel.get(ev.ch);
    // Collapse repeats: a pedal already down being pressed again changes nothing.
    if (list.length && list[list.length - 1].down === ev.down) continue;
    list.push(ev);
  }

  for (const note of notes) {
    const timeline = byChannel.get(note.ch);
    if (!timeline || !timeline.length) continue;

    const end = note.sec + note.dur;

    // Last pedal change at or before the moment this note is released.
    let lo = 0, hi = timeline.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (timeline[mid].sec <= end) { idx = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (idx < 0 || !timeline[idx].down) continue;     // pedal was up; nothing to hold

    // Sustain until the next release.
    let release = null;
    for (let i = idx + 1; i < timeline.length; i++) {
      if (!timeline[i].down) { release = timeline[i].sec; break; }
    }
    if (release === null) release = end + MAX_PEDAL_SUSTAIN;

    const held = Math.min(release, end + MAX_PEDAL_SUSTAIN) - note.sec;
    if (held > note.dur) note.pedalDur = held;
  }
}
