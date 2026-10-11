import {spawn} from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {
  getLocalAssetsRoot,
  stageLocalAssetsForStory,
} from "./localAssets.ts";
import {
  buildRenderArgs,
  getOutputPath,
  getRemotionExecutable,
} from "./renderSupport.ts";
import {
  createInterruptGuard,
  type InterruptGuardOptions,
  type RenderControl,
} from "./interrupt.ts";
import {storyHasLocalAssetRefs} from "../src/localAssets/readiness.ts";
import {loadStory} from "../src/story/loadStory.ts";

export type RunRemotion = (
  executable: string,
  args: string[],
  /** Lets the interrupt guard reach the child; fakes may ignore it. */
  control: RenderControl,
) => Promise<void>;

export type RenderStoryDeps = {
  /** Replaces the Remotion child process (tests). */
  runRemotion?: RunRemotion;
  /** Parent of the temporary directory; defaults to the OS temp directory. */
  tempBase?: string;
  /** Overrides `TORA_LOCAL_ASSETS_ROOT` / `local-assets`. */
  localAssetsRoot?: string;
  /** Replaces `child_process.spawn` in the real runner (tests). */
  spawn?: typeof spawn;
  /** Signal source, platform and timers for Ctrl+C handling (tests). */
  interrupt?: InterruptGuardOptions;
};

const createRunRemotionProcess =
  (spawnProcess: typeof spawn): RunRemotion =>
  async (executable, args, control) => {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const child = spawnProcess(executable, args, {
        stdio: "inherit",
      });

      control.attach(child);

      child.once("error", rejectPromise);
      child.once("close", (code, signal) => {
        if (code === 0) {
          resolvePromise();
          return;
        }

        const reason =
          signal === null
            ? `exit code ${code ?? "unknown"}`
            : `signal ${signal}`;

        rejectPromise(
          new Error(`Remotion render failed with ${reason}`),
        );
      });
    });
  };

export const renderStory = async (
  storyPath: string,
  deps: RenderStoryDeps = {},
): Promise<string> => {
  const runRemotion =
    deps.runRemotion ?? createRunRemotionProcess(deps.spawn ?? spawn);
  const outputPath = getOutputPath(storyPath);

  await mkdir(dirname(outputPath), {recursive: true});
  await rm(outputPath, {force: true});

  const story = await loadStory(storyPath);

  const temporaryDirectory = await mkdtemp(
    join(deps.tempBase ?? tmpdir(), "tora-video-engine-"),
  );
  const propsPath = join(temporaryDirectory, "props.json");
  // Installed once the directory exists and removed only after it is gone,
  // so a signal at any point in between still ends in the cleanup below.
  const guard = createInterruptGuard(deps.interrupt);

  try {
    let props: Record<string, unknown> = {story};
    let publicDir: string | undefined;

    if (storyHasLocalAssetRefs(story)) {
      // Bundled-only Stories never reach this branch, so the root is not
      // required for them and their command line is unchanged.
      publicDir = join(temporaryDirectory, "public");
      await cp("public", publicDir, {recursive: true});

      const staged = await stageLocalAssetsForStory(story, {
        root: deps.localAssetsRoot ?? getLocalAssetsRoot(),
        publicDir,
      });

      props = {story, localAssetSources: staged.sources};
    }

    await writeFile(propsPath, JSON.stringify(props), "utf8");
    guard.throwIfInterrupted();

    try {
      await runRemotion(
        getRemotionExecutable(),
        buildRenderArgs(outputPath, propsPath, publicDir),
        guard,
      );
      // An interrupt wins even if the child finished first: the output of an
      // interrupted run is not kept.
      guard.throwIfInterrupted();
    } catch (error) {
      await rm(outputPath, {force: true});
      // The child's own failure (killed by the signal) is not the story.
      guard.throwIfInterrupted();
      throw error;
    }

    return outputPath;
  } finally {
    try {
      await rm(temporaryDirectory, {
        recursive: true,
        force: true,
      });
    } finally {
      guard.dispose();
    }
  }
};
