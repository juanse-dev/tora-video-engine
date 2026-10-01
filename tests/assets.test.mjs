import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {describe, it} from "node:test";
import {inflateSync} from "node:zlib";
import {
  animationCatalog,
  backgroundAssets,
  backgroundCatalog,
  toraPoseAssets,
  toraPoseCatalog,
} from "../src/assets.ts";
import {
  animations,
  backgrounds,
  poses,
} from "../src/story/schema.ts";
import {exampleStory} from "../src/story/exampleStory.ts";
import {
  evaluateVisualDraft,
  storyToVisualDraft,
  updateVisualScene,
} from "../src/web/visualDraft.ts";

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const crcTable = Array.from({length: 256}, (_, value) => {
  let current = value;

  for (let bit = 0; bit < 8; bit += 1) {
    current =
      current & 1
        ? 0xedb88320 ^ (current >>> 1)
        : current >>> 1;
  }

  return current >>> 0;
});

const crc32 = (buffer) => {
  let crc = 0xffffffff;

  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
};

const validatePng = async (relativePath) => {
  const data = await readFile(resolve("public", relativePath));

  assert.deepEqual(
    data.subarray(0, PNG_SIGNATURE.length),
    PNG_SIGNATURE,
    `${relativePath}: invalid PNG signature`,
  );

  let offset = PNG_SIGNATURE.length;
  let sawHeader = false;
  let sawEnd = false;
  const compressedImageData = [];

  while (offset < data.length) {
    assert.ok(
      offset + 12 <= data.length,
      `${relativePath}: truncated PNG chunk`,
    );

    const length = data.readUInt32BE(offset);
    offset += 4;

    const type = data.subarray(offset, offset + 4);
    offset += 4;

    assert.ok(
      offset + length + 4 <= data.length,
      `${relativePath}: chunk exceeds file length`,
    );

    const payload = data.subarray(offset, offset + length);
    offset += length;

    const expectedCrc = data.readUInt32BE(offset);
    offset += 4;

    const chunkName = type.toString("ascii");
    const actualCrc = crc32(Buffer.concat([type, payload]));

    assert.equal(
      actualCrc,
      expectedCrc,
      `${relativePath}: invalid CRC for ${chunkName}`,
    );

    if (chunkName === "IHDR") {
      sawHeader = true;
    }

    if (chunkName === "IDAT") {
      compressedImageData.push(payload);
    }

    if (chunkName === "IEND") {
      sawEnd = true;
      break;
    }
  }

  assert.ok(sawHeader, `${relativePath}: missing IHDR`);
  assert.ok(
    compressedImageData.length > 0,
    `${relativePath}: missing IDAT`,
  );
  assert.ok(sawEnd, `${relativePath}: missing IEND`);
  assert.equal(
    offset,
    data.length,
    `${relativePath}: trailing bytes after IEND`,
  );

  assert.doesNotThrow(
    () => inflateSync(Buffer.concat(compressedImageData)),
    `${relativePath}: invalid compressed IDAT stream`,
  );
};

describe("PNG assets", () => {
  const assets = [
    ...Object.values(toraPoseAssets),
    ...Object.values(backgroundAssets),
  ];

  for (const asset of assets) {
    it(`validates ${asset}`, async () => {
      await validatePng(asset);
    });
  }
});


describe("WEB-004 asset catalog contract", () => {
  it("covers every Story pose exactly once", () => {
    assert.deepEqual(Object.keys(toraPoseCatalog), [...poses]);

    for (const pose of poses) {
      const asset = toraPoseCatalog[pose];

      assert.equal(asset.id, pose);
      assert.equal(asset.storyValue, pose);
      assert.equal(asset.category, "pose");
      assert.equal(toraPoseAssets[pose], asset.previewPath);
    }
  });

  it("covers every Story background exactly once", () => {
    assert.deepEqual(Object.keys(backgroundCatalog), [...backgrounds]);

    for (const background of backgrounds) {
      const asset = backgroundCatalog[background];

      assert.equal(asset.id, background);
      assert.equal(asset.storyValue, background);
      assert.equal(asset.category, "background");
      assert.equal(backgroundAssets[background], asset.previewPath);
    }
  });

  it("covers every explicit Story animation", () => {
    assert.deepEqual(Object.keys(animationCatalog), [...animations]);

    for (const animation of animations) {
      const asset = animationCatalog[animation];

      assert.equal(asset.id, animation);
      assert.equal(asset.storyValue, animation);
      assert.equal(asset.category, "animation");
      assert.equal(asset.previewPath, null);
    }
  });

  it("keeps catalog paths on the expected bundled public assets", () => {
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(toraPoseCatalog).map(([id, asset]) => [
          id,
          asset.previewPath,
        ]),
      ),
      {
        formal: "characters/tora/formal.png",
        confused: "characters/tora/confused.png",
        panic: "characters/tora/panic.png",
        coffee: "characters/tora/coffee.png",
      },
    );

    assert.deepEqual(
      Object.fromEntries(
        Object.entries(backgroundCatalog).map(([id, asset]) => [
          id,
          asset.previewPath,
        ]),
      ),
      {
        office: "backgrounds/office.png",
        "server-room": "backgrounds/server-room.png",
      },
    );
  });

  it("applies catalog selections through the visual draft candidate path", () => {
    let draft = storyToVisualDraft(exampleStory);

    draft = updateVisualScene(draft, 0, {
      pose: toraPoseCatalog.coffee.storyValue,
      background: backgroundCatalog["server-room"].storyValue,
      animation: animationCatalog.slowZoom.storyValue,
    });

    const result = evaluateVisualDraft(draft);

    assert.equal(result.kind, "eligible");
    assert.equal(result.story.scenes[0].pose, "coffee");
    assert.equal(result.story.scenes[0].background, "server-room");
    assert.equal(result.story.scenes[0].animation, "slowZoom");
  });
});
