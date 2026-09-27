/**
 * Church acoustic.
 *
 * A pipe organ speaks and stops with the key; what makes it sound sustained in a
 * church is the building, not the pipe. The original build tried to fake that by
 * making every note ring on for up to 2.4 seconds, which is why a busy hymn
 * turned into a wash: each note held at full level instead of decaying into a
 * shared tail.
 *
 * A reverb does the job properly. One diffuse tail is shared by everything
 * playing, so gaps between detached chords fill in and the line sounds
 * connected, while each note still stops when it should.
 *
 * The impulse response is generated rather than shipped as a file: it keeps the
 * download small and avoids another asset the packaging has to carry.
 */

/**
 * Build a stereo impulse response resembling a stone church.
 *
 * Exponentially decaying noise is the standard cheap approximation. Two touches
 * make it more convincing than plain noise: a short pre-delay before the tail
 * begins, which is what gives an impression of size, and a gentler decay on the
 * low end, because stone reflects bass longer than treble.
 *
 * @param {BaseAudioContext} ctx
 * @param {number} seconds      reverberation time; 2.6 suits a parish church
 * @param {number} decay        curve sharpness, higher is faster
 */
export function createChurchImpulse(ctx, seconds = 2.6, decay = 2.2) {
  const rate = ctx.sampleRate;
  const length = Math.max(1, Math.floor(seconds * rate));
  const preDelay = Math.floor(0.012 * rate);
  const impulse = ctx.createBuffer(2, length, rate);

  for (let channel = 0; channel < 2; channel++) {
    const data = impulse.getChannelData(channel);
    // A one-pole low-pass on the noise, run per channel with its own state, both
    // darkens the tail and decorrelates left from right, which widens it.
    let low = 0;
    for (let i = 0; i < length; i++) {
      if (i < preDelay) { data[i] = 0; continue; }
      const t = (i - preDelay) / (length - preDelay);
      const envelope = Math.pow(1 - t, decay);
      const noise = Math.random() * 2 - 1;
      low += (noise - low) * 0.35;                 // roll off the top
      data[i] = (noise * 0.4 + low * 0.6) * envelope;
    }
  }
  return impulse;
}
