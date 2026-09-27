/**
 * Loudness measurement and normalisation gain.
 *
 * Every track — MP3, WAV, OGG, FLAC *and* MIDI — is reduced to the same pair of
 * numbers (rms, peak) so one formula can level the whole playlist. MIDI files
 * get their numbers by rendering a sample of the piece offline; see
 * midi-engine.js. The original build measured audio files only and left MIDI at
 * a fixed gain, which is why organ tracks jumped against recorded hymns.
 */

/** Single pass over all channels. The original made two, for no benefit. */
export function measureBuffer(buffer) {
  let sumSq = 0, peak = 0, count = 0;
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const d = buffer.getChannelData(ch);
    for (let i = 0; i < d.length; i++) {
      const v = d[i];
      sumSq += v * v;
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
      count++;
    }
  }
  return { rms: count ? Math.sqrt(sumSq / count) : 0, peak };
}

/**
 * Measure only the loudest stretch of the track rather than its whole length.
 *
 * A hymn that opens with four bars of quiet introduction has a low overall RMS,
 * so whole-file RMS over-boosts it and the congregation gets a wall of sound at
 * the first verse. Taking the loudest window instead levels what people
 * actually hear.
 */
export function measureLoudestWindow(buffer, windowSeconds = 10) {
  const sr = buffer.sampleRate;
  const win = Math.min(Math.floor(windowSeconds * sr), buffer.length);
  if (win <= 0) return { rms: 0, peak: 0 };
  if (buffer.length <= win) return measureBuffer(buffer);

  const chans = [];
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) chans.push(buffer.getChannelData(ch));

  // Sum of squares per hop, then a sliding window over the hops.
  const hop = Math.max(1, Math.floor(sr * 0.25));
  const hops = Math.floor(buffer.length / hop);
  const energy = new Float64Array(hops);
  let peak = 0;

  for (let h = 0; h < hops; h++) {
    let e = 0;
    const start = h * hop, end = start + hop;
    for (const d of chans) {
      for (let i = start; i < end; i++) {
        const v = d[i];
        e += v * v;
        const a = v < 0 ? -v : v;
        if (a > peak) peak = a;
      }
    }
    energy[h] = e;
  }

  const hopsPerWindow = Math.max(1, Math.floor(win / hop));
  let running = 0;
  for (let h = 0; h < hopsPerWindow && h < hops; h++) running += energy[h];
  let best = running;
  for (let h = hopsPerWindow; h < hops; h++) {
    running += energy[h] - energy[h - hopsPerWindow];
    if (running > best) best = running;
  }

  const samplesInWindow = hopsPerWindow * hop * buffer.numberOfChannels;
  return { rms: Math.sqrt(best / samplesInWindow), peak };
}

/**
 * Gain that brings a measured track to the target RMS, subject to two guards:
 * keep the peak about a decibel below full scale, and never boost by more
 * than maxBoost.
 *
 * The boost limit exists to stop a quiet, noisy recording having its tape hiss
 * and room rumble amplified into the sanctuary. That reasoning does not apply to
 * MIDI, which is synthesised here and has no noise floor at all, so MIDI tracks
 * are allowed a much larger boost and are held back only by the peak ceiling.
 */
// Roughly -1 dBFS. The previous 0.98 left only 0.2 dB of headroom, so a track
// levelled right up against it clipped as soon as anything varied: a chord
// voiced slightly differently, or a peak the measurement had not seen.
const PEAK_CEILING = 0.89;
export const MAX_BOOST_RECORDED = 8.0;
export const MAX_BOOST_SYNTHESISED = 24.0;

/**
 * The level every track is brought to.
 *
 * Deliberately modest, and fixed rather than adjustable. A commercially
 * mastered recording already sits near full scale and cannot be raised without
 * clipping, so aiming higher does not lift it: the peak guard below stops it
 * while the quiet hymns carry on climbing, and the spread the levelling exists
 * to close opens up again. On a real eight-item parish service this figure
 * gives a 1.1 dB spread between quietest and loudest, where 0.20 gave 5.5.
 *
 * This was a slider on the Setup page. It was removed because there is no
 * setting of it that is better than this one: raising it makes the matching
 * worse, and lowering it does what the master volume already does. "Too quiet"
 * is a question for the master volume or the amplifier.
 */
export const TARGET_RMS = 0.12;

export function normalisationGain({ rms, peak }, targetRms = TARGET_RMS,
                                  maxBoost = MAX_BOOST_RECORDED) {
  if (!rms || rms <= 0) return 1;
  let gain = targetRms / rms;
  if (peak > 0) gain = Math.min(gain, PEAK_CEILING / peak);
  return Math.min(gain, maxBoost);
}
