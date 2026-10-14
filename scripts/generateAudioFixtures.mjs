// Generates the committed audio fixtures (AUDIO-003 task 2) with the repository's
// ffmpeg (the one in the installed @remotion/compositor-* package).
//
//   node scripts/generateAudioFixtures.mjs [outDir]     (default: tests/fixtures/local-audio)
//
// That ffmpeg is a minimal build: no anoisesrc, highpass, lowpass or afade, no
// Vorbis encoder (so there is no Ogg Vorbis fixture), and no m4a muxer name (the
// MP4 muxer is selected with `-f mp4`). Tones come from the `sine` source lifted
// to a unit-amplitude (full scale) sine; the noise is a seeded sum of sine
// partials below 2 kHz (the same technique as generateBundledAudio.mjs).
//
// The PCM files (.wav) match across platforms within 1 LSB. The lossy files
// (mp3, m4a, opus.ogg, mp4) are deterministic for one ffmpeg build only: the
// committed bytes are authoritative (Stories reference them by digest) and
// tests never compare them with a regenerated copy.

import {Buffer} from "node:buffer";
import {execFileSync} from "node:child_process";
import {mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {join, resolve} from "node:path";
import process from "node:process";
import {pathToFileURL} from "node:url";
import {resolveFfmpegBinaries} from "../tests/helpers/ffmpeg.mjs";
import {noise} from "./generateBundledAudio.mjs";

/** `sine` source lifted to a unit-amplitude sine (ffmpeg's `sine` peaks at 1/8). */
const tone = (hz, seconds, rate) =>
  `sine=f=${hz}:d=${seconds}:r=${rate},aformat=sample_fmts=fltp,volume=8`;

/** Seeded low-passed white noise: 64 partials, linear-uniform in [100, 2000] Hz, RMS 0.25. */
const noiseGraph = (seconds) =>
  `${noise({label: "n", seed: 21, count: 64, lo: 100, hi: 2000, tilt: 0, seconds, rms: 0.25, linear: true})};[n]aformat=sample_fmts=fltp[mono]`;

const MONO_TO_STEREO = "pan=stereo|c0=c0|c1=c0";
const MONO_TO_THREE = "pan=3.0|c0=c0|c1=c0|c2=c0";

/** The three tones, in every container: 220 Hz music, 440 Hz voice, 880 Hz effect. */
export const toneFixtures = [
  {hz: 220, seconds: 10, label: "220-10s"},
  {hz: 440, seconds: 2.2, label: "440-2.2s"},
  {hz: 880, seconds: 0.4, label: "880-0.4s"},
];

export const fixtureFiles = [
  ...toneFixtures.flatMap(({label}) => [
    `tone-${label}.mp3`,
    `tone-${label}.wav`,
    `tone-${label}.m4a`,
    `tone-${label}.opus.ogg`,
  ]),
  "tone-220-12s.wav",
  "noise-2s.mp3",
  "mono-440.wav",
  "three-channel.wav",
  "zero-channel.wav",
  "long-301s.mp3",
  "with-video.mp4",
  "truncated.mp3",
  "not-audio.txt",
];

/** Patches the `fmt ` channel count (RIFF offset 22) of a canonical 44-byte-header WAV. */
export const patchWavChannels = (bytes, channels) => {
  const out = Buffer.from(bytes);

  if (out.toString("ascii", 12, 16) !== "fmt ") {
    throw new Error("Expected a canonical WAV with `fmt ` as its first chunk.");
  }

  out.writeUInt16LE(channels, 22);
  return out;
};

export const generateAudioFixtures = (outDir) => {
  mkdirSync(outDir, {recursive: true});

  const {ffmpeg, dir} = resolveFfmpegBinaries();
  const env = {
    ...process.env,
    LD_LIBRARY_PATH: [dir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":"),
    DYLD_LIBRARY_PATH: [dir, process.env.DYLD_LIBRARY_PATH].filter(Boolean).join(":"),
  };
  const exec = (args) =>
    execFileSync(
      ffmpeg,
      [
        "-hide_banner", "-loglevel", "error", "-y",
        "-cpuflags", "0",
        "-bitexact", "-fflags", "+bitexact", "-flags:a", "+bitexact",
        "-filter_threads", "1", "-filter_complex_threads", "1",
        ...args,
      ],
      {env, windowsHide: true, stdio: ["ignore", "inherit", "inherit"]},
    );
  const path = (name) => join(outDir, name);
  // A graph ending in the `[out]` pad -> one file; `codec` are the output options.
  const render = (name, graph, codec, seconds) =>
    exec([
      "-filter_complex", graph, "-map", "[out]", "-map_metadata", "-1",
      ...codec, "-t", String(seconds), path(name),
    ]);
  const stereoTone = (hz, seconds, rate) =>
    `${tone(hz, seconds, 48_000)},aresample=${rate},${MONO_TO_STEREO}[out]`;

  for (const {hz, seconds, label} of toneFixtures) {
    render(`tone-${label}.wav`, stereoTone(hz, seconds, 48_000), ["-c:a", "pcm_s16le", "-f", "wav"], seconds);
    render(`tone-${label}.mp3`, stereoTone(hz, seconds, 44_100), ["-c:a", "libmp3lame", "-b:a", "128k", "-f", "mp3"], seconds);
    render(`tone-${label}.m4a`, stereoTone(hz, seconds, 44_100), ["-c:a", "aac", "-b:a", "128k", "-f", "mp4"], seconds);
    render(`tone-${label}.opus.ogg`, stereoTone(hz, seconds, 48_000), ["-c:a", "libopus", "-b:a", "96k", "-f", "ogg"], seconds);
  }

  render("tone-220-12s.wav", stereoTone(220, 12, 48_000), ["-c:a", "pcm_s16le", "-f", "wav"], 12);
  render("noise-2s.mp3", `${noiseGraph(2)};[mono]aresample=44100,${MONO_TO_STEREO}[out]`, ["-c:a", "libmp3lame", "-b:a", "128k", "-f", "mp3"], 2);
  render("mono-440.wav", `${tone(440, 2.2, 48_000)}[out]`, ["-c:a", "pcm_s16le", "-f", "wav"], 2.2);
  render("three-channel.wav", `${tone(440, 0.4, 48_000)},${MONO_TO_THREE}[out]`, ["-c:a", "pcm_s16le", "-f", "wav"], 0.4);
  writeFileSync(path("zero-channel.wav"), patchWavChannels(readFileSync(path("mono-440.wav")), 0));
  render("long-301s.mp3", `${tone(220, 301, 8_000)}[out]`, ["-c:a", "libmp3lame", "-b:a", "8k", "-f", "mp3"], 301);

  // A video track plus an audio track: the video check must win. The lavfi video
  // input needs a decoder this build lacks, so both sources live in the filtergraph.
  exec([
    "-filter_complex",
    `nullsrc=s=64x64:r=10:d=1,format=yuv420p[v];${tone(440, 1, 48_000)}[a]`,
    "-map", "[v]", "-map", "[a]", "-map_metadata", "-1",
    "-flags:v", "+bitexact", "-c:v", "libx264", "-preset", "ultrafast", "-threads", "1",
    "-x264-params", "threads=1:sliced-threads=0", "-c:a", "aac", "-b:a", "64k", "-t", "1",
    "-f", "mp4", path("with-video.mp4"),
  ]);

  const full = readFileSync(path("tone-220-10s.mp3"));

  writeFileSync(path("truncated.mp3"), full.subarray(0, Math.floor(full.length * 0.6)));
  writeFileSync(path("not-audio.txt"), "This is not an audio file.\n");
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  generateAudioFixtures(resolve(process.argv[2] ?? "tests/fixtures/local-audio"));
}
