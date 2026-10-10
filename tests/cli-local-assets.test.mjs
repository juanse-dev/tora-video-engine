import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join, resolve} from "node:path";
import {after, describe, it} from "node:test";
import {fileURLToPath} from "node:url";
import {
  categoryFolderExists,
  inventoryLocalAssets,
  LOCAL_ASSETS_ROOT,
  scanCategory,
} from "../scripts/localAssets.ts";
import {buildRenderArgs} from "../scripts/renderSupport.ts";
import {sha256Hex} from "../src/localAssets/hash.ts";
import {
  buildApng,
  buildGifSignature,
  buildPng,
  buildTextBytes,
} from "./helpers/imageBytes.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDir = join(repoRoot, "tests", "fixtures", "local-assets");
const fixture = (name) => readFile(join(fixtureDir, name));

const temporaryDirectories = [];

const makeRoot = async () => {
  const root = await mkdtemp(join(tmpdir(), "tora-local-assets-test-"));

  temporaryDirectories.push(root);

  return root;
};

const put = async (root, relativePath, bytes) => {
  const target = join(root, ...relativePath.split("/"));

  await mkdir(dirname(target), {recursive: true});
  await writeFile(target, bytes);
};

const collect = async (generator) => {
  const results = [];

  for await (const result of generator) {
    const {bytes: _bytes, ...rest} = result;

    results.push(rest);
  }

  return results;
};

const nodeSha = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Records every path passed to `open` while delegating to the real one. */
const spyOpen = () => {
  const opened = [];

  return {
    opened,
    deps: {
      open: async (...args) => {
        opened.push(args[0]);

        return open(...args);
      },
    },
  };
};

/** Wraps `open` so the handle's `stat()` result is altered. */
const openWithStat = (alter, closed = []) => ({
  open: async (...args) => {
    const handle = await open(...args);

    return {
      stat: async () => alter(await handle.stat()),
      readFile: () => handle.readFile(),
      close: async () => {
        closed.push(true);
        await handle.close();
      },
    };
  },
});

after(async () => {
  for (const directory of temporaryDirectories) {
    await rm(directory, {recursive: true, force: true});
  }
});

describe("local asset constants", () => {
  it("defaults the root to local-assets", () => {
    assert.equal(LOCAL_ASSETS_ROOT, "local-assets");
  });
});

describe("local asset inventory with missing folders", () => {
  it("returns empty lists for a root with only README.md", async () => {
    const root = await makeRoot();

    await writeFile(join(root, "README.md"), "hello");

    assert.deepEqual(await inventoryLocalAssets(root), {
      rootExists: true,
      poses: [],
      backgrounds: [],
    });
    assert.equal(await categoryFolderExists(root, "pose"), false);
    assert.equal(await categoryFolderExists(root, "background"), false);
  });

  it("reports a root that does not exist", async () => {
    const root = join(await makeRoot(), "nope");

    assert.deepEqual(await inventoryLocalAssets(root), {
      rootExists: false,
      poses: [],
      backgrounds: [],
    });
  });

  it("treats a category folder that is a file as having no candidates", async () => {
    const root = await makeRoot();

    await put(root, "poses", "not a folder");

    assert.deepEqual(await collect(scanCategory(root, "pose")), []);
    assert.equal(await categoryFolderExists(root, "pose"), false);
  });

  it("detects an existing category folder", async () => {
    const root = await makeRoot();

    await mkdir(join(root, "poses"));

    assert.equal(await categoryFolderExists(root, "pose"), true);
    assert.equal(await categoryFolderExists(root, "background"), false);
  });
});

