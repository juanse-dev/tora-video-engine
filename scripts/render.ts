import {reportRenderError} from "./interrupt.ts";
import {renderStory} from "./renderStory.ts";
import {getStoryPath} from "./renderSupport.ts";

const main = async (): Promise<void> => {
  const storyPath = getStoryPath(process.argv.slice(2));
  const outputPath = await renderStory(storyPath);

  console.log(`Rendered ${outputPath}`);
};

main().catch((error: unknown) => {
  reportRenderError(error, {
    error: (line) => console.error(line),
    exit: (code) => {
      process.exitCode = code;
    },
  });
});
