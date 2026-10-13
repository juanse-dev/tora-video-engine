// Synthesizes the four bundled sound effects (AUDIO-001 task 6) with the
// repository's ffmpeg (the one in the installed @remotion/compositor-* package).
//
//   node scripts/generateBundledAudio.mjs [outDir]     (default: public/audio/sfx)
//
// Output is 48 kHz stereo 16-bit PCM WAV, written with the bitexact flags.
// A test hashes the output against the committed files.
//
// That ffmpeg is a minimal build: it has no anoisesrc, highpass, lowpass or
// afade. Noise is therefore a sum of sine partials at seeded pseudo-random
// frequencies (log-uniform in the band, equal weights = pink, weights ~ f^-0.5
// = brown, which also gives the band-pass), and every fade or decay is a gain
// envelope evaluated per 8-sample frame by `volume ... eval=frame`. The decay
// uses only multiplications (no exp or pow), so the envelope does not depend
// on the platform's libm. Seeds: whoosh 7, boom 11.

import {execFileSync} from "node:child_process";
import {mkdirSync} from "node:fs";
import {join, resolve} from "node:path";
import process from "node:process";
import {pathToFileURL} from "node:url";
import {resolveFfmpegBinaries} from "../tests/helpers/ffmpeg.mjs";

const SAMPLE_RATE = 48_000;
const FRAME = 8; // samples per source frame: the envelope's time resolution (0.17 ms)
// ffmpeg's `sine` source peaks at 1/8 of full scale (measured); every partial is
// lifted by SINE_LIFT to a unit-amplitude sine, so the gains below are literal.
const SINE_LIFT = 8;

/** mulberry32: integer-only PRNG, identical on every platform. */
const prng = (seed) => {
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
const sine = (label, hz, seconds, {delay = 0, gain = 1} = {}) =>
  `sine=f=${num(hz)}:d=${seconds}:r=${SAMPLE_RATE}:samples_per_frame=${FRAME}` +
  (delay > 0 ? `,adelay=delays=${delay}S` : "") +
  `,aformat=sample_fmts=fltp,volume=${num(SINE_LIFT * gain)}` +
  `[${label}]`;

/**
 * Band-limited noise: `count` partials log-uniform in [lo, hi] Hz, each with a
 * random start delay (phase), mixed to a mono `[label]`. `tilt` 0 is pink,
 * -0.5 is brown. `rms` is the target RMS of the result.
 */
const noise = ({label, seed, count, lo, hi, tilt, seconds, rms}) => {
  const next = prng(seed);
  const parts = [];
  const weights = [];
  const labels = [];
  for (let i = 0; i < count; i += 1) {
    const hz = lo * (hi / lo) ** next();
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

/** Gain expression: linear ramp up over `fadeIn` s, linear ramp down over the last `fadeOut` s of `total`. */
const linearEnvelope = (gain, fadeIn, fadeOut, total) =>
  `${gain}*max(0,min(min(1,t/${fadeIn}),(${total}-t)/${fadeOut}))`;

/**
 * Gain expression: `gain`, a linear attack over `attack` s (0 = none), then from
 * `start` s an exponential-style decay of `decibels` over `length` s,
 * (1 - u/64)^64 with u = ln(10^(decibels/20)) * progress, by 6 squarings.
 */
const decayEnvelope = (gain, attack, start, length, decibels) => {
  const k = (decibels / 20) * Math.LN10;
  const squarings = "st(0,ld(0)*ld(0));".repeat(6);
  const ramp = attack > 0 ? `min(1,t/${attack})` : "1";
  return (
    `st(0,max(0,1-${num(k)}*max(0,t-${start})/${length}/64));${squarings}` +
    `${gain}*${ramp}*ld(0)`
  );
};

const volumeNode = (expression) => `volume=volume='${expression}':eval=frame:precision=double`;
const toStereo = "pan=stereo|c0=c0|c1=c0";

/** id -> length in seconds and the filtergraph that ends in the `[out]` pad. */
export const effects = {
  // Pink noise 400-4000 Hz, swelling in over 0.25 s and out over the last 0.3 s.
  whoosh: {
    seconds: 0.6,
    graph:
      `${noise({label: "n", seed: 7, count: 32, lo: 400, hi: 4000, tilt: 0, seconds: 0.6, rms: 0.2})};` +
      `[n]${volumeNode(linearEnvelope(1, 0.25, 0.3, 0.6))},${toStereo}[out]`,
  },
  // 55 Hz sine plus a 0.08 s brown-noise burst, decaying from 0.05 s.
  boom: {
    seconds: 0.8,
    graph:
      `${sine("tone", 55, 0.8, {gain: 0.35})};` +
      `${noise({label: "b", seed: 11, count: 24, lo: 30, hi: 400, tilt: -0.5, seconds: 0.08, rms: 0.1})};` +
      "[b]apad=whole_dur=0.8[burst];" +
      "[tone][burst]amix=inputs=2:duration=longest:normalize=0," +
      `${volumeNode(decayEnvelope(1, 0, 0.05, 0.75, 100))},${toStereo}[out]`,
  },
  // 880 Hz plus a 1760 Hz partial at 0.4, volume 0.5, decaying from 0.02 s.
  ding: {
    seconds: 1.2,
    graph:
      `${sine("low", 880, 1.2)};` +
      `${sine("high", 1760, 1.2, {gain: 0.4})};` +
      "[low][high]amix=inputs=2:duration=longest:normalize=0," +
      `${volumeNode(decayEnvelope(0.5, 0, 0.02, 1.18, 100))},${toStereo}[out]`,
  },
  // 1.2 kHz click: volume 0.7, 4 ms attack, decaying from 0.01 s.
  pop: {
    seconds: 0.12,
    graph:
      `${sine("tone", 1200, 0.12)};` +
      `[tone]${volumeNode(decayEnvelope(0.7, 0.004, 0.01, 0.11, 100))},${toStereo}[out]`,
  },
};

/** Writes <id>.wav for every effect into `outDir`. */
export const generateBundledAudio = (outDir) => {
  mkdirSync(outDir, {recursive: true});

  const {ffmpeg, dir} = resolveFfmpegBinaries();
  const env = {
    ...process.env,
    LD_LIBRARY_PATH: [dir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":"),
    DYLD_LIBRARY_PATH: [dir, process.env.DYLD_LIBRARY_PATH].filter(Boolean).join(":"),
  };

  for (const [id, {seconds, graph}] of Object.entries(effects)) {
    execFileSync(
      ffmpeg,
      [
        "-hide_banner", "-loglevel", "error", "-y",
        // No CPU-specific code paths: SIMD (FMA, AVX) float accumulation in amix
        // can differ in the last bit from the C path.
        "-cpuflags", "0",
        "-bitexact", "-fflags", "+bitexact", "-flags:a", "+bitexact",
        "-filter_threads", "1", "-filter_complex_threads", "1",
        "-filter_complex", graph, "-map", "[out]",
        "-map_metadata", "-1",
        "-ar", String(SAMPLE_RATE), "-ac", "2", "-c:a", "pcm_s16le",
        "-t", String(seconds), "-f", "wav",
        join(outDir, `${id}.wav`),
      ],
      {env, windowsHide: true, stdio: ["ignore", "inherit", "inherit"]},
    );
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  generateBundledAudio(resolve(process.argv[2] ?? "public/audio/sfx"));
}
