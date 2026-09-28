import {spawn} from "node:child_process";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {
  buildRenderArgs,
  getOutputPath,
  getRemotionExecutable,
  getStoryPath,
} from "./renderSupport.ts";
import {loadStory} from "../src/story/loadStory.ts";

const runRemotion = async (
  executable: string,
  args: string[],
): Promise<void> => {
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

export const renderStory = async (storyPath: string): Promise<string> => {
  const outputPath = getOutputPath(storyPath);

  await mkdir(dirname(outputPath), {recursive: true});
  await rm(outputPath, {force: true});

  const story = await loadStory(storyPath);

  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "tora-video-engine-"),
  );
  const propsPath = join(temporaryDirectory, "props.json");

  try {
    await writeFile(
      propsPath,
      JSON.stringify({story}),
      "utf8",
    );

    try {
      await runRemotion(
        getRemotionExecutable(),
        buildRenderArgs(outputPath, propsPath),
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

const main = async (): Promise<void> => {
  const storyPath = getStoryPath(process.argv.slice(2));
  const outputPath = await renderStory(storyPath);

  console.log(`Rendered ${outputPath}`);
};

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : String(error);

  console.error(message);
  process.exitCode = 1;
});