describe("local asset scanner: content detection", () => {
  it("resolves the pose and background fixtures to sha256Hex refs", async () => {
    const root = await makeRoot();
    const pose = await fixture("pose-magenta.png");
    const background = await fixture("background-cyan.jpg");

    await put(root, "poses/pose-magenta.png", pose);
    await put(root, "backgrounds/background-cyan.jpg", background);

    const poseDigest = await sha256Hex(pose);
    const backgroundDigest = await sha256Hex(background);

    assert.equal(poseDigest, nodeSha(pose));
    assert.equal(backgroundDigest, nodeSha(background));

    const inventory = await inventoryLocalAssets(root);

    assert.deepEqual(inventory.poses, [
      {
        relativePath: "pose-magenta.png",
        ref: `local:pose:sha256:${poseDigest}`,
      },
    ]);
    assert.deepEqual(inventory.backgrounds, [
      {
        relativePath: "background-cyan.jpg",
        ref: `local:background:sha256:${backgroundDigest}`,
      },
    ]);
  });

  it("yields digest, inspected image and bytes for a good file", async () => {
    const root = await makeRoot();
    const pose = await fixture("pose-magenta.png");

    await put(root, "poses/p.png", pose);

    let count = 0;

    for await (const candidate of scanCategory(root, "pose")) {
      count += 1;
      assert.equal(candidate.ok, true);
      assert.equal(candidate.digest, nodeSha(pose));
      assert.deepEqual(candidate.image, {
        mimeType: "image/png",
        width: 600,
        height: 900,
      });
      assert.deepEqual(Buffer.from(candidate.bytes), pose);
      assert.equal(candidate.ref, `local:pose:sha256:${nodeSha(pose)}`);
    }

    assert.equal(count, 1);
  });

  it("detects an extensionless WebP and a PNG renamed photo.jpg", async () => {
    const root = await makeRoot();
    const webp = await fixture("background-noext");
    const png = await fixture("pose-magenta.png");

    await put(root, "backgrounds/background-noext", webp);
    await put(root, "backgrounds/photo.jpg", png);

    const inventory = await inventoryLocalAssets(root);

    assert.deepEqual(inventory.backgrounds, [
      {
        relativePath: "background-noext",
        ref: `local:background:sha256:${nodeSha(webp)}`,
      },
      {
        relativePath: "photo.jpg",
        ref: `local:background:sha256:${nodeSha(png)}`,
      },
    ]);
  });

  it("rejects fake, animated, GIF, empty and oversized-dimension files", async () => {
    const root = await makeRoot();

    await put(root, "poses/fake.png", buildTextBytes());
    await put(root, "poses/apng.png", buildApng());
    await put(root, "poses/anim.gif", buildGifSignature());
    await put(root, "poses/huge.png", buildPng({width: 9000, height: 9000}));
    await put(root, "poses/empty.png", new Uint8Array(0));

    const {poses} = await inventoryLocalAssets(root);

    assert.deepEqual(poses, [
      {
        relativePath: "anim.gif",
        rejected: "Only static PNG, JPEG and WebP images are supported.",
      },
      {
        relativePath: "apng.png",
        rejected: "Animated images are not supported.",
      },
      {relativePath: "empty.png", rejected: "The file is empty."},
      {
        relativePath: "fake.png",
        rejected: "Only static PNG, JPEG and WebP images are supported.",
      },
      {
        relativePath: "huge.png",
        rejected: "Images must be at most 8192 pixels wide and tall.",
      },
    ]);

    for await (const candidate of scanCategory(root, "pose")) {
      assert.equal(candidate.ok, false);
    }
  });

  it("rejects 25 MiB + 1 byte without opening the file", async () => {
    const root = await makeRoot();

    await put(root, "poses/big.png", Buffer.alloc(25 * 1024 * 1024 + 1));

    const {opened, deps} = spyOpen();
    const results = await collect(scanCategory(root, "pose", deps));

    assert.deepEqual(results, [
      {relativePath: "big.png", ok: false, reason: "too-large"},
    ]);
    assert.deepEqual(opened, []);

    const inventory = await inventoryLocalAssets(root, deps);

    assert.deepEqual(inventory.poses, [
      {
        relativePath: "big.png",
        rejected: "The file is larger than 25 MiB.",
      },
    ]);
    assert.deepEqual(opened, []);
  });

  it("keeps categories authoritative", async () => {
    const root = await makeRoot();
    const background = await fixture("background-cyan.jpg");

    await put(root, "poses/bg.jpg", background);

    const inventory = await inventoryLocalAssets(root);

    assert.deepEqual(inventory.backgrounds, []);
    assert.deepEqual(inventory.poses, [
      {
        relativePath: "bg.jpg",
        ref: `local:pose:sha256:${nodeSha(background)}`,
      },
    ]);
  });

  it("finds nested files and lists identical bytes at every path", async () => {
    const root = await makeRoot();
    const pose = await fixture("pose-magenta.png");

    await put(root, "poses/a/b/pic.png", pose);
    await put(root, "poses/a.png", pose);
    await put(root, "poses/z.png", pose);

    const {poses} = await inventoryLocalAssets(root);
    const ref = `local:pose:sha256:${nodeSha(pose)}`;

    assert.deepEqual(poses, [
      {relativePath: "a.png", ref},
      {relativePath: "a/b/pic.png", ref},
      {relativePath: "z.png", ref},
    ]);
  });
});

