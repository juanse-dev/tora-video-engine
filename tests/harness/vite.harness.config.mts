import {readFile} from "node:fs/promises";
import path from "node:path";
import {defineConfig, type Plugin} from "vite";

// Vite's dev server treats an extensionless URL as a JS module and tries to
// transform it, which would fail for the extensionless WebP fixture. This
// harness-only config serves the committed local-asset fixtures as raw bytes,
// before Vite's own middleware runs. It is not part of the production build.
const FIXTURE_PREFIX = "/tests/fixtures/local-assets/";
const FIXTURE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const serveRawFixtures = (root: string): Plugin => ({
  name: "serve-raw-local-asset-fixtures",
  configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      const pathname = (request.url ?? "").split("?")[0];

      if (!pathname.startsWith(FIXTURE_PREFIX)) {
        next();
        return;
      }

      const name = pathname.slice(FIXTURE_PREFIX.length);

      if (!FIXTURE_NAME.test(name)) {
        next();
        return;
      }

      try {
        const bytes = await readFile(
          path.join(root, "tests", "fixtures", "local-assets", name),
        );

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
