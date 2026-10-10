// CLI parity for the deployed-gate suite (ASSET-006 Part B step 13): renders a
// Story YAML with `scripts/render.ts` (what `npm run video` runs) against
// local assets staged from fixture files, and hands back the MP4.

import {spawn} from "node:child_process";
import {randomBytes} from "node:crypto";
import {existsSync} from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  rmdir,
  stat,
} from "node:fs/promises";
import {tmpdir} from "node:os";
import {basename, dirname, extname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const CLI_TIMEOUT_MS = 5 * 60_000;
const OUTPUT_TAIL_CHARS = 4_000;

const MAX_CAPTURED_CHARS = 64 * 1024;

/** Appends to captured output, keeping only the last 64 KB. */
const appendBounded = (current, chunk) => {
  const next = current + chunk;

  return next.length > MAX_CAPTURED_CHARS
    ? next.slice(next.length - MAX_CAPTURED_CHARS)
    : next;
};

/**
 * Kills the child and everything it started (the CLI launches Chrome):
 * `taskkill /T` on Windows, the child's process group elsewhere.
 */
const killProcessTree = (child) => {
  if (child.pid === undefined) {
    return;
  }

  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    }).on("error", () => child.kill("SIGKILL"));

    return;
  }

  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
};

/**
 * Runs a process to completion with output captured (the last 64 KB of each
 * stream). `TORA_REMOTION_BROWSER_EXECUTABLE` is inherited through `env`,
 * which is how the CLI is pointed at system Chrome. On timeout the process
 * tree is killed and the promise rejects only after the child has exited, so
 * the caller can safely delete the files it was using.
 */
export const runProcess = ({
  command,
  args,
  cwd,
  env,
  timeoutMs = CLI_TIMEOUT_MS,
}) =>
  new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout = appendBounded(stdout, chunk.toString());
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendBounded(stderr, chunk.toString());
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);

      if (timedOut) {
        reject(
          new Error(`CLI render timed out after ${timeoutMs / 1000}s`),
        );

        return;
      }

      resolveRun({code, stdout, stderr});
    });
  });

const tail = (text) =>
  text.length > OUTPUT_TAIL_CHARS ? `...${text.slice(-OUTPUT_TAIL_CHARS)}` : text;

/** Copies fixtures into `<root>/<folder>/<index>-<name>`; content is what matters, not names. */
const stageFixtures = async (root, folder, files) => {
  await mkdir(join(root, folder), {recursive: true});

  for (const [index, file] of files.entries()) {
    await copyFile(file, join(root, folder, `${index}-${basename(file)}`));
  }
};

/**
 * Renders `yamlPath` with the CLI and returns the path of the MP4 in `outDir`.
 *
 * - `fixtures`: `{poses: [absPath...], backgrounds: [absPath...]}`, copied into
 *   a temporary `local-assets` root (`poses/` + `backgrounds/`) that the CLI
 *   reads through `TORA_LOCAL_ASSETS_ROOT`.
 * - The CLI writes `output/<yaml slug>.mp4` in the repository. The YAML is
 *   copied to a unique name first so that file can never be one the person
 *   already has, and it is moved out (and `output/` removed again if this
 *   run created it), so nothing is left behind.
 * - The result is `<outDir>/<yaml name>-cli.mp4`. The temporary root is
 *   always removed.
 *
 * `deps` replaces the process runner, repository root and temp parent (tests).
 */
export const renderWithCli = async (
  {yamlPath, fixtures, outDir},
  {
    run = runProcess,
    repoRoot = REPO_ROOT,
    tempBase = tmpdir(),
  } = {},
) => {
  const poses = fixtures?.poses ?? [];
  const backgrounds = fixtures?.backgrounds ?? [];

  for (const file of [yamlPath, ...poses, ...backgrounds]) {
    if (!existsSync(file)) {
      throw new Error(`renderWithCli: file not found: ${file}`);
    }
  }

  const root = await mkdtemp(join(tempBase, "tora-gate-cli-"));
  const slug = `gate-cli-${randomBytes(4).toString("hex")}`;
  const outputDirectory = join(repoRoot, "output");
  const producedPath = join(outputDirectory, `${slug}.mp4`);
  const createdOutputDirectory = !existsSync(outputDirectory);

  try {
    await stageFixtures(root, "poses", poses);
    await stageFixtures(root, "backgrounds", backgrounds);

    const storyPath = join(root, "story", `${slug}.yaml`);

    await mkdir(dirname(storyPath), {recursive: true});
    await copyFile(yamlPath, storyPath);

    const result = await run({
      command: process.execPath,
      args: [
        "--experimental-strip-types",
        join(repoRoot, "scripts", "render.ts"),
        storyPath,
      ],
      cwd: repoRoot,
      env: {...process.env, TORA_LOCAL_ASSETS_ROOT: root},
    });

    if (result.code !== 0) {
      throw new Error(
        `CLI render of ${yamlPath} failed with exit code ${result.code}\n${tail(result.stderr || result.stdout)}`,
      );
    }

    if (!existsSync(producedPath) || (await stat(producedPath)).size === 0) {
      throw new Error(
        `CLI render of ${yamlPath} did not produce ${producedPath}\n${tail(result.stdout)}`,
      );
    }

    await mkdir(outDir, {recursive: true});

    const destination = join(
      outDir,
      `${basename(yamlPath, extname(yamlPath))}-cli.mp4`,
    );

    await copyFile(producedPath, destination);

    return destination;
  } finally {
    await rm(producedPath, {force: true});

    if (createdOutputDirectory) {
      // Only if this run made it and nothing else wrote there meanwhile.
      try {
        if ((await readdir(outputDirectory)).length === 0) {
          await rmdir(outputDirectory);
        }
      } catch {
        // Already gone or in use: leave it.
      }
    }

    await rm(root, {recursive: true, force: true});
  }
};
