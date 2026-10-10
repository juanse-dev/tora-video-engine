import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {
  mkdir,
  mkdtemp,
  open,
  readdir,
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
  displayRoot,
  getLocalAssetsRoot,
  inventoryLocalAssets,
  LOCAL_ASSETS_ROOT,
  MissingLocalAssetsError,
  scanCategory,
  stageLocalAssetsForStory,
} from "../scripts/localAssets.ts";
import {renderStory} from "../scripts/renderStory.ts";
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

  it("treats an empty or whitespace TORA_LOCAL_ASSETS_ROOT as unset", () => {
    const previous = process.env.TORA_LOCAL_ASSETS_ROOT;

    try {
      for (const value of ["", "   ", "	"]) {
        process.env.TORA_LOCAL_ASSETS_ROOT = value;
        assert.equal(getLocalAssetsRoot(), "local-assets");
      }

      process.env.TORA_LOCAL_ASSETS_ROOT = " custom/root ";
      assert.equal(getLocalAssetsRoot(), "custom/root");

      delete process.env.TORA_LOCAL_ASSETS_ROOT;
      assert.equal(getLocalAssetsRoot(), "local-assets");
    } finally {
      if (previous === undefined) {
        delete process.env.TORA_LOCAL_ASSETS_ROOT;
      } else {
        process.env.TORA_LOCAL_ASSETS_ROOT = previous;
      }
    }
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

describe("displayRoot", () => {
  it("shows the default root literally", () => {
    assert.equal(displayRoot("local-assets"), "local-assets");
    assert.equal(displayRoot("./local-assets/"), "local-assets");
  });

  it("shows roots inside the working directory relative to it", () => {
    const cwd = resolve("some", "project");

    assert.equal(displayRoot(join(cwd, "a", "b"), cwd), "a/b");
    assert.equal(displayRoot(cwd, cwd), ".");
  });

  it("shows roots outside the working directory as absolute forward-slash paths", async () => {
    const root = await makeRoot();

    assert.equal(
      displayRoot(root, join(root, "elsewhere")),
      resolve(root).split("\\").join("/"),
    );
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

describe("local asset scanner: symlinked folders", () => {
  it("follows a symlinked category folder but still skips symlinked entries", async (context) => {
    const root = await makeRoot();
    const outside = await makeRoot();
    const pose = await fixture("pose-magenta.png");

    await put(outside, "real.png", pose);
    await put(outside, "other/inner.png", buildPng({width: 3}));
    await mkdir(root, {recursive: true});

    try {
      await symlink(outside, join(root, "poses"), "dir");
      await symlink(
        join(outside, "other"),
        join(outside, "linkdir"),
        "dir",
      );
    } catch (error) {
      if (error.code === "EPERM" || error.code === "EACCES") {
        context.skip("symlinks are not permitted here");

        return;
      }

      throw error;
    }

    assert.equal(await categoryFolderExists(root, "pose"), true);

    const {poses} = await inventoryLocalAssets(root);

    assert.deepEqual(
      poses.map((line) => line.relativePath),
      ["other/inner.png", "real.png"],
    );
  });

  it("follows a symlinked root", async (context) => {
    const target = await makeRoot();
    const holder = await makeRoot();
    const link = join(holder, "local-assets");

    await put(target, "poses/p.png", buildPng());

    try {
      await symlink(target, link, "dir");
    } catch (error) {
      if (error.code === "EPERM" || error.code === "EACCES") {
        context.skip("symlinks are not permitted here");

        return;
      }

      throw error;
    }

    const inventory = await inventoryLocalAssets(link);

    assert.equal(inventory.rootExists, true);
    assert.equal(inventory.poses.length, 1);
  });

  it("treats a dangling category symlink as missing", async (context) => {
    const root = await makeRoot();

    try {
      await symlink(join(root, "nowhere"), join(root, "poses"), "dir");
    } catch (error) {
      if (error.code === "EPERM" || error.code === "EACCES") {
        context.skip("symlinks are not permitted here");

        return;
      }

      throw error;
    }

    assert.equal(await categoryFolderExists(root, "pose"), false);
    assert.deepEqual(await collect(scanCategory(root, "pose")), []);
  });
});

describe("npm run assets", () => {
  const runAssets = (root, {cwd = repoRoot, useDefaultRoot = false} = {}) => {
    const env = {...process.env};

    delete env.TORA_LOCAL_ASSETS_ROOT;

    if (!useDefaultRoot) {
      env.TORA_LOCAL_ASSETS_ROOT = root;
    }

    return spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        join(repoRoot, "scripts", "assets.ts"),
      ],
      {cwd, env, encoding: "utf8"},
    );
  };

  it("prints the default root as local-assets/<category>/ relative to cwd", async () => {
    const cwd = await makeRoot();
    const pose = await fixture("pose-magenta.png");

    await put(cwd, "local-assets/poses/my-cat.png", pose);

    const result = runAssets(undefined, {cwd, useDefaultRoot: true});

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout,
      [
        "local-assets/poses/my-cat.png",
        `  local:pose:sha256:${nodeSha(pose)}`,
        "",
        "local-assets/backgrounds/ (folder not found — create it and copy images into it)",
        "",
      ].join("\n"),
    );
  });

  it("shows an in-cwd override root relative to cwd", async () => {
    const cwd = await makeRoot();

    await put(cwd, "my/assets/backgrounds/old.gif", buildGifSignature());

    const result = runAssets("my/assets", {cwd});

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^my\/assets\/poses\/ \(folder not found/mu);
    assert.match(result.stdout, /^my\/assets\/backgrounds\/old\.gif$/mu);
  });

  it("prints the spec not-found message for the default root and exits 0", async () => {
    const cwd = await makeRoot();
    const result = runAssets(undefined, {cwd, useDefaultRoot: true});

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout.trim(),
      "No local-assets/ folder found. Create local-assets/poses/ and local-assets/backgrounds/ and copy images into them.",
    );
  });

  it("names the configured root in the not-found message", async () => {
    const root = join(await makeRoot(), "missing");
    const result = runAssets(root);
    const base = root.split("\\").join("/");

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout.trim(),
      `No ${base}/ folder found. Create ${base}/poses/ and ${base}/backgrounds/ and copy images into them.`,
    );
  });

  it("treats an empty TORA_LOCAL_ASSETS_ROOT as the default root", async () => {
    const cwd = await makeRoot();
    const result = runAssets("", {cwd});

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^No local-assets\/ folder found\./u);
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

  it("says when an existing category folder has no files", async () => {
    const root = await makeRoot();

    await mkdir(join(root, "poses"));
    await mkdir(join(root, "backgrounds"));

    const result = runAssets(root);
    const base = root.split("\\").join("/");

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout,
      [
        `${base}/poses/ (no files)`,
        "",
        `${base}/backgrounds/ (no files)`,
        "",
      ].join("\n"),
    );
  });
});

const MISSING_DIGEST = "a".repeat(64);

const sceneOf = (pose, background) => ({
  type: "intro",
  pose,
  background,
  animation: "fade",
  text: "Hi",
  duration: 1,
});

const storyOf = (...pairs) => ({
  title: "T",
  scenes: pairs.map(([pose, background]) => sceneOf(pose, background)),
});

const poseRefOf = (bytes) => `local:pose:sha256:${nodeSha(bytes)}`;
const backgroundRefOf = (bytes) => `local:background:sha256:${nodeSha(bytes)}`;

const stageInto = async (story, root, options = {}, deps = {}) => {
  const publicDir = await makeRoot();
  const staged = await stageLocalAssetsForStory(
    story,
    {root, publicDir, ...options},
    deps,
  );

  return {publicDir, staged};
};

const MISSING_FOOTER = [
  "Copy the original PNG/JPEG/WebP file into that folder (any filename),",
  "or replace the reference in the Story. Run `npm run assets` to list the refs",
  "of the files that are there.",
];

describe("stageLocalAssetsForStory: missing assets", () => {
  it("fails with MissingLocalAssetsError, not ENOENT, for a README-only root", async () => {
    const root = await makeRoot();

    await writeFile(join(root, "README.md"), "hi");

    await assert.rejects(
      stageInto(
        storyOf([`local:pose:sha256:${MISSING_DIGEST}`, "office"]),
        root,
      ),
      (error) => {
        assert.ok(error instanceof MissingLocalAssetsError);
        assert.notEqual(error.code, "ENOENT");

        return true;
      },
    );
  });

  it("reports a root that does not exist the same way", async () => {
    const root = join(await makeRoot(), "nope");

    await assert.rejects(
      stageInto(
        storyOf([`local:pose:sha256:${MISSING_DIGEST}`, "office"]),
        root,
      ),
      MissingLocalAssetsError,
    );
  });

  it("does not let a background placed only in poses/ satisfy a background ref", async () => {
    const root = await makeRoot();
    const background = await fixture("background-cyan.jpg");
    const ref = backgroundRefOf(background);

    await put(root, "poses/bg.jpg", background);

    const story = storyOf(["formal", ref], ["formal", "office"], ["panic", ref]);

    await assert.rejects(stageInto(story, root), (error) => {
      assert.ok(error instanceof MissingLocalAssetsError);
      assert.equal(
        error.message,
        [
          "Cannot render Story: 1 local asset is missing.",
          "",
          "Background:",
          `  ${ref}`,
          "  used by scenes: 1, 3",
          `  searched: ${displayRoot(root)}/backgrounds/`,
          "",
          ...MISSING_FOOTER,
        ].join("\n"),
      );

      return true;
    });
  });

  it("groups by category (Pose first), keeps first-appearance order and pluralizes", async () => {
    const root = await makeRoot();
    const bgRef = `local:background:sha256:${"b".repeat(64)}`;
    const poseA = `local:pose:sha256:${"c".repeat(64)}`;
    const poseB = `local:pose:sha256:${"d".repeat(64)}`;
    const story = storyOf(
      [poseB, bgRef],
      ["formal", bgRef],
      [poseA, "office"],
      [poseB, "office"],
    );

    await assert.rejects(stageInto(story, root), (error) => {
      assert.ok(error instanceof MissingLocalAssetsError);
      assert.equal(
        error.message,
        [
          "Cannot render Story: 3 local assets are missing.",
          "",
          "Pose:",
          `  ${poseB}`,
          "  used by scenes: 1, 4",
          `  searched: ${displayRoot(root)}/poses/`,
          "",
          `  ${poseA}`,
          "  used by scenes: 3",
          `  searched: ${displayRoot(root)}/poses/`,
          "",
          "Background:",
          `  ${bgRef}`,
          "  used by scenes: 1, 2",
          `  searched: ${displayRoot(root)}/backgrounds/`,
          "",
          ...MISSING_FOOTER,
        ].join("\n"),
      );

      return true;
    });
  });

  it("prints the default root literally as local-assets/<category>/", async () => {
    const cwd = await makeRoot();
    const previous = process.cwd();

    process.chdir(cwd);

    try {
      await assert.rejects(
        stageInto(
          storyOf([`local:pose:sha256:${MISSING_DIGEST}`, "office"]),
          LOCAL_ASSETS_ROOT,
        ),
        (error) => {
          assert.match(error.message, /^ {2}searched: local-assets\/poses\/$/mu);

          return true;
        },
      );
    } finally {
      process.chdir(previous);
    }
  });

  it("never lets rejected files satisfy a ref", async () => {
    const root = await makeRoot();
    const gif = buildGifSignature();
    const apng = buildApng();
    const huge = buildPng({width: 9000, height: 9000});
    const text = buildTextBytes();

    await put(root, "poses/a.png", gif);
    await put(root, "poses/b.png", apng);
    await put(root, "poses/c.png", huge);
    await put(root, "poses/fake.png", text);

    const story = storyOf(
      [poseRefOf(gif), "office"],
      [poseRefOf(apng), "office"],
      [poseRefOf(huge), "office"],
      [poseRefOf(text), "office"],
    );

    await assert.rejects(stageInto(story, root), (error) => {
      assert.ok(error instanceof MissingLocalAssetsError);
      assert.match(error.message, /4 local assets are missing/u);

      return true;
    });
  });
});

describe("stageLocalAssetsForStory: bundled-only stories", () => {
  it("does not touch the root or the filesystem", async () => {
    const forbidden = () => {
      throw new Error("filesystem must not be touched");
    };
    const {publicDir, staged} = await stageInto(
      storyOf(["formal", "office"], ["coffee", "server-room"]),
      join(await makeRoot(), "nope"),
      {},
      {stat: forbidden, lstat: forbidden, readdir: forbidden, open: forbidden},
    );

    assert.deepEqual(staged, {sources: {}});
    assert.deepEqual(await readdir(publicDir), []);
  });
});

describe("stageLocalAssetsForStory: staging", () => {
  it("stages originals under __local-assets/<category>/<digest>.<ext>", async () => {
    const root = await makeRoot();
    const pose = await fixture("pose-magenta.png");
    const background = await fixture("background-cyan.jpg");
    const webp = await fixture("background-noext");
    const renamed = buildPng({width: 5, height: 7});

    await put(root, "poses/pose-magenta.png", pose);
    await put(root, "poses/photo.jpg", renamed);
    await put(root, "backgrounds/background-cyan.jpg", background);
    await put(root, "backgrounds/background-noext", webp);

    const story = storyOf(
      [poseRefOf(pose), backgroundRefOf(background)],
      [poseRefOf(renamed), backgroundRefOf(webp)],
    );
    const {publicDir, staged} = await stageInto(story, root);

    const expected = [
      [poseRefOf(pose), pose, `__local-assets/pose/${nodeSha(pose)}.png`],
      [
        poseRefOf(renamed),
        renamed,
        `__local-assets/pose/${nodeSha(renamed)}.png`,
      ],
      [
        backgroundRefOf(background),
        background,
        `__local-assets/background/${nodeSha(background)}.jpg`,
      ],
      [
        backgroundRefOf(webp),
        webp,
        `__local-assets/background/${nodeSha(webp)}.webp`,
      ],
    ];

    assert.deepEqual(
      staged.sources,
      Object.fromEntries(
        expected.map(([ref, , path]) => [ref, {kind: "static", path}]),
      ),
    );

    for (const [, original, path] of expected) {
      assert.deepEqual(
        Buffer.from(await readFile(join(publicDir, ...path.split("/")))),
        Buffer.from(original),
      );
    }

    await assert.rejects(stat(join(repoRoot, "public", "__local-assets")), {
      code: "ENOENT",
    });
  });

  it("resolves a nested file and stages identical bytes once", async () => {
    const root = await makeRoot();
    const nestedOnly = await makeRoot();
    const pose = await fixture("pose-magenta.png");

    await put(root, "poses/a.png", pose);
    await put(root, "poses/a/b/pic.png", pose);
    await put(root, "poses/z.png", pose);
    await put(nestedOnly, "poses/a/b/pic.png", pose);

    const stagedRefs = [];
    const {publicDir, staged} = await stageInto(
      storyOf([poseRefOf(pose), "office"]),
      root,
      {onStaged: (ref, stagedPath) => stagedRefs.push([ref, stagedPath])},
    );

    assert.equal(stagedRefs.length, 1);
    assert.equal(stagedRefs[0][0], poseRefOf(pose));
    assert.equal(
      resolve(stagedRefs[0][1]),
      resolve(publicDir, "__local-assets", "pose", `${nodeSha(pose)}.png`),
    );
    assert.deepEqual(Object.keys(staged.sources), [poseRefOf(pose)]);
    assert.equal((await inventoryLocalAssets(root)).poses.length, 3);

    const nested = await stageInto(
      storyOf([poseRefOf(pose), "office"]),
      nestedOnly,
    );

    assert.deepEqual(Object.keys(nested.staged.sources), [poseRefOf(pose)]);
  });

  it("stops a category as soon as every digest is staged", async () => {
    const root = await makeRoot();
    const files = [];

    for (let index = 0; index < 10; index += 1) {
      files.push(buildPng({width: index + 1, height: 1}));
      await put(root, `poses/${index}.png`, files[index]);
      await put(root, `backgrounds/${index}.png`, files[index]);
    }

    const {opened, deps} = spyOpen();

    await stageInto(storyOf([poseRefOf(files[0]), "office"]), root, {}, deps);

    assert.equal(opened.length, 1);
    assert.ok(opened[0].includes("poses"), opened[0]);
  });

  it("stops each required category independently", async () => {
    const root = await makeRoot();
    const files = [];

    for (let index = 0; index < 5; index += 1) {
      files.push(buildPng({width: index + 1, height: 1}));
      await put(root, `poses/${index}.png`, files[index]);
      await put(root, `backgrounds/${index}.png`, files[index]);
    }

    const {opened, deps} = spyOpen();

    await stageInto(
      storyOf([poseRefOf(files[1]), backgroundRefOf(files[2])]),
      root,
      {},
      deps,
    );

    assert.equal(opened.filter((path) => path.includes("poses")).length, 2);
    assert.equal(
      opened.filter((path) => path.includes("backgrounds")).length,
      3,
    );
  });

  it("stages a digest once when several files share it and still reaches later digests", async () => {
    const root = await makeRoot();
    const first = buildPng({width: 1});
    const second = buildPng({width: 2});

    await put(root, "poses/a.png", first);
    await put(root, "poses/b.png", first);
    await put(root, "poses/c.png", second);

    const stagedRefs = [];
    const {staged} = await stageInto(
      storyOf([poseRefOf(first), "office"], [poseRefOf(second), "office"]),
      root,
      {onStaged: (ref) => stagedRefs.push(ref)},
    );

    assert.deepEqual(stagedRefs, [poseRefOf(first), poseRefOf(second)]);
    assert.deepEqual(Object.keys(staged.sources), [
      poseRefOf(first),
      poseRefOf(second),
    ]);
  });

  it("snapshots bytes: editing the source after a match cannot change the staged file", async () => {
    const root = await makeRoot();
    const pose = await fixture("pose-magenta.png");
    const source = join(root, "poses", "p.png");

    await put(root, "poses/p.png", pose);

    const {publicDir} = await stageInto(
      storyOf([poseRefOf(pose), "office"]),
      root,
      {
        onStaged: async () => {
          await writeFile(source, buildTextBytes());
        },
      },
    );
    const stagedPath = join(
      publicDir,
      "__local-assets",
      "pose",
      `${nodeSha(pose)}.png`,
    );

    assert.equal(nodeSha(await readFile(stagedPath)), nodeSha(pose));
    assert.notEqual(nodeSha(await readFile(source)), nodeSha(pose));
  });

  it("writes a match before reading the next file", async () => {
    const root = await makeRoot();
    const first = buildPng({width: 1});
    const second = buildPng({width: 2});

    await put(root, "poses/0.png", first);
    await put(root, "poses/1.png", second);

    const publicDir = await makeRoot();
    const stagedPath = join(
      publicDir,
      "__local-assets",
      "pose",
      `${nodeSha(first)}.png`,
    );
    let existedWhenSecondOpened = null;
    const deps = {
      open: async (...args) => {
        if (String(args[0]).endsWith("1.png")) {
          existedWhenSecondOpened = await stat(stagedPath).then(
            () => true,
            () => false,
          );
        }

        return open(...args);
      },
    };

    await stageLocalAssetsForStory(
      storyOf([poseRefOf(first), "office"], [poseRefOf(second), "office"]),
      {root, publicDir},
      deps,
    );

    assert.equal(existedWhenSecondOpened, true);
  });
});

describe("renderStory staging", () => {
  const storyYaml = (pose, background = "office") =>
    [
      'title: "T2"',
      "scenes:",
      "  - type: intro",
      `    pose: ${pose}`,
      `    background: ${background}`,
      "    animation: fade",
      '    text: "Hi"',
      "    duration: 1",
      "",
    ].join("\n");

  const setup = async (yaml) => {
    const directory = await makeRoot();
    const slug = `t2-${nodeSha(directory).slice(0, 12)}`;
    const storyPath = join(directory, `${slug}.yaml`);
    const tempBase = join(directory, "tmp");

    await mkdir(tempBase);
    await writeFile(storyPath, yaml);

    return {
      storyPath,
      tempBase,
      outputPath: join(repoRoot, "output", `${slug}.mp4`),
    };
  };

  it("keeps the bundled-only command line and props", async () => {
    const {storyPath, tempBase} = await setup(storyYaml("formal"));
    const calls = [];

    const outputPath = await renderStory(storyPath, {
      tempBase,
      runRemotion: async (_executable, args) => {
        const propsArg = args.find((arg) => arg.startsWith("--props="));

        calls.push({
          args,
          props: JSON.parse(await readFile(propsArg.slice(8), "utf8")),
        });
      },
    });

    assert.equal(calls.length, 1);
    assert.ok(!calls[0].args.some((arg) => arg.startsWith("--public-dir")));
    assert.deepEqual(Object.keys(calls[0].props), ["story"]);
    assert.deepEqual(await readdir(tempBase), []);
    await rm(outputPath, {force: true});
  });

  it("stages local assets into a temporary public dir and cleans it up", async () => {
    const pose = await fixture("pose-magenta.png");
    const root = await makeRoot();

    await put(root, "poses/any-name.bin", pose);

    const {storyPath, tempBase, outputPath} = await setup(
      storyYaml(poseRefOf(pose)),
    );
    const observed = [];

    await renderStory(storyPath, {
      tempBase,
      localAssetsRoot: root,
      runRemotion: async (_executable, args) => {
        const publicArg = args.find((arg) => arg.startsWith("--public-dir="));
        const propsArg = args.find((arg) => arg.startsWith("--props="));
        const publicDir = publicArg.slice("--public-dir=".length);

        observed.push({
          publicDir,
          props: JSON.parse(await readFile(propsArg.slice(8), "utf8")),
          staged: await readFile(
            join(publicDir, "__local-assets", "pose", `${nodeSha(pose)}.png`),
          ),
          copiedPublic: await readdir(publicDir),
        });
      },
    });

    assert.equal(observed.length, 1);
    assert.ok(resolve(observed[0].publicDir).startsWith(resolve(tempBase)));
    assert.deepEqual(observed[0].staged, pose);
    assert.ok(observed[0].copiedPublic.includes("characters"));
    assert.ok(observed[0].copiedPublic.includes("backgrounds"));
    assert.deepEqual(observed[0].props.localAssetSources, {
      [poseRefOf(pose)]: {
        kind: "static",
        path: `__local-assets/pose/${nodeSha(pose)}.png`,
      },
    });
    assert.deepEqual(await readdir(tempBase), []);
    await assert.rejects(stat(join(repoRoot, "public", "__local-assets")), {
      code: "ENOENT",
    });
    await rm(outputPath, {force: true});
  });

  it("removes the temporary directory and output when Remotion fails", async () => {
    const pose = await fixture("pose-magenta.png");
    const root = await makeRoot();

    await put(root, "poses/p.png", pose);

    const {storyPath, tempBase, outputPath} = await setup(
      storyYaml(poseRefOf(pose)),
    );

    await assert.rejects(
      renderStory(storyPath, {
        tempBase,
        localAssetsRoot: root,
        runRemotion: async () => {
          await mkdir(dirname(outputPath), {recursive: true});
          await writeFile(outputPath, "partial");
          throw new Error("Remotion render failed with exit code 1");
        },
      }),
      /Remotion render failed/u,
    );

    assert.deepEqual(await readdir(tempBase), []);
    await assert.rejects(stat(outputPath), {code: "ENOENT"});
  });

  it("removes the temporary directory when only some categories were staged", async () => {
    const pose = await fixture("pose-magenta.png");
    const root = await makeRoot();

    await put(root, "poses/p.png", pose);

    const {storyPath, tempBase, outputPath} = await setup(
      storyYaml(poseRefOf(pose), `local:background:sha256:${MISSING_DIGEST}`),
    );
    let spawned = 0;

    await assert.rejects(
      renderStory(storyPath, {
        tempBase,
        localAssetsRoot: root,
        runRemotion: async () => {
          spawned += 1;
        },
      }),
      (error) => {
        assert.ok(error instanceof MissingLocalAssetsError);
        assert.match(error.message, /1 local asset is missing/u);
        assert.match(error.message, /^Background:$/mu);
        assert.doesNotMatch(error.message, /^Pose:$/mu);

        return true;
      },
    );

    assert.equal(spawned, 0);
    assert.deepEqual(await readdir(tempBase), []);
    await assert.rejects(stat(outputPath), {code: "ENOENT"});
  });

  it("fails before spawning when an asset is missing and leaves nothing behind", async () => {
    const root = await makeRoot();
    const {storyPath, tempBase, outputPath} = await setup(
      storyYaml(`local:pose:sha256:${MISSING_DIGEST}`),
    );
    let spawned = 0;

    await mkdir(dirname(outputPath), {recursive: true});
    await writeFile(outputPath, "stale");

    await assert.rejects(
      renderStory(storyPath, {
        tempBase,
        localAssetsRoot: root,
        runRemotion: async () => {
          spawned += 1;
        },
      }),
      MissingLocalAssetsError,
    );

    assert.equal(spawned, 0);
    assert.deepEqual(await readdir(tempBase), []);
    await assert.rejects(stat(outputPath), {code: "ENOENT"});
  });
});

describe("bundled-only render args", () => {
  it("are unchanged when no public dir is given", () => {
    const previous = process.env.TORA_REMOTION_BROWSER_EXECUTABLE;

    delete process.env.TORA_REMOTION_BROWSER_EXECUTABLE;

    try {
      assert.deepEqual(buildRenderArgs("output/x.mp4", "props.json"), [
        resolve("node_modules", "@remotion", "cli", "remotion-cli.js"),
        "render",
        "src/index.ts",
        "ToraVideo",
        "output/x.mp4",
        "--codec=h264",
        "--overwrite=true",
        "--props=props.json",
      ]);
    } finally {
      if (previous !== undefined) {
        process.env.TORA_REMOTION_BROWSER_EXECUTABLE = previous;
      }
    }
  });

  it("appends --public-dir after the existing arguments when given", () => {
    const previous = process.env.TORA_REMOTION_BROWSER_EXECUTABLE;

    delete process.env.TORA_REMOTION_BROWSER_EXECUTABLE;

    try {
      assert.deepEqual(
        buildRenderArgs("output/x.mp4", "props.json", "/tmp/tora/public"),
        [
          resolve("node_modules", "@remotion", "cli", "remotion-cli.js"),
          "render",
          "src/index.ts",
          "ToraVideo",
          "output/x.mp4",
          "--codec=h264",
          "--overwrite=true",
          "--props=props.json",
          "--public-dir=/tmp/tora/public",
        ],
      );
    } finally {
      if (previous !== undefined) {
        process.env.TORA_REMOTION_BROWSER_EXECUTABLE = previous;
      }
    }
  });
});
