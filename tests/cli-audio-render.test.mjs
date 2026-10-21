import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {after, before, describe, it} from "node:test";
import {
  AudioRenderError,
  prepareCliAudio,
  STAGED_BUNDLED_AUDIO_DIR,
} from "../scripts/audioRender.ts";
import {stageLocalAssetsForStory} from "../scripts/localAssets.ts";
import {buildWav, fixtureBytes} from "./helpers/audioBytes.mjs";
import {
  decodeSeconds,
  FAKE_FFMPEG,
  fakeSpawn,
} from "./helpers/fakeFfmpeg.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const scene = (overrides = {}) => ({
  type: "dialogue",
  pose: "formal",
  background: "office",
  text: "Hi",
  duration: 3,
  ...overrides,
});
const storyOf = (...scenes) => ({title: "Audio", scenes});
const directories = [];
const tempDirectory = async () => {
  const directory = await mkdtemp(join(tmpdir(), "tora-cli-audio-"));

  directories.push(directory);

  return directory;
};

after(async () => {
  for (const directory of directories) {
    await rm(directory, {recursive: true, force: true});
  }
});

describe("prepareCliAudio", () => {
  let publicSource;

  /** A copy of the repository's bundled sfx, so a test can change a "bundled" file safely. */
  before(async () => {
    publicSource = await tempDirectory();
    await cp("public/audio", join(publicSource, "audio"), {recursive: true});
  });

  const prepare = async (story, options = {}) => {
    const publicDir = options.publicDir ?? (await tempDirectory());
    const names = new Map();
    let localSources = {};

    if (options.localRoot !== undefined) {
      const staged = await stageLocalAssetsForStory(story, {
        root: options.localRoot,
        publicDir,
        onStaged: (ref, _stagedPath, relativePath) => names.set(ref, relativePath),
      });

      localSources = staged.sources;
    }

    return {
      publicDir,
      names,
      result: await prepareCliAudio(story, {
        publicDir,
        localSources,
        localNames: names,
        publicSourceDir: options.publicSourceDir ?? publicSource,
        checkInterrupt: options.checkInterrupt,
        control: options.control,
        preflight: options.preflight,
      }),
    };
  };
  const refuses = async (story, options, pattern) => {
    let error = null;

    try {
      await prepare(story, options);
    } catch (caught) {
      error = caught;
    }

    assert.ok(error instanceof AudioRenderError, String(error));
    assert.match(error.message, pattern);

    return error;
  };
  const fakePreflight = (script, calls, timeoutMs) => ({
    spawn: fakeSpawn(script, calls),
    ffmpeg: FAKE_FFMPEG,
    ...(timeoutMs === undefined ? {} : {timeoutMs}),
  });

  it("stages a bundled sfx under __local-assets/bundled and points the sources at the staged copy", async () => {
    const story = storyOf(scene({sfx: {src: "ding"}}));
    const {publicDir, result} = await prepare(story);
    const original = await readFile(join(publicSource, "audio", "sfx", "ding.wav"));

    assert.deepEqual(result.audioSources, {
      ding: {kind: "static", path: `${STAGED_BUNDLED_AUDIO_DIR}/ding.wav`},
    });
    assert.equal(STAGED_BUNDLED_AUDIO_DIR, "__local-assets/bundled");
    assert.deepEqual(result.audioDurations, {ding: 1.8});
    assert.deepEqual(
      await readFile(join(publicDir, "__local-assets", "bundled", "ding.wav")),
      original,
    );
  });

  it("measures a staged local voice (AINV-3) and stages local and bundled sources together", async () => {
    const root = await tempDirectory();
    const voice = fixtureBytes("tone-440-2.2s.wav");
    const voiceRef = `local:audio:sha256:${sha(voice)}`;

    await mkdir(join(root, "audio"), {recursive: true});
    await writeFile(join(root, "audio", "voice.wav"), voice);

    const story = storyOf(
      scene({voice: {src: voiceRef}, sfx: {src: "ding"}, duration: "auto"}),
    );
    const {result} = await prepare(story, {localRoot: root});

    assert.deepEqual(result.audioDurations, {[voiceRef]: 2.2, ding: 1.8});
    assert.deepEqual(result.audioSources, {
      [voiceRef]: {kind: "static", path: `__local-assets/audio/${sha(voice)}.wav`},
      ding: {kind: "static", path: "__local-assets/bundled/ding.wav"},
    });
  });

  it("refuses a bundled id whose catalog file is null before anything is spawned, naming the role", async () => {
    const calls = [];

    await refuses(
      {...storyOf(scene({sfx: {src: "ding"}})), music: {src: "calm-loop"}},
      {preflight: fakePreflight(decodeSeconds(1.2), calls)},
      /^Cannot render Story: some of its audio is not available\.\n\n {2}music: Bundled audio calm-loop is not available in this build\.$/u,
    );
    assert.equal(calls.length, 0);
  });

  it("refuses a bundled file that is absent from public/audio and lists every problem with its role", async () => {
    const source = await tempDirectory();
    const calls = [];

    await cp("public/audio", join(source, "audio"), {recursive: true});
    await rm(join(source, "audio", "sfx", "whoosh.wav"));

    const error = await refuses(
      {
        ...storyOf(scene({sfx: {src: "ding"}}), scene({sfx: {src: "whoosh"}})),
        music: {src: "upbeat-loop"},
      },
      {publicSourceDir: source, preflight: fakePreflight(decodeSeconds(1.2), calls)},
      /scene 2 sfx: Bundled audio whoosh is not available in this build\./u,
    );

    assert.match(error.message, /music: Bundled audio upbeat-loop is not available in this build\./u);
    assert.doesNotMatch(error.message, /ding/u);
    assert.equal(calls.length, 0);
  });

  it("refuses a Story longer than 3,600 s with audio before spawning", async () => {
    const calls = [];

    await refuses(
      storyOf(scene({duration: 3_601, sfx: {src: "ding"}})),
      {preflight: fakePreflight(decodeSeconds(1.2), calls)},
      /Stories with audio/u,
    );
    assert.equal(calls.length, 0);
  });

  it("refuses a bundled file replaced by an MP4 with a video track in the metadata step, before any decode", async () => {
    const source = await tempDirectory();
    const calls = [];

    await cp("public/audio", join(source, "audio"), {recursive: true});
    await writeFile(join(source, "audio", "sfx", "ding.wav"), fixtureBytes("with-video.mp4"));

    const error = await refuses(
      storyOf(scene({sfx: {src: "ding"}})),
      {publicSourceDir: source, preflight: fakePreflight(decodeSeconds(1.2), calls)},
      /Audio file ding cannot be used for rendering\./u,
    );

    assert.match(error.message, /used by: scene 1 sfx/u);
    assert.match(error.message, /Video files are not supported/u);
    assert.equal(calls.length, 0);
  });

  it("refuses a bundled WAV whose duration differs from the catalog", async () => {
    const source = await tempDirectory();
    const calls = [];

    await cp("public/audio", join(source, "audio"), {recursive: true});
    await writeFile(join(source, "audio", "sfx", "ding.wav"), buildWav({seconds: 5}));

    await refuses(
      storyOf(scene({sfx: {src: "ding"}})),
      {publicSourceDir: source, preflight: fakePreflight(decodeSeconds(1.2), calls)},
      /^Bundled audio ding does not match the catalog\.$/u,
    );
    assert.equal(calls.length, 0);
  });

  it("decodes every staged file once with ffmpeg: a decode 0.2 s short passes, 0.3 s short, a non-zero exit and a timeout refuse", async () => {
    const story = storyOf(scene({sfx: {src: "ding"}}));
    const passCalls = [];

    // ding is 1.8 s: 1.6 s decoded is 0.2 s short and passes (tolerance 0.25 s).
    await prepare(story, { preflight: fakePreflight(decodeSeconds(1.6), passCalls) });
    assert.equal(passCalls.length, 1);
    assert.match(passCalls[0].args.join(" "), /__local-assets[\\/]bundled[\\/]ding\.wav/u);

    await refuses(
      story,
      {preflight: fakePreflight(decodeSeconds(1.5), [])},
      /only 1\.50 s of 1\.80 s could be decoded/u,
    );
    await refuses(
      story,
      {
        preflight: fakePreflight((child) => {
          child.stderr.emit("data", Buffer.from("Invalid data found when processing input"));
          child.emit("close", 1, null);
        }, []),
      },
      /Audio file ding cannot be used for rendering\.[\s\S]*exited with code 1: Invalid data found/u,
    );
    await refuses(
      story,
      {preflight: fakePreflight(() => undefined, [], 20)},
      /did not finish within/u,
    );
  });

  it("decodes a shared source once and one file at a time", async () => {
    const calls = [];

    await prepare(
      storyOf(
        scene({sfx: {src: "ding"}}),
        scene({sfx: {src: "ding"}}),
        scene({sfx: {src: "whoosh"}, voice: {src: "boom"}}),
      ),
      {
        preflight: {
          spawn: fakeSpawn((child, call) => {
            const seconds = call.args.join(" ").includes("whoosh") ? 0.42 : call.args.join(" ").includes("boom") ? 3.2 : 1.8;

            decodeSeconds(seconds)(child);
          }, calls),
          ffmpeg: FAKE_FFMPEG,
        },
      },
    );

    assert.equal(calls.length, 3);
    assert.equal(calls.maxActive, 1);
  });

  it("refuses a truncated local MP3 with the file name and its role, from a real ffmpeg decode", async () => {
    const root = await tempDirectory();
    const truncated = fixtureBytes("truncated.mp3");
    const ref = `local:audio:sha256:${sha(truncated)}`;

    await mkdir(join(root, "audio", "takes"), {recursive: true});
    await writeFile(join(root, "audio", "takes", "voice.mp3"), truncated);

    const error = await refuses(
      storyOf(scene(), scene({voice: {src: ref}})),
      {localRoot: root},
      /Audio file takes\/voice\.mp3 cannot be used for rendering\./u,
    );

    assert.match(error.message, /used by: scene 2 voice/u);
    assert.match(error.message, /only 5\.\d\d s of 10\.0\d s could be decoded/u);
  });

  it("renders from the snapshot: editing public/audio after staging cannot change the staged copy", async () => {
    const source = await tempDirectory();

    await cp("public/audio", join(source, "audio"), {recursive: true});

    const original = await readFile(join(source, "audio", "sfx", "ding.wav"));
    const {publicDir, result} = await prepare(storyOf(scene({sfx: {src: "ding"}})), {
      publicSourceDir: source,
    });

    await writeFile(join(source, "audio", "sfx", "ding.wav"), buildWav({seconds: 9}));

    const stagedPath = join(publicDir, ...result.audioSources.ding.path.split("/"));

    assert.equal(sha(await readFile(stagedPath)), sha(original));
    assert.notEqual(
      sha(await readFile(join(source, "audio", "sfx", "ding.wav"))),
      sha(original),
    );
  });

  it("attaches every decode child to the interrupt guard, and an interrupt during a decode is reported as the interrupt", async () => {
    const attached = [];
    const stop = new Error("interrupted");
    let interrupted = false;
    const calls = [];

    await assert.rejects(
      prepare(storyOf(scene({sfx: {src: "ding"}})), {
        control: {attach: (child) => attached.push(child)},
        checkInterrupt: () => {
          if (interrupted) {
            throw stop;
          }
        },
        // The guard killed the decode: ffmpeg exits non-zero while an interrupt is pending.
        preflight: fakePreflight((child) => {
          interrupted = true;
          child.emit("close", null, "SIGINT");
        }, calls),
      }),
      stop,
    );
    assert.equal(attached.length, 1);
    assert.equal(attached[0], calls[0].child);
  });

  it("stops between files when the interrupt check throws", async () => {
    const calls = [];
    const stop = new Error("interrupted");

    await assert.rejects(
      prepare(storyOf(scene({sfx: {src: "ding"}})), {
        checkInterrupt: () => {
          throw stop;
        },
        preflight: fakePreflight(decodeSeconds(1.2), calls),
      }),
      stop,
    );
    assert.equal(calls.length, 0);
  });

  it("stages nothing under bundled/ for a Story whose only audio is a local file", async () => {
    const publicDir = await tempDirectory();
    const root = await tempDirectory();
    const voice = fixtureBytes("tone-440-2.2s.wav");
    const ref = `local:audio:sha256:${sha(voice)}`;

    await mkdir(join(root, "audio"), {recursive: true});
    await writeFile(join(root, "audio", "v.wav"), voice);
    await prepare(storyOf(scene({voice: {src: ref}})), {localRoot: root, publicDir});

    assert.deepEqual(await readdir(join(publicDir, "__local-assets")), ["audio"]);
  });
});
