import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import {crc32, deflateSync} from "node:zlib";

// Writes fixture records straight into IndexedDB (ASSET-002 v1 layout) from
// page.evaluate, so browser tests can run without the ASSET-003 import UI.
//
// Layout (all stores use out-of-line keys):
//   assets:      `local:<category>:sha256:<digest>` -> {label, originalFilename, createdAt}
//   payloadMeta: `<digest>` -> {mimeType, byteSize, width, height}
//   blobs:       `<digest>` -> {blob}
//   thumbnails:  `<digest>` -> {blob, mimeType, width, height}; only seeded when a
//                record carries `thumbnail` (preview/render do not need them).

export const ASSET_DB_NAME = "tora-video-engine-assets";
export const ASSET_DB_VERSION = 1;

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

const pngChunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const length = Buffer.alloc(4);
  const checksum = Buffer.alloc(4);

  length.writeUInt32BE(data.length);
  checksum.writeUInt32BE(crc32(body));

  return Buffer.concat([length, body, checksum]);
};

/**
 * A valid solid-colour RGB PNG (at most 256x256, see MAX_THUMBNAIL_DIMENSION),
 * shaped as a seed `thumbnail` for fixtureRecord / metadataOnlyRecord.
 */
export const solidPngThumbnail = (width, height, [red, green, blue]) => {
  const header = Buffer.alloc(13);

  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB, deflate, no filter, no interlace

  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.from(Array.from({length: width}, () => [red, green, blue]).flat()),
  ]);
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.concat(Array.from({length: height}, () => row)))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);

  return {base64: png.toString("base64"), mimeType: "image/png", width, height};
};

/**
 * One seed record for `category`, backed by a fixture. Options:
 * - `thumbnail`: a solidPngThumbnail() to store under the digest;
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
  thumbnail: options.thumbnail ?? null,
});

/** Metadata-only record: a row and payloadMeta, no blob (budget tests). */
export const metadataOnlyRecord = (category, n, meta, options = {}) => ({
  ref: localAssetRef(category, syntheticDigest(n)),
  digest: syntheticDigest(n),
  meta,
  bytesBase64: null,
  mimeType: meta.mimeType,
  row: true,
  label: options.label ?? `Synthetic ${n}`,
  thumbnail: options.thumbnail ?? null,
});

/**
 * The page must be on the app origin. Safe to call while the app already holds
 * a connection: the version is the same, so no upgrade is requested.
 */
export const seedAssetLibrary = async (page, records) => {
  await page.evaluate(async ({items, dbName, dbVersion}) => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, dbVersion);

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
        ["assets", "payloadMeta", "blobs", "thumbnails"],
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

        if (item.thumbnail !== null) {
          const bytes = Uint8Array.from(atob(item.thumbnail.base64), (char) =>
            char.charCodeAt(0),
          );

          transaction.objectStore("thumbnails").put(
            {
              blob: new Blob([bytes], {type: item.thumbnail.mimeType}),
              mimeType: item.thumbnail.mimeType,
              width: item.thumbnail.width,
              height: item.thumbnail.height,
            },
            item.digest,
          );
        }

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
  }, {items: records, dbName: ASSET_DB_NAME, dbVersion: ASSET_DB_VERSION});
};

/** Deletes raw `assets` rows (leaving payload records), like another tab would. */
export const deleteAssetRows = async (page, refs) => {
  await page.evaluate(async ({keys, dbName, dbVersion}) => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, dbVersion);

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
  }, {keys: refs, dbName: ASSET_DB_NAME, dbVersion: ASSET_DB_VERSION});
};

/**
 * Row and record counts as the page's IndexedDB holds them: the `assets` rows
 * for `ref` and in total, and the payload records (metadata, blob) for `digest`
 * and in total.
 */
export const readLibraryRecords = (page, ref, digest) =>
  page.evaluate(
    async ({key, hash, dbName, dbVersion}) => {
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open(dbName, dbVersion);

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });

      try {
        const count = (storeName, query) =>
          new Promise((resolve, reject) => {
            const request = database
              .transaction(storeName, "readonly")
              .objectStore(storeName)
              .count(query);

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });

        return {
          assetRows: await count("assets", key),
          allAssetRows: await count("assets"),
          payloadMeta: await count("payloadMeta", hash),
          blobs: await count("blobs", hash),
          allBlobs: await count("blobs"),
        };
      } finally {
        database.close();
      }
    },
    {
      key: ref,
      hash: digest,
      dbName: ASSET_DB_NAME,
      dbVersion: ASSET_DB_VERSION,
    },
  );

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
