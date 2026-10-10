import {renderStory} from "./renderStory.ts";
import {getStoryPath} from "./renderSupport.ts";

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
