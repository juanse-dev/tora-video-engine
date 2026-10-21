// The one Story and the one set of measurements that the browser render
// (tests/browser/audio-rendering.spec.mjs, system Chrome) and the CLI render
// (tests/cli-local-assets.e2e.mjs) share, so "both MP4s sound the same" is
// asserted against a single definition (AUDIO-005 integration; AUDIO-006
// builds its parity measurements on tests/helpers/audioEnvelope.mjs).
//
// The imported voice is a pure 440 Hz tone for 2.2 s. The bundled `ding` is a
// CC0 bell recording (public/audio/sfx/ding.wav, 1.8 s): its dominant frequency
// is 2640 Hz (about 0.2 amplitude in its first 100 ms, measured on the file) with
// a 6870 Hz partial that is gone after about 0.2 s, and the 2640 Hz component
// decays to under 0.002 by 1.5 s.

import assert from "node:assert/strict";
import {goertzelWindows} from "./audioEnvelope.mjs";

export const INTEGRATION_VOICE_FIXTURE = "tone-440-2.2s.wav";
export const DING_HZ = 2640;
export const DING_PARTIAL_HZ = 6870;

/**
 * Scene 1: a ding at 0 s, 2 s long. Scene 2: the imported voice at 2 s, with
 * the scene length taken from the voice (2.2 s + 0.5 s = 81 frames).
 * Total: 141 frames = 4.7 s.
 */
export const integrationStoryYaml = (voiceRef) =>
  [
    "title: Audio integration",
    "scenes:",
    "  - type: intro",
    "    pose: formal",
    "    background: office",
    "    animation: fade",
    '    text: "Ding first."',
    "    sfx:",
    "      src: ding",
    "    duration: 2",
    "  - type: dialogue",
    "    pose: formal",
    "    background: office",
    "    animation: fade",
    '    text: "Then the voice."',
    "    voice:",
    `      src: ${voiceRef}`,
    "    duration: auto",
    "",
  ].join("\n");

export const INTEGRATION_FRAMES = 141;
export const INTEGRATION_SECONDS = INTEGRATION_FRAMES / 30;

const window100 = (samples, hz) => goertzelWindows(samples, hz, 100);
const max = (values) => Math.max(...values);

/**
 * What a render of `integrationStoryYaml` must sound like, measured on the
 * decoded mono samples of the MP4 (100 ms Goertzel windows, 48 kHz).
 */
export const assertIntegrationEnvelope = (samples, label) => {
  const seconds = samples.length / 48_000;
  const ding = window100(samples, DING_HZ);
  const dingPartial = window100(samples, DING_PARTIAL_HZ);
  const voice = window100(samples, 440);
  const message = (what) => `${label}: ${what}`;

  // Length: the Story's 4.7 s, with a little encoder padding.
  assert.ok(
    seconds >= INTEGRATION_SECONDS - 0.1 && seconds <= INTEGRATION_SECONDS + 0.2,
    message(`${seconds.toFixed(3)} s long`),
  );

  // The ding sounds at the first scene's start, fundamental and partial (positive
  // control). In the file the fundamental reads 0.20 and 0.16 in its first two
  // windows and the partial 0.06 then 0.014 (only the first is asserted). D-15
  // allows the audio to start up to 60 ms off; at that offset window 0 reads 0.0535
  // (fundamental) and 0.028 (partial), so the thresholds sit under those: window 0
  // > 0.03, window 1 > 0.05, partial window 0 > 0.015.
  assert.ok(ding[0] > 0.03 && ding[1] > 0.05, message(`ding at 0 s: ${ding.slice(0, 3)}`));
  assert.ok(dingPartial[0] > 0.015, message(`ding partial at 0 s: ${dingPartial.slice(0, 3)}`));
  // ...while the 440 Hz voice has not started: nothing at 440 Hz before 2 s.
  assert.ok(max(voice.slice(0, 19)) < 0.02, message(`440 Hz before the voice: ${max(voice.slice(0, 19))}`));

  // The ding has decayed before the voice starts, and does not return.
  assert.ok(max(ding.slice(15)) < 0.01, message(`${DING_HZ} Hz after 1.5 s: ${max(ding.slice(15))}`));

  // The voice is present for its 2.2 s, at about the fixture's level (windows 2.1 s - 4.1 s).
  for (const amplitude of voice.slice(21, 41)) {
    assert.ok(amplitude > 0.5, message(`voice windows: ${voice.slice(21, 41)}`));
  }

  // ...and silent after it ends (the scene's 0.5 s of padding).
  assert.ok(max(voice.slice(43)) < 0.02, message(`440 Hz after the voice: ${max(voice.slice(43))}`));
};

/**
 * AINV-9 on an ffprobe stream: AAC-LC, 48 kHz, stereo, and (native AAC and the
 * CLI) about 128 kb/s, +-10%. `{bitrate: false}` skips the bitrate range for the
 * WASM AAC encoder, which ignores the requested bitrate (D-13 accepts it): the
 * stream then only has to carry data. The repository ffprobe names the LC
 * profile "1", other builds "LC".
 */
export const assertAacLcStereoStream = (stream, label, {bitrate = true} = {}) => {
  assert.equal(stream.codec_type, "audio", label);
  assert.equal(stream.codec_name, "aac", label);
  assert.ok(["LC", "1"].includes(stream.profile), `${label}: profile ${stream.profile}`);
  assert.equal(Number(stream.sample_rate), 48_000, label);
  assert.equal(stream.channels, 2, label);

  const bitRate = Number(stream.bit_rate);

  if (bitrate) {
    assert.ok(bitRate >= 115_200 && bitRate <= 140_800, `${label}: ${bitRate} b/s`);
  } else {
    assert.ok(bitRate > 0, `${label}: ${bitRate} b/s`);
  }
};
