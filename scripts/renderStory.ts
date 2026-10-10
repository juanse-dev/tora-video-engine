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
import {storyHasLocalAssetRefs} from "../src/localAssets/readiness.ts";
import {loadStory} from "../src/story/loadStory.ts";

export type RunRemotion = (
  executable: string,
  args: string[],
) => Promise<void>;

export type RenderStoryDeps = {
  /** Replaces the Remotion child process (tests). */
  runRemotion?: RunRemotion;
  /** Parent of the temporary directory; defaults to the OS temp directory. */
  tempBase?: string;
  /** Overrides `TORA_LOCAL_ASSETS_ROOT` / `local-assets`. */
  localAssetsRoot?: string;
};

const runRemotionProcess: RunRemotion = async (executable, args) => {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(executable, args, {
      stdio: "inherit",
    });

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
  const runRemotion = deps.runRemotion ?? runRemotionProcess;
  const outputPath = getOutputPath(storyPath);

  await mkdir(dirname(outputPath), {recursive: true});
  await rm(outputPath, {force: true});

  const story = await loadStory(storyPath);

  const temporaryDirectory = await mkdtemp(
    join(deps.tempBase ?? tmpdir(), "tora-video-engine-"),
  );
  const propsPath = join(temporaryDirectory, "props.json");

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

    try {
      await runRemotion(
        getRemotionExecutable(),
        buildRenderArgs(outputPath, propsPath, publicDir),
      );
    } catch (error) {
      await rm(outputPath, {force: true});
      throw error;
    }

    return outputPath;
  } finally {
    await rm(temporaryDirectory, {
      recursive: true,
      force: true,
    });
  }
};
