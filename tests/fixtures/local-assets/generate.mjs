// Regenerates the test-only local-asset fixtures in this directory.
//
//   node tests/fixtures/local-assets/generate.mjs
//
// - pose-magenta.png: generated in Node (zlib), 600x900 RGBA.
// - background-cyan.jpg / background-noext: generated in system Chrome
//   (Playwright `channel: "chrome"`) with OffscreenCanvas.convertToBlob.
// Every output is then decoded in Chrome and its dimensions and sample
// pixels are verified before the script finishes.

import {mkdir, writeFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {deflateSync} from "node:zlib";
import {chromium} from "@playwright/test";
import {PNG_SIGNATURE, concatBytes, pngChunk} from "../../helpers/imageBytes.mjs";

const outDir = fileURLToPath(new URL("./", import.meta.url));

const POSE = {width: 600, height: 900};
const POSE_RECT = {x: 150, y: 225, width: 300, height: 450};
const BACKGROUND = {width: 1080, height: 1920};

const u32be = (value) =>
  new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);

const buildPoseMagentaPng = () => {
  const {width, height} = POSE;
  const stride = 1 + width * 4;
  const raw = Buffer.alloc(stride * height); // zero-filled: filter 0, transparent

  for (let y = POSE_RECT.y; y < POSE_RECT.y + POSE_RECT.height; y += 1) {
    for (let x = POSE_RECT.x; x < POSE_RECT.x + POSE_RECT.width; x += 1) {
      const offset = y * stride + 1 + x * 4;
      raw[offset] = 255;
      raw[offset + 1] = 0;
      raw[offset + 2] = 255;
      raw[offset + 3] = 255;
    }
  }

  return concatBytes(
    PNG_SIGNATURE,
    pngChunk(
      "IHDR",
      concatBytes(u32be(width), u32be(height), new Uint8Array([8, 6, 0, 0, 0])),
    ),
    pngChunk("IDAT", deflateSync(raw, {level: 9})),
    pngChunk("IEND"),
  );
};

const browserWork = async (page, pngBytes) =>
  page.evaluate(
    async ({background, pngBase64, pose, poseRect}) => {
      const toBase64 = async (blob) => {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = "";
        for (let index = 0; index < bytes.length; index += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
        }
        return btoa(binary);
      };

      const canvas = new OffscreenCanvas(background.width, background.height);
      const context = canvas.getContext("2d");
      context.fillStyle = "#00ffff";
      context.fillRect(0, 0, background.width, background.height / 2);
      context.fillStyle = "#ffff00";
      context.fillRect(
        0,
        background.height / 2,
        background.width,
        background.height / 2,
      );

      const jpegBlob = await canvas.convertToBlob({
        type: "image/jpeg",
        quality: 0.92,
      });
      const webpBlob = await canvas.convertToBlob({
        type: "image/webp",
        quality: 0.9,
      });

      const sample = async (blob, points) => {
        const bitmap = await createImageBitmap(blob);
        const probe = new OffscreenCanvas(bitmap.width, bitmap.height);
        const probeContext = probe.getContext("2d");
        probeContext.drawImage(bitmap, 0, 0);
        const result = {
          width: bitmap.width,
          height: bitmap.height,
          pixels: points.map(([x, y]) =>
            Array.from(probeContext.getImageData(x, y, 1, 1).data),
          ),
        };
        bitmap.close();
        return result;
      };

      const pngBinary = atob(pngBase64);
      const pngArray = new Uint8Array(pngBinary.length);
      for (let index = 0; index < pngBinary.length; index += 1) {
        pngArray[index] = pngBinary.charCodeAt(index);
      }

      const backgroundPoints = [
        [10, 10],
        [background.width - 10, 10],
        [10, background.height - 10],
        [background.width - 10, background.height - 10],
      ];

      return {
        jpegType: jpegBlob.type,
        webpType: webpBlob.type,
        jpegBase64: await toBase64(jpegBlob),
        webpBase64: await toBase64(webpBlob),
        jpeg: await sample(jpegBlob, backgroundPoints),
        webp: await sample(webpBlob, backgroundPoints),
        png: await sample(new Blob([pngArray], {type: "image/png"}), [
          [5, 5],
          [poseRect.x + poseRect.width / 2, poseRect.y + poseRect.height / 2],
          [pose.width - 5, pose.height - 5],
        ]),
      };
    },
    {
      background: BACKGROUND,
      pngBase64: Buffer.from(pngBytes).toString("base64"),
      pose: POSE,
      poseRect: POSE_RECT,
    },
  );

const near = (actual, expected, tolerance = 24) =>
  actual.length === expected.length &&
  actual.every((value, index) => Math.abs(value - expected[index]) <= tolerance);

const assertOk = (condition, message) => {
  if (!condition) {
    throw new Error(`Fixture verification failed: ${message}`);
  }
};

const verifyBackground = (name, type, expectedType, result) => {
  assertOk(type === expectedType, `${name} MIME type was ${type}`);
  assertOk(
    result.width === BACKGROUND.width && result.height === BACKGROUND.height,
    `${name} decoded as ${result.width}x${result.height}`,
  );
  const [topLeft, topRight, bottomLeft, bottomRight] = result.pixels;
  assertOk(near(topLeft, [0, 255, 255, 255]), `${name} top-left is ${topLeft}`);
  assertOk(near(topRight, [0, 255, 255, 255]), `${name} top-right is ${topRight}`);
  assertOk(near(bottomLeft, [255, 255, 0, 255]), `${name} bottom-left is ${bottomLeft}`);
  assertOk(near(bottomRight, [255, 255, 0, 255]), `${name} bottom-right is ${bottomRight}`);
};

const pngBytes = buildPoseMagentaPng();

const browser = await chromium.launch({channel: "chrome", headless: true});

try {
  const page = await browser.newPage();
  await page.goto("about:blank");
  const result = await browserWork(page, pngBytes);

  verifyBackground("background-cyan.jpg", result.jpegType, "image/jpeg", result.jpeg);
  verifyBackground("background-noext", result.webpType, "image/webp", result.webp);

  assertOk(
    result.png.width === POSE.width && result.png.height === POSE.height,
    `pose-magenta.png decoded as ${result.png.width}x${result.png.height}`,
  );
  const [corner, center, otherCorner] = result.png.pixels;
  assertOk(corner[3] === 0, "pose-magenta.png corner should be transparent");
  assertOk(otherCorner[3] === 0, "pose-magenta.png corner should be transparent");
  assertOk(near(center, [255, 0, 255, 255], 0), "pose-magenta.png center should be opaque magenta");

  await mkdir(outDir, {recursive: true});
  await writeFile(new URL("pose-magenta.png", import.meta.url), pngBytes);
  await writeFile(
    new URL("background-cyan.jpg", import.meta.url),
    Buffer.from(result.jpegBase64, "base64"),
  );
  await writeFile(
    new URL("background-noext", import.meta.url),
    Buffer.from(result.webpBase64, "base64"),
  );

  console.log("Wrote pose-magenta.png, background-cyan.jpg, background-noext");
} finally {
  await browser.close();
}
