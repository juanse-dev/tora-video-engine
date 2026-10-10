import assert from "node:assert/strict";
import {existsSync} from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import {tmpdir} from "node:os";
import {basename, join} from "node:path";
import {after, before, describe, it} from "node:test";
import {renderWithCli, runProcess} from "./gate/helpers/cliParity.mjs";

describe("renderWithCli", () => {
  let work;
  let fakeRepo;
  let outDir;
  let yamlPath;
  let pose;
  let background;
  let tempBase;

  before(async () => {
    work = await mkdtemp(join(tmpdir(), "tora-cli-parity-test-"));
    fakeRepo = join(work, "repo");
    tempBase = join(work, "tmp");
    outDir = join(work, "artifacts");
    await mkdir(join(fakeRepo, "scripts"), {recursive: true});
    await mkdir(tempBase, {recursive: true});
    yamlPath = join(work, "My Story.yaml");
    pose = join(work, "pose-magenta.png");
    background = join(work, "background-noext");
    await writeFile(yamlPath, 'title: "Parity"\n');
    await writeFile(pose, "pose bytes");
    await writeFile(background, "background bytes");
  });

  after(async () => {
    await rm(work, {recursive: true, force: true});
  });

  it("stages fixtures, runs scripts/render.ts and moves the MP4 to outDir", async () => {
    let call;

    const result = await renderWithCli(
      {yamlPath, fixtures: {poses: [pose], backgrounds: [background]}, outDir},
      {
        repoRoot: fakeRepo,
        tempBase,
        run: async (invocation) => {
          call = invocation;

          const root = invocation.env.TORA_LOCAL_ASSETS_ROOT;

          // The fixtures are staged by content under poses/ and backgrounds/.
          assert.deepEqual(await readdir(join(root, "poses")), [
            "0-pose-magenta.png",
          ]);
          assert.deepEqual(await readdir(join(root, "backgrounds")), [
            "0-background-noext",
          ]);
          assert.equal(
            await readFile(join(root, "poses", "0-pose-magenta.png"), "utf8"),
            "pose bytes",
          );

          const storyArg = invocation.args.at(-1);

          assert.equal(await readFile(storyArg, "utf8"), 'title: "Parity"\n');

          const slug = basename(storyArg, ".yaml");

          await mkdir(join(fakeRepo, "output"), {recursive: true});
          await writeFile(join(fakeRepo, "output", `${slug}.mp4`), "mp4");

          return {code: 0, stdout: `Rendered output/${slug}.mp4\n`, stderr: ""};
        },
      },
    );

    assert.equal(call.command, process.execPath);
    assert.deepEqual(call.args.slice(0, 2), [
      "--experimental-strip-types",
      join(fakeRepo, "scripts", "render.ts"),
    ]);
    assert.equal(call.cwd, fakeRepo);
    assert.equal(result, join(outDir, "My Story-cli.mp4"));
    assert.equal(await readFile(result, "utf8"), "mp4");
  });

  it("leaves nothing behind: no temp root, no file in output/", async () => {
    assert.deepEqual(await readdir(tempBase), []);
    assert.equal(existsSync(join(fakeRepo, "output")), false);
  });

  it("keeps unrelated files that were already in output/", async () => {
    await mkdir(join(fakeRepo, "output"), {recursive: true});
    await writeFile(join(fakeRepo, "output", "keep.mp4"), "keep");

    await renderWithCli(
      {yamlPath, fixtures: {poses: [pose], backgrounds: []}, outDir},
      {
        repoRoot: fakeRepo,
        tempBase,
        run: async ({args}) => {
          const slug = basename(args.at(-1), ".yaml");

          await writeFile(join(fakeRepo, "output", `${slug}.mp4`), "mp4");

          return {code: 0, stdout: "", stderr: ""};
        },
      },
    );

    assert.deepEqual(await readdir(join(fakeRepo, "output")), ["keep.mp4"]);
    await rm(join(fakeRepo, "output"), {recursive: true, force: true});
  });

  it("reports the CLI output when the render fails, and still cleans up", async () => {
    await assert.rejects(
      renderWithCli(
        {yamlPath, fixtures: {poses: [pose], backgrounds: []}, outDir},
        {
          repoRoot: fakeRepo,
          tempBase,
          run: async () => ({
            code: 1,
            stdout: "",
            stderr: "Missing local asset: pose",
          }),
        },
      ),
      /exit code 1[\s\S]*Missing local asset: pose/u,
    );
    assert.deepEqual(await readdir(tempBase), []);
  });

  it("fails when the CLI exits 0 but wrote no MP4", async () => {
    await assert.rejects(
      renderWithCli(
        {yamlPath, fixtures: {poses: [], backgrounds: []}, outDir},
        {
          repoRoot: fakeRepo,
          tempBase,
          run: async () => ({code: 0, stdout: "", stderr: ""}),
        },
      ),
      /did not produce/u,
    );
  });

  it("rejects a missing fixture before running anything", async () => {
    let ran = false;

    await assert.rejects(
      renderWithCli(
        {
          yamlPath,
          fixtures: {poses: [join(work, "nope.png")], backgrounds: []},
          outDir,
        },
        {
          repoRoot: fakeRepo,
          tempBase,
          run: async () => {
            ran = true;

            return {code: 0, stdout: "", stderr: ""};
          },
        },
      ),
      /nope\.png/u,
    );
    assert.equal(ran, false);
    assert.deepEqual(await readdir(tempBase), []);
  });
});

describe("runProcess", () => {
  it("kills the process on timeout, waits for it to exit, and reports the timeout", async () => {
    const work = await mkdtemp(join(tmpdir(), "tora-run-process-test-"));
    const pidFile = join(work, "pid");

    try {
      await assert.rejects(
        runProcess({
          command: process.execPath,
          args: [
            "-e",
            "require('fs').writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 60000)",
            pidFile,
          ],
          cwd: work,
          env: process.env,
          timeoutMs: 1_500,
        }),
        /timed out/u,
      );

      const pid = Number(await readFile(pidFile, "utf8"));

      // The child is gone by the time runProcess has rejected.
      assert.throws(() => process.kill(pid, 0), /ESRCH/u);
    } finally {
      await rm(work, {recursive: true, force: true});
    }
  });

  it("keeps only the last 64 KB of output", async () => {
    const result = await runProcess({
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write('a'.repeat(300000) + 'TAIL')",
      ],
      cwd: tmpdir(),
      env: process.env,
    });

    assert.equal(result.code, 0);
    assert.ok(result.stdout.length <= 64 * 1024, String(result.stdout.length));
    assert.ok(result.stdout.endsWith("TAIL"));
  });
});
