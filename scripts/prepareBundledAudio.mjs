// Prepares the four bundled sound effects (AUDIO-001 task 6) from the CC0
// recordings the owner chose on Freesound, with the repository's ffmpeg (the one
// in the installed @remotion/compositor-* package).
//
//   node scripts/prepareBundledAudio.mjs <originalsDir> [outDir]   (default outDir: public/audio/sfx)
//
// <originalsDir> holds the original downloads (they are not committed; see
// `originals` below for the file names and the sha256 each must have: a file
// with another hash is refused before anything is written). Output is
// <id>.wav, 48 kHz stereo 16-bit PCM, written only after all four succeeded.
// Verified on Windows only: there two runs are byte-identical and equal the
// committed files; on other platforms the resampler or MP3 decoder may differ by
// a LSB (the reproduction test allows 1 LSB and skips in CI, which has no
// originals). Per effect (the table below is the whole recipe):
//
//   1. mono is copied to both channels (no -3 dB pan law), then resampled to 48 kHz;
//   2. `start` seconds of leading silence are cut and the sound is cut after
//      `length` seconds, both as exact sample counts (`length` is a whole
//      multiple of 10 ms, so the WAV duration is an exact decimal);
//   3. `gainDb` is applied (0 = untouched);
//   4. a 2 ms fade-in and a `fadeOut` fade-out take the cut edges to zero.
//
// Steps 1-3 are ffmpeg filters. Step 4 is done on the decoded samples here: that
// ffmpeg is a minimal build without `afade`, and its `volume` filter evaluates a
// time expression once per decoder frame (1024-4096 samples = 21-85 ms), far too
// coarse for a 20-60 ms fade. The WAV header is the plain 44-byte PCM header
// that ffmpeg's bitexact wav muxer writes.

import {Buffer} from "node:buffer";
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import process from "node:process";
import {pathToFileURL} from "node:url";
import {resolveFfmpegBinaries} from "./ffmpegBinary.mjs";

export const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const BYTES_PER_FRAME = CHANNELS * 2;
const FADE_IN_SECONDS = 0.002;

/**
 * id -> the original and how it is cut. `start`/`length`/`fadeOut` in seconds.
 * `start` is a few milliseconds before the first audible sample (>= -50 dBFS,
 * measured on the 48 kHz decode), so no transient is cut; `length` ends where
 * the tail is below about -60 dBFS (the whoosh, a 0.426 s clip that ends while
 * still at about -42 dBFS, is cut 6 ms earlier and faded). Peaks, measured: the
 * boom is -0.12 dBFS and is lowered by 0.9 dB; the others are inside
 * -6..-0.5 dBFS untouched.
 */
export const originals = {
  whoosh: {
    file: "60013__qubodup__whoosh.flac",
    sha256: "7159ba26b74840da53965989c1472807891298528f94d720119777c251b3109e",
    source: "https://freesound.org/people/qubodup/sounds/60013/",
    channels: "stereo",
    start: 0,
    length: 0.42,
    gainDb: 0,
    fadeOut: 0.04,
  },
  boom: {
    file: "201571__julien_matthey__jm_fx_boom-01a.wav",
    sha256: "3346053c75d2ae5ea9ec4f1e4ebb4897588e449a7f24ca6f85202b3f87207172",
    source: "https://freesound.org/people/Julien_Matthey/sounds/201571/",
    channels: "stereo",
    start: 0,
    length: 3.2,
    gainDb: -0.9,
    fadeOut: 0.05,
  },
  ding: {
    file: "407258__saya13__ding-idea.mp3",
    sha256: "0ad1851c8677f6ceda7490fb362aeaf0691a5ed352a14a081e5c590e350cd3f7",
    source: "https://freesound.org/people/Saya13/sounds/407258/",
    channels: "stereo",
    start: 0.705,
    length: 1.8,
    gainDb: 0,
    fadeOut: 0.06,
  },
  pop: {
    file: "202230__deraj__pop-sound.wav",
    sha256: "b3097f661b59b429e8bdbbd90b0e94f9b71fe4cb17f0a550fb1a9af0d194ac61",
    source: "https://freesound.org/people/deraj/sounds/202230/",
    channels: "mono",
    start: 0.19,
    length: 0.25,
    gainDb: 0,
    fadeOut: 0.02,
  },
};

/** Seconds to a whole number of samples at 48 kHz. */
const samplesOf = (value) => Math.round(value * SAMPLE_RATE);

/** Throws unless every original is in `dir` with the sha256 of the recording the owner chose. */
export const checkOriginals = (dir) => {
  for (const [id, {file, sha256}] of Object.entries(originals)) {
    const path = join(dir, file);

    if (!existsSync(path)) {
      throw new Error(`${id}: the original ${file} is missing from ${dir}`);
    }

    const actual = createHash("sha256").update(readFileSync(path)).digest("hex");

    if (actual !== sha256) {
      throw new Error(`${id}: ${file} has sha256 ${actual}, expected ${sha256}; refusing a file that is not the chosen recording`);
    }
  }
};

/** The ffmpeg `-af` chain for one effect: steps 1-3 of the recipe. */
export const filterChain = ({channels, start, length, gainDb}) => {
  const first = samplesOf(start);
  const pan = channels === "mono" ? "pan=stereo|c0=c0|c1=c0" : "pan=stereo|c0=c0|c1=c1";
  const chain = [
    pan,
    `aresample=${SAMPLE_RATE}`,
    "aformat=sample_fmts=fltp",
    `atrim=start_sample=${first}:end_sample=${first + samplesOf(length)}`,
    "asetpts=PTS-STARTPTS",
  ];

  if (gainDb !== 0) {
    chain.push(`volume=${(10 ** (gainDb / 20)).toFixed(6)}:precision=double`);
  }

  return chain.join(",");
};