describe("local asset scanner: ordering and memory", () => {
  it("opens candidates in full-path order, not per-directory order", async () => {
    const root = await makeRoot();
    const png = buildPng();

    await put(root, "poses/b.png", png);
    await put(root, "poses/a/z.png", png);
    await put(root, "poses/a.png", png);

    const started = [];

    await collect(
      scanCategory(root, "pose", {
        onCandidateStart: (relativePath) => started.push(relativePath),
      }),
    );

    assert.deepEqual(started, ["a.png", "a/z.png", "b.png"]);
  });

  it("never has more than one candidate in progress", async () => {
    const root = await makeRoot();

    for (let index = 0; index < 20; index += 1) {
      await put(
        root,
        `poses/${String(index).padStart(2, "0")}.png`,
        buildPng({width: index + 1, height: 1}),
      );
    }

    let inProgress = 0;
    let maxInProgress = 0;
    let finished = 0;

    for await (const candidate of scanCategory(root, "pose", {
      onCandidateStart: () => {
        inProgress += 1;
        maxInProgress = Math.max(maxInProgress, inProgress);
      },
      onCandidateEnd: () => {
        inProgress -= 1;
        finished += 1;
      },
    })) {
      assert.equal(candidate.ok, true);
      await new Promise((done) => setTimeout(done, 1));
    }

    assert.equal(maxInProgress, 1);
    assert.equal(finished, 20);
    assert.equal(inProgress, 0);
  });

  it("is lazy: stopping after the first result opens one file", async () => {
    const root = await makeRoot();

    for (let index = 0; index < 10; index += 1) {
      await put(root, `poses/${index}.png`, buildPng({width: index + 1}));
    }

    const {opened, deps} = spyOpen();

    for await (const candidate of scanCategory(root, "pose", deps)) {
      assert.equal(candidate.ok, true);
      break;
    }

    assert.equal(opened.length, 1);

    opened.length = 0;
    await inventoryLocalAssets(root, deps);
    assert.equal(opened.length, 10);
  });

  it("opens nothing for a category with no folder", async () => {
    const root = await makeRoot();

    await put(root, "poses/p.png", buildPng());

    const {opened, deps} = spyOpen();

    assert.deepEqual(await collect(scanCategory(root, "background", deps)), []);
    assert.deepEqual(opened, []);
  });
});

describe("local asset scanner: changes during scan", () => {
  it("reports changed-during-scan when the opened file has another inode", async (context) => {
    const root = await makeRoot();

    await put(root, "poses/p.png", buildPng());

    const lstatInfo = await stat(join(root, "poses", "p.png"));

    if (lstatInfo.ino === 0) {
      context.skip("this filesystem reports inode 0");

      return;
    }

    const closed = [];
    const deps = openWithStat(
      (real) => ({
        isFile: () => true,
        size: real.size,
        dev: real.dev,
        // +1 would be lost to double precision for large Windows file ids.
        ino: real.ino === 1 ? 2 : 1,
      }),
      closed,
    );

    assert.deepEqual(await collect(scanCategory(root, "pose", deps)), [
      {relativePath: "p.png", ok: false, reason: "changed-during-scan"},
    ]);
    assert.equal(closed.length, 1);
  });

  it("reports changed-during-scan when the size differs", async () => {
    const root = await makeRoot();

    await put(root, "poses/p.png", buildPng());

    const closed = [];
    const deps = openWithStat(
      (real) => ({
        isFile: () => true,
        size: real.size + 1,
        dev: real.dev,
        ino: real.ino,
      }),
      closed,
    );

    assert.deepEqual(await collect(scanCategory(root, "pose", deps)), [
      {relativePath: "p.png", ok: false, reason: "changed-during-scan"},
    ]);
    assert.equal(closed.length, 1);

    const {poses} = await inventoryLocalAssets(root, deps);

    assert.deepEqual(poses, [
      {
        relativePath: "p.png",
        rejected: "The file changed while it was being scanned.",
      },
    ]);
  });

  it("reports changed-during-scan when the handle is not a regular file", async () => {
    const root = await makeRoot();

    await put(root, "poses/p.png", buildPng());

    const deps = openWithStat((real) => ({
      isFile: () => false,
      size: real.size,
      dev: real.dev,
      ino: real.ino,
    }));
    const [result] = await collect(scanCategory(root, "pose", deps));

    assert.equal(result.reason, "changed-during-scan");
  });

  it("reports unreadable when the file cannot be opened", async () => {
    const root = await makeRoot();

    await put(root, "poses/p.png", buildPng());

    const deps = {
      open: async () => {
        throw Object.assign(new Error("denied"), {code: "EACCES"});
      },
    };

    const {poses} = await inventoryLocalAssets(root, deps);

    assert.deepEqual(poses, [
      {relativePath: "p.png", rejected: "The file could not be read."},
    ]);
  });
});

