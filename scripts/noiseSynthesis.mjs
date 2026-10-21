// Seeded band-limited noise for the audio fixture generator
// (scripts/generateAudioFixtures.mjs), built only from filters the repository's
// ffmpeg has. That ffmpeg is a minimal build without anoisesrc, highpass, lowpass
// or afade, so noise is a sum of `sine` partials at seeded pseudo-random
// frequencies. (The bundled sound effects used to be synthesized this way; they
// are CC0 recordings now, see scripts/prepareBundledAudio.mjs.)

export const SAMPLE_RATE = 48_000;
const FRAME = 8; // samples per source frame: the envelope's time resolution (0.17 ms)
// ffmpeg's `sine` source peaks at 1/8 of full scale (measured); every partial is
// lifted by SINE_LIFT to a unit-amplitude sine, so the gains below are literal.
const SINE_LIFT = 8;

/** mulberry32: integer-only PRNG, identical on every platform. */
export const prng = (seed) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const num = (value) => value.toFixed(4);

/** `sine` source node: `[label]` receives `seconds` of `hz`, delayed by `delay` samples and lifted to a unit sine and scaled by `gain`. */
export const sine = (label, hz, seconds, {delay = 0, gain = 1} = {}) =>
  `sine=f=${num(hz)}:d=${seconds}:r=${SAMPLE_RATE}:samples_per_frame=${FRAME}` +
  (delay > 0 ? `,adelay=delays=${delay}S` : "") +
  `,aformat=sample_fmts=fltp,volume=${num(SINE_LIFT * gain)}` +
  `[${label}]`;

/**
 * Band-limited noise: `count` partials in [lo, hi] Hz, each with a
 * random start delay (phase), mixed to a mono `[label]`. The frequencies are
 * log-uniform by default and linear-uniform when `linear` is true (low-passed
 * white noise rather than pink/brown). `tilt` 0 is pink,
 * -0.5 is brown. `rms` is the target RMS of the result.
 */
export const noise = ({label, seed, count, lo, hi, tilt, seconds, rms, linear = false}) => {
  const next = prng(seed);
  const parts = [];
  const weights = [];
  const labels = [];
  for (let i = 0; i < count; i += 1) {
    const hz = linear ? lo + (hi - lo) * next() : lo * (hi / lo) ** next();
    parts.push(sine(`${label}${i}`, hz, seconds, {delay: Math.floor(next() * 96)}));
    weights.push(hz ** tilt);
    labels.push(`[${label}${i}]`);
  }
  const power = weights.reduce((sum, w) => sum + w ** 2 / 2, 0);
  const scale = rms / Math.sqrt(power);
  return (
    `${parts.join(";")};` +
    `${labels.join("")}amix=inputs=${count}:duration=longest:normalize=0:` +
    `weights='${weights.map((w) => num(w * scale)).join(" ")}'[${label}]`
  );
};
