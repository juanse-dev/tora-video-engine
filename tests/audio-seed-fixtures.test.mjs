import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {audioMimeTypeFor, inspectAudio} from "../src/localAssets/audioInspection.ts";
import {fixtureBytes} from "./helpers/audioBytes.mjs";
import {
  audioWavRecord,
  TRUNCATED_MP3_METADATA,
  truncatedMp3Record,
} from "./browser/helpers/seedAssetLibrary.mjs";

describe("the audio records that the browser specs seed", () => {
  it("the truncated MP3 record carries exactly what inspectAudio reports, so the integrity check accepts it", async () => {
    const inspected = await inspectAudio(fixtureBytes("truncated.mp3"));

    assert.equal(inspected.ok, true);
    assert.deepEqual(TRUNCATED_MP3_METADATA, {
      kind: "audio",
      mimeType: audioMimeTypeFor(inspected.metadata.container),
      ...inspected.metadata,
    });

    const record = await truncatedMp3Record();

    assert.equal(record.meta.byteSize, fixtureBytes("truncated.mp3").length);
    assert.match(record.ref, /^local:audio:sha256:[0-9a-f]{64}$/u);
  });

  it("the WAV record used by the render specs matches inspectAudio too (duration 2.2 s)", async () => {
    const record = await audioWavRecord("tone-440-2.2s.wav");
    const inspected = await inspectAudio(fixtureBytes("tone-440-2.2s.wav"));

    assert.equal(record.meta.durationSeconds, inspected.metadata.durationSeconds);
    assert.equal(record.meta.sampleRate, inspected.metadata.sampleRate);
  });
});