describe("local asset scanner: symlinks", () => {
  it("skips symlinked files and directories but resolves regular siblings", async (context) => {
    const root = await makeRoot();
    const outside = await makeRoot();
    const pose = await fixture("pose-magenta.png");

    await put(root, "poses/real.png", pose);
    await put(outside, "target.png", buildPng({width: 2}));
    await put(outside, "dir/inner.png", buildPng({width: 3}));

    try {
      await symlink(
        join(outside, "target.png"),
        join(root, "poses", "link.png"),
        "file",
      );
      await symlink(
        join(outside, "dir"),
        join(root, "poses", "linkdir"),
        "dir",
      );
    } catch (error) {
      if (error.code === "EPERM" || error.code === "EACCES") {
        context.skip("symlinks are not permitted here");

        return;
      }

      throw error;
    }

    const {opened, deps} = spyOpen();
    const results = await collect(scanCategory(root, "pose", deps));

    assert.deepEqual(
      results.map((result) => result.relativePath),
      ["real.png"],
    );
    assert.equal(results[0].ok, true);
    assert.equal(opened.length, 1);
  });
});

describe("npm run assets", () => {
  const runAssets = (root) =>
    spawnSync(
      process.execPath,
      ["--experimental-strip-types", "scripts/assets.ts"],
      {
        cwd: repoRoot,
        env: {...process.env, TORA_LOCAL_ASSETS_ROOT: root},
        encoding: "utf8",
      },
    );

  it("prints the not-found message and exits 0 without a root", async () => {
    const root = join(await makeRoot(), "missing");
    const result = runAssets(root);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout.trim(),
      "No local-assets/ folder found. Create local-assets/poses/ and local-assets/backgrounds/ and copy images into them.",
    );
  });

  it("notes missing category folders and exits 0", async () => {
    const root = await makeRoot();

    await writeFile(join(root, "README.md"), "hi");

    const result = runAssets(root);
    const base = root.replaceAll("\\", "/");

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout,
      [
        `${base}/poses/ (folder not found — create it and copy images into it)`,
        "",
        `${base}/backgrounds/ (folder not found — create it and copy images into it)`,
        "",
      ].join("\n"),
    );
  });

  it("prints refs and skipped files, exiting 0 when some are rejected", async () => {
    const root = await makeRoot();
    const pose = await fixture("pose-magenta.png");
    const background = await fixture("background-cyan.jpg");

    await put(root, "poses/my-cat.png", pose);
    await put(root, "backgrounds/apartment.jpg", background);
    await put(root, "backgrounds/old.gif", buildGifSignature());

    const result = runAssets(root);
    const base = root.replaceAll("\\", "/");

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout,
      [
        `${base}/poses/my-cat.png`,
        `  local:pose:sha256:${nodeSha(pose)}`,
        "",
        `${base}/backgrounds/apartment.jpg`,
        `  local:background:sha256:${nodeSha(background)}`,
        "",
        `${base}/backgrounds/old.gif`,
        "  skipped: Only static PNG, JPEG and WebP images are supported.",
        "",
      ].join("\n"),
    );
  });

  it("prints an empty-but-existing category folder as nothing", async () => {
    const root = await makeRoot();

    await mkdir(join(root, "poses"));
    await mkdir(join(root, "backgrounds"));

    const result = runAssets(root);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
  });
});

describe("bundled-only render args", () => {
  it("are unchanged when no public dir is given", () => {
    const args = buildRenderArgs("output/x.mp4", "props.json");

    assert.ok(!args.some((arg) => arg.startsWith("--public-dir")));
  });
});
