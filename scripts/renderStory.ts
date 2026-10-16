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
import {prepareCliAudio} from "./audioRender.ts";
import type {AudioPreflightDeps} from "./audioPreflight.ts";
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
  type CleanupFailure,
  createInterruptGuard,
  type InterruptGuardOptions,
  type RenderControl,
  RenderInterruptedError,
} from "./interrupt.ts";
import {storyHasAudio} from "../src/audio/storyAudio.ts";
import {storyHasLocalAssetRefs} from "../src/localAssets/readiness.ts";
import {isLocalAudioRef} from "../src/localAssets/refs.ts";
import type {LocalAssetSourceMap} from "../src/localAssets/sources.ts";
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
  /** The directory copied into the staging directory and read for bundled audio. Defaults to `public`. */
  publicSourceDir?: string;
  /** Replaces the ffmpeg process of the audio decode preflight (tests). */
  audioPreflight?: AudioPreflightDeps;
  /** Replaces `child_process.spawn` in the real runner (tests). */
  spawn?: typeof spawn;
  /** Signal source, platform and timers for Ctrl+C handling (tests). */
  interrupt?: InterruptGuardOptions;
  /** Replaces `fs.mkdtemp` for the temporary directory (tests). */
  makeTempDirectory?: (prefix: string) => Promise<string>;
  /** Replaces `fs.rm` for the partial output after an interrupt (tests). */
  removeOutput?: (path: string, options: {force: true}) => Promise<void>;
  /** Replaces `fs.rm` for the temporary directory (tests). */
  removeDirectory?: (
    path: string,
    options: {recursive: true; force: true},
  ) => Promise<void>;
};

const createRunRemotionProcess =
  (spawnProcess: typeof spawn): RunRemotion =>
  async (executable, args, control) => {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const child = spawnProcess(executable, args, {
        stdio: "inherit",
        // Its own process group on POSIX, so an interrupt can signal the
        // Chrome and ffmpeg it starts too (Windows uses taskkill /T instead).
        detached: process.platform !== "win32",
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

  // Installed before the directory is created and removed only after it is
  // gone, so a signal at any point in between still ends in the cleanup below.
  const guard = createInterruptGuard(deps.interrupt);

  // A signal that lands after the last check (while the temporary directory
  // is being removed) still ends the run as interrupted: the output goes.
  // A failed removal after a signal is carried on the interrupt error, so the
  // CLI names the directory left behind instead of claiming a cleanup.
  let cleanupFailure: CleanupFailure | null = null;
  const failIfInterrupted = async (): Promise<void> => {
    if (guard.signal !== null) {
      try {
        await (deps.removeOutput ?? rm)(outputPath, {force: true});
      } catch (error) {
        // Still an interrupt (130/143): name the file left behind as well.
        cleanupFailure ??= {path: outputPath, error};
      }

      throw new RenderInterruptedError(guard.signal, {cleanupFailure});
    }
  };

  try {
    const temporaryDirectory = await (deps.makeTempDirectory ?? mkdtemp)(
      join(deps.tempBase ?? tmpdir(), "tora-video-engine-"),
    );
    const propsPath = join(temporaryDirectory, "props.json");

    try {
      // A signal while the directory was being created: skip the staging.
      guard.throwIfInterrupted();

      const hasAudio = storyHasAudio(story);
      const publicSourceDir = deps.publicSourceDir ?? "public";
      let props: Record<string, unknown> = {story};
      let publicDir: string | undefined;

      // A Story without local refs and without audio never reaches this
      // branch, so the root is not required for it and its command line and
      // props are exactly the v0.3 ones (AINV-6). Audio needs the staging
      // directory even when it is all bundled: Remotion reads the staged copy.
      if (storyHasLocalAssetRefs(story) || hasAudio) {
        publicDir = join(temporaryDirectory, "public");
        await cp(publicSourceDir, publicDir, {recursive: true});

        const localNames = new Map<string, string>();
        const staged = await stageLocalAssetsForStory(story, {
          root: deps.localAssetsRoot ?? getLocalAssetsRoot(),
          publicDir,
          onStaged: (ref, _stagedPath, relativePath) => {
            localNames.set(ref, relativePath);
          },
        });

        if (storyHasLocalAssetRefs(story)) {
          // Images only: the audio sources travel in `audioSources`.
          props = {
            story,
            localAssetSources: Object.fromEntries(
              Object.entries(staged.sources).filter(
                ([ref]) => !isLocalAudioRef(ref),
              ),
            ) as LocalAssetSourceMap,
          };
        }

        if (hasAudio) {
          guard.throwIfInterrupted();

          const audio = await prepareCliAudio(story, {
            publicDir,
            localSources: staged.sources,
            localNames,
            publicSourceDir,
            checkInterrupt: () => guard.throwIfInterrupted(),
            control: guard,
            preflight: deps.audioPreflight,
          });

          props = {
            ...props,
            audioDurations: audio.audioDurations,
            audioSources: audio.audioSources,
            bundledAudioPolicy: "explicit",
            audioArmed: true,
          };
        }
      }

      await writeFile(propsPath, JSON.stringify(props), "utf8");
      guard.throwIfInterrupted();

      try {
        await runRemotion(
          getRemotionExecutable(),
          buildRenderArgs(outputPath, propsPath, publicDir, {
            hasAudio: storyHasAudio(story),
          }),
          guard,
        );
        // An interrupt wins even if the child finished first: the output of
        // an interrupted run is not kept.
        guard.throwIfInterrupted();
      } catch (error) {
        await rm(outputPath, {force: true});
        // The child's own failure (killed by the signal) is not the story.
        guard.throwIfInterrupted();
        throw error;
      }
    } finally {
      try {
        await (deps.removeDirectory ?? rm)(temporaryDirectory, {
          recursive: true,
          force: true,
        });
      } catch (error) {
        // Recorded, not thrown from the finally: a render error stays the
        // reported failure, and an interrupt reports what was left behind.
        cleanupFailure = {path: temporaryDirectory, error};
      }
    }

    await failIfInterrupted();

    if (cleanupFailure !== null) {
      throw cleanupFailure.error;
    }

    return outputPath;
  } catch (error) {
    await failIfInterrupted();
    throw error;
  } finally {
    guard.dispose();
  }
};
