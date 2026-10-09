# Local asset test fixtures

These files are **test-only**. They are real, decodable images used by the
local-asset tests (image inspection, hashing, the asset library, and later the
CLI and end-to-end specs). They are not part of any story or bundled asset
inventory and must never be referenced from `public/` or story data.

| File | Format | Size | Content |
| --- | --- | --- | --- |
| `pose-magenta.png` | PNG, RGBA | 600x900 | Transparent background with an opaque magenta rectangle (x 150-449, y 225-674). |
| `background-cyan.jpg` | JPEG | 1080x1920 | Top half cyan, bottom half yellow. |
| `background-noext` | static WebP (extended, `VP8X` + `VP8 `), **no file extension** | 1080x1920 | Same picture as the JPEG. The missing extension is deliberate: inspection must work from bytes only. |

## Regenerating

```sh
node tests/fixtures/local-assets/generate.mjs
```

- The PNG is generated in Node with `zlib.deflateSync` and `zlib.crc32` (Node 22+).
- The JPEG and WebP are generated in **system Chrome** through Playwright
  (`channel: "chrome"`) with `OffscreenCanvas.convertToBlob`. Bundled Chromium
  is not required and must not be downloaded.
- The script decodes every output in Chrome and checks dimensions and sample
  pixels before writing, so a bad run fails instead of committing bad files.

JPEG and WebP bytes depend on the installed Chrome version, so regenerating can
change their hashes. Tests read the files from disk and compute hashes at run
time; do not hard-code the digests. Regenerate only when a fixture needs to
change, and commit the new files together.

Crafted header-only cases (APNG, animated WebP, oversized dimensions,
truncated files) are not stored here; they are built in memory by
`tests/helpers/imageBytes.mjs`.
