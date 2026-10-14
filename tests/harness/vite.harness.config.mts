import {readFile} from "node:fs/promises";
import path from "node:path";
import {defineConfig, type Plugin} from "vite";

// Vite's dev server treats an extensionless URL as a JS module and tries to
// transform it, which would fail for the extensionless WebP fixture (and would
// mangle the audio fixtures). This harness-only config serves the committed
// local-asset and local-audio fixtures as raw bytes, before Vite's own
// middleware runs. It is not part of the production build.
const RAW_FIXTURE_DIRECTORIES = [
  {prefix: "/tests/fixtures/local-assets/", segments: ["tests", "fixtures", "local-assets"]},
  {prefix: "/tests/fixtures/local-audio/", segments: ["tests", "fixtures", "local-audio"]},
];
const FIXTURE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const serveRawFixtures = (root: string): Plugin => ({
  name: "serve-raw-local-asset-fixtures",
  configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      const pathname = (request.url ?? "").split("?")[0];
      const directory = RAW_FIXTURE_DIRECTORIES.find((entry) =>
        pathname.startsWith(entry.prefix),
      );

      if (directory === undefined) {
        next();
        return;
      }

      const name = pathname.slice(directory.prefix.length);

      if (!FIXTURE_NAME.test(name)) {
        next();
        return;
      }

      try {
        const bytes = await readFile(path.join(root, ...directory.segments, name));

        response.setHeader("content-type", "application/octet-stream");
        response.setHeader("cache-control", "no-store");
        response.end(bytes);
      } catch {
        next();
      }
    });
  },
});

const root = process.cwd();

export default defineConfig({
  root,
  base: "/",
  plugins: [serveRawFixtures(root)],
});
