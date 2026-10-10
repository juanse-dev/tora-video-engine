import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";

// Writes fixture records straight into IndexedDB (ASSET-002 v1 layout) from
// page.evaluate, so browser tests can run without the ASSET-003 import UI.
//
// Layout (all stores use out-of-line keys):
//   assets:      `local:<category>:sha256:<digest>` -> {label, originalFilename, createdAt}
//   payloadMeta: `<digest>` -> {mimeType, byteSize, width, height}
//   blobs:       `<digest>` -> {blob}
//   thumbnails:  not needed for preview/render and not seeded here.

const FIXTURE_DIR = new URL("../../fixtures/local-assets/", import.meta.url);

const FIXTURES = {
  "pose-magenta.png": {mimeType: "image/png", width: 600, height: 900},
  "background-cyan.jpg": {mimeType: "image/jpeg", width: 1080, height: 1920},
  "background-noext": {mimeType: "image/webp", width: 1080, height: 1920},
};

export const digestOfBytes = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");

export const localAssetRef = (category, digest) =>
  `local:${category}:sha256:${digest}`;

/** A synthetic but well-formed digest, for records that carry metadata only. */
export const syntheticDigest = (n) => n.toString(16).padStart(64, "0");

/** Reads a committed fixture. `base64` is what travels into page.evaluate. */
export const readFixture = async (name) => {
  const info = FIXTURES[name];

  if (info === undefined) {
    throw new Error(`Unknown local asset fixture: ${name}`);
  }

  const bytes = new Uint8Array(await readFile(new URL(name, FIXTURE_DIR)));

  return {
    name,
    bytes,
    base64: Buffer.from(bytes).toString("base64"),
    digest: digestOfBytes(bytes),
    meta: {
      mimeType: info.mimeType,
      byteSize: bytes.length,
      width: info.width,
      height: info.height,
    },
  };
};

/**
 * One seed record for `category`, backed by a fixture. Options:
 * - `bytesFrom`: store another fixture's bytes under this fixture's digest (corrupt blob);
 * - `row: false`: write payload records without the asset row.
 */
export const fixtureRecord = (category, fixture, options = {}) => ({
  ref: localAssetRef(category, fixture.digest),
  digest: fixture.digest,
  meta: fixture.meta,
  bytesBase64: (options.bytesFrom ?? fixture).base64,
  mimeType: fixture.meta.mimeType,
  row: options.row !== false,
  label: options.label ?? fixture.name,
});

/** Metadata-only record: a row and payloadMeta, no blob (budget tests). */
export const metadataOnlyRecord = (category, n, meta) => ({
  ref: localAssetRef(category, syntheticDigest(n)),
  digest: syntheticDigest(n),
  meta,
  bytesBase64: null,
  mimeType: meta.mimeType,
  row: true,
  label: `Synthetic ${n}`,
});

/**
 * The page must be on the app origin. Safe to call while the app already holds
 * a connection: the version is the same, so no upgrade is requested.
 */
export const seedAssetLibrary = async (page, records) => {
  await page.evaluate(async (items) => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("tora-video-engine-assets", 1);

      request.onupgradeneeded = () => {
        for (const name of ["assets", "payloadMeta", "blobs", "thumbnails"]) {
          if (!request.result.objectStoreNames.contains(name)) {
            request.result.createObjectStore(name);
          }
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    await new Promise((resolve, reject) => {
      const transaction = database.transaction(
        ["assets", "payloadMeta", "blobs"],
        "readwrite",
      );

      for (const item of items) {
        if (item.row) {
          transaction.objectStore("assets").put(
            {
              label: item.label,
              originalFilename: item.label,
              createdAt: "2026-01-01T00:00:00.000Z",
            },
            item.ref,
          );
        }

        transaction.objectStore("payloadMeta").put({...item.meta}, item.digest);

        if (item.bytesBase64 !== null) {
          const bytes = Uint8Array.from(atob(item.bytesBase64), (char) =>
            char.charCodeAt(0),
          );

          transaction
            .objectStore("blobs")
            .put({blob: new Blob([bytes], {type: item.mimeType})}, item.digest);
        }
      }

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
  }, records);
};

/** Deletes raw `assets` rows (leaving payload records), like another tab would. */
export const deleteAssetRows = async (page, refs) => {
  await page.evaluate(async (keys) => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("tora-video-engine-assets", 1);

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    await new Promise((resolve, reject) => {
      const transaction = database.transaction("assets", "readwrite");

      for (const key of keys) {
        transaction.objectStore("assets").delete(key);
      }

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  }, refs);
};

/** Minimal Story YAML. `scenes` are `{pose, background}` pairs. */
export const buildStoryYaml = (scenes, title = "Local assets") =>
  [
    `title: ${title}`,
    "scenes:",
    ...scenes.flatMap(({pose, background}, index) => [
      "  - type: dialogue",
      `    pose: ${pose}`,
      `    background: ${background}`,
      "    animation: fade",
      `    text: Scene ${index + 1}`,
      "    duration: 3",
    ]),
    "",
  ].join("\n");