/** Step 4: linear fade-in over the first and fade-out over the last samples of interleaved 16-bit stereo PCM, in place. */
export const applyFades = (pcm, fadeOutSeconds) => {
  const frames = pcm.length / BYTES_PER_FRAME;
  const fadeIn = samplesOf(FADE_IN_SECONDS);
  const fadeOut = samplesOf(fadeOutSeconds);

  for (let frame = 0; frame < frames; frame += 1) {
    const gain = Math.min(1, (frame + 1) / fadeIn, (frames - frame) / fadeOut);

    if (gain < 1) {
      for (let channel = 0; channel < CHANNELS; channel += 1) {
        const at = frame * BYTES_PER_FRAME + channel * 2;

        pcm.writeInt16LE(Math.round(pcm.readInt16LE(at) * gain), at);
      }
    }
  }
};

/** The samples of the `data` chunk of a WAV file, as a copy. */
const dataChunk = (bytes) => {
  let offset = 12;

  while (offset + 8 <= bytes.length) {
    const size = bytes.readUInt32LE(offset + 4);

    if (bytes.toString("ascii", offset, offset + 4) === "data") {
      return Buffer.from(bytes.subarray(offset + 8, offset + 8 + size));
    }

    offset += 8 + size + (size % 2);
  }

  throw new Error("ffmpeg wrote a WAV without a data chunk");
};

/** A 44-byte PCM WAV header followed by `pcm`. */
export const wavFile = (pcm) => {
  const header = Buffer.alloc(44);

  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);                          // PCM
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * BYTES_PER_FRAME, 28);
  header.writeUInt16LE(BYTES_PER_FRAME, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
};

/**
 * Copies every prepared <id>.wav from `readyDir` into `outDir` as one set: the
 * files it replaces are read first, and if any copy fails every file already
 * copied (and the one that failed) is put back as it was, or removed when it did
 * not exist, and a directory this call created is removed. `copy` replaces
 * `copyFileSync` (tests inject a failure).
 */
export const publishPrepared = (readyDir, outDir, {copy = copyFileSync} = {}) => {
  const createdDir = !existsSync(outDir);
  const ids = Object.keys(originals);
  const target = (id) => join(outDir, `${id}.wav`);

  mkdirSync(outDir, {recursive: true});

  const previous = new Map(ids.map((id) => [id, existsSync(target(id)) ? readFileSync(target(id)) : null]));
  const touched = [];

  try {
    for (const id of ids) {
      touched.push(id);
      copy(join(readyDir, `${id}.wav`), target(id));
    }
  } catch (error) {
    for (const id of touched) {
      const bytes = previous.get(id);

      if (bytes === null) {
        rmSync(target(id), {force: true});
      } else {
        writeFileSync(target(id), bytes);
      }
    }

    if (createdDir) {
      rmSync(outDir, {recursive: true, force: true});
    }

    throw error;
  }
};

/**
 * Writes <id>.wav for every effect into `outDir`, after checking every original in
 * `originalsDir`. All four are prepared in a scratch directory first and published
 * to `outDir` only when all four succeeded, as one set (`publishPrepared`), so a
 * failure never leaves a mixed set. `execute` replaces `execFileSync` (tests inject
 * a failure).
 */
export const prepareBundledAudio = (originalsDir, outDir, {execute = execFileSync} = {}) => {
  checkOriginals(originalsDir);

  const {ffmpeg, dir} = resolveFfmpegBinaries();
  const env = {
    ...process.env,
    LD_LIBRARY_PATH: [dir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":"),
    DYLD_LIBRARY_PATH: [dir, process.env.DYLD_LIBRARY_PATH].filter(Boolean).join(":"),
  };

  // This ffmpeg has no raw PCM muxer: it writes a WAV, whose data chunk is read back.
  const scratch = mkdtempSync(join(tmpdir(), "tora-sfx-prepare-"));
  const ready = join(scratch, "ready");

  try {
    mkdirSync(ready);

    for (const [id, recipe] of Object.entries(originals)) {
      const decoded = join(scratch, `${id}.wav`);

      execute(
        ffmpeg,
        [
          "-hide_banner", "-loglevel", "error", "-y",
          // No CPU-specific code paths: SIMD float accumulation in the resampler
          // can differ in the last bit from the C path.
          "-cpuflags", "0",
          "-bitexact", "-fflags", "+bitexact", "-flags:a", "+bitexact",
          "-filter_threads", "1", "-filter_complex_threads", "1",
          "-i", join(originalsDir, recipe.file),
          "-af", filterChain(recipe),
          "-map_metadata", "-1",
          "-ar", String(SAMPLE_RATE), "-ac", String(CHANNELS), "-c:a", "pcm_s16le",
          "-f", "wav", decoded,
        ],
        {env, windowsHide: true, stdio: ["ignore", "inherit", "inherit"]},
      );

      const pcm = dataChunk(readFileSync(decoded));
      const expected = samplesOf(recipe.length) * BYTES_PER_FRAME;

      if (pcm.length !== expected) {
        throw new Error(`${id}: ffmpeg produced ${pcm.length} bytes, expected ${expected}; the original is shorter than start + length`);
      }

      applyFades(pcm, recipe.fadeOut);
      writeFileSync(join(ready, `${id}.wav`), wavFile(pcm));
    }

    publishPrepared(ready, outDir);
  } finally {
    rmSync(scratch, {recursive: true, force: true});
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) {
    process.stderr.write("usage: node scripts/prepareBundledAudio.mjs <originalsDir> [outDir]\n");
    process.exit(2);
  }

  try {
    prepareBundledAudio(resolve(process.argv[2]), resolve(process.argv[3] ?? "public/audio/sfx"));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
