import {
  categoryFolder,
  categoryFolderExists,
  displayRoot,
  getLocalAssetsRoot,
  inventoryLocalAssets,
} from "./localAssets.ts";
import type {InventoryLine} from "./localAssets.ts";
import type {LocalAssetCategory} from "../src/localAssets/refs.ts";

const formatLines = (
  root: string,
  category: LocalAssetCategory,
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

  const sections: Array<[LocalAssetCategory, InventoryLine[]]> = [
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

  process.stdout.write(output.join("\n"));
};

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);

  console.error(message);
  process.exitCode = 1;
});
