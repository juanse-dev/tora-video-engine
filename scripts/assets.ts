import {
  categoryFolder,
  categoryFolderExists,
  displayRoot,
  getLocalAssetsRoot,
  inventoryAudioAssets,
  inventoryLocalAssets,
} from "./localAssets.ts";
import type {AudioInventoryLine, InventoryLine} from "./localAssets.ts";
import {formatAudioDuration} from "../src/audio/formatDuration.ts";
import type {ImageAssetCategory} from "../src/localAssets/refs.ts";

const formatLines = (
  root: string,
  category: ImageAssetCategory,
  lines: InventoryLine[],
): string[] => {
  const output: string[] = [];

  for (const line of lines) {
    output.push(
      `${displayRoot(root)}/${categoryFolder[category]}/${line.relativePath}`,
      "ref" in line ? `  ${line.ref}` : `  skipped: ${line.rejected}`,
      "",
    );
  }

  return output;
};

const formatAudioLines = (
  root: string,
  lines: AudioInventoryLine[],
): string[] => {
  const output: string[] = [];

  for (const line of lines) {
    output.push(
      `${displayRoot(root)}/${categoryFolder.audio}/${line.relativePath}`,
      ...("ref" in line
        ? [
            `  ${line.ref}`,
            `  duration: ${formatAudioDuration(line.durationSeconds)} (${line.durationSeconds.toFixed(2)} s)`,
          ]
        : [`  skipped: ${line.rejected}`]),
      "",
    );
  }

  return output;
};

const main = async (): Promise<void> => {
  const root = getLocalAssetsRoot();
  const inventory = await inventoryLocalAssets(root);

  if (!inventory.rootExists) {
    const shown = displayRoot(root);

    console.log(
      `No ${shown}/ folder found. Create ${shown}/poses/ and ${shown}/backgrounds/ and copy images into them.`,
    );

    return;
  }

  const sections: Array<[ImageAssetCategory, InventoryLine[]]> = [
    ["pose", inventory.poses],
    ["background", inventory.backgrounds],
  ];
  const output: string[] = [];

  for (const [category, lines] of sections) {
    if (await categoryFolderExists(root, category)) {
      output.push(
        ...(lines.length === 0
          ? [`${displayRoot(root)}/${categoryFolder[category]}/ (no files)`, ""]
          : formatLines(root, category, lines)),
      );
    } else {
      output.push(
        `${displayRoot(root)}/${categoryFolder[category]}/ (folder not found — create it and copy images into it)`,
        "",
      );
    }
  }

  const audio = await inventoryAudioAssets(root);

  // Printed only when the folder exists, so every v0.3 output stays identical.
  if (audio.folderExists) {
    output.push(
      ...(audio.lines.length === 0
        ? [`${displayRoot(root)}/${categoryFolder.audio}/ (no files)`, ""]
        : formatAudioLines(root, audio.lines)),
    );
  }

  process.stdout.write(output.join("\n"));
};

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);

  console.error(message);
  process.exitCode = 1;
});
