/**
 * Render a hymn through an instrument, so two instruments can be compared.
 *
 * Measurements tell you a soundfont is correct. They cannot tell you whether the
 * organ sounds good, which is the only reason for replacing one. This renders
 * through the player's own engine, so the comparison includes the voicing, the
 * hold-to-chord behaviour and the church reverb, exactly as a congregation would
 * hear it.
 *
 * How to run it
 * -------------
 * 1. Put the MIDI files somewhere the dev server can reach, e.g. src/_ab/, and
 *    delete them afterwards.
 *
 * 2. Start a receiver for the rendered audio, because a page cannot write to
 *    disk. Anything that accepts a POST and saves the body will do:
 *
 *        python -c "import http.server as h; ..."
 *
 *    or any small script listening on 127.0.0.1:8802 that writes the POST body
 *    to the file named in the path, with Access-Control-Allow-Origin: *.
 *
 * 3. Start the player and open it:
 *
 *        python app.py --browser --port 8801
 *
 * 4. Paste this file into the browser console, then call:
 *
 *        await renderAB('_ab/hymn.mid', 'pipe_organ', 32, 'out.wav');
 *
 * Levels are not adjusted. The player normalises a track's loudness only after
 * it has measured it in the background, so an instrument's own level is what is
 * heard on a first play, and comparing at that level is the honest comparison.
 */

window.renderAB = async function (midiUrl, instrument, seconds, outName,
                                  receiver = 'http://127.0.0.1:8802/') {
  const p = window.parishPlayer.player;
  p.context();

  const { MidiPlayer, voicingForInstrument } = await import('./js/midi-engine.js');
  const { createChurchImpulse } = await import('./js/reverb.js');
  const { parseMidi, midiToSchedule } = await import('./js/midi-parser.js');

  const bytes = new Uint8Array(await (await fetch(midiUrl, { cache: 'reload' })).arrayBuffer());
  const schedule = midiToSchedule(parseMidi(bytes));
  const samples = await p.soundfonts.load(instrument);

  const rate = p.ctx.sampleRate;
  const span = Math.min(seconds, schedule.duration) + 4;   // room for the tail
  const off = new OfflineAudioContext(2, Math.ceil(span * rate), rate);

  // The same graph player.js builds for a MIDI track: dry to the output, and a
  // send into the shared convolver.
  const track = off.createGain();
  const wet = off.createGain();
  wet.gain.value = p.settings.reverbAmount;
  const verb = off.createConvolver();
  verb.buffer = createChurchImpulse(off, p.settings.reverbSeconds);
  track.connect(off.destination);
  track.connect(wet);
  wet.connect(verb);
  verb.connect(off.destination);

  const clipped = {
    notes: schedule.notes.filter(n => n.sec < seconds),
    duration: Math.min(seconds, schedule.duration),
  };

  // MidiPlayer normally feeds the graph a few seconds ahead of a running clock.
  // An offline context's clock does not advance until it renders, so the whole
  // piece is scheduled in the first pump and the timer is then dropped.
  const mp = new MidiPlayer(off, track);
  mp.start(clipped, samples, {
    releaseMult: p.settings.releaseMultiplier,
    sustainLoop: p.settings.sustainLoop,
    voicing: voicingForInstrument(instrument, 'Organ'),
    lookahead: 1e6,
    tickMs: 1e9,
  });
  clearInterval(mp.timer);

  const buf = await off.startRendering();

  const n = buf.length, L = buf.getChannelData(0), R = buf.getChannelData(1);
  const ab = new ArrayBuffer(44 + n * 4), dv = new DataView(ab);
  const wr = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  wr(0, 'RIFF'); dv.setUint32(4, 36 + n * 4, true); wr(8, 'WAVEfmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 2, true);
  dv.setUint32(24, buf.sampleRate, true); dv.setUint32(28, buf.sampleRate * 4, true);
  dv.setUint16(32, 4, true); dv.setUint16(34, 16, true);
  wr(36, 'data'); dv.setUint32(40, n * 4, true);

  let o = 44, peak = 0;
  for (let i = 0; i < n; i++) {
    peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
    dv.setInt16(o, Math.max(-1, Math.min(1, L[i])) * 32767, true); o += 2;
    dv.setInt16(o, Math.max(-1, Math.min(1, R[i])) * 32767, true); o += 2;
  }

  await fetch(receiver + outName, { method: 'POST', body: ab });
  return { instrument, out: outName, notes: clipped.notes.length, peak: +peak.toFixed(3) };
};
