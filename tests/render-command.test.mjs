import assert from "node:assert/strict";
import {resolve} from "node:path";
import {describe, it} from "node:test";
import {
  buildRenderArgs,
  COMPOSITION_ID,
  getOutputPath,
  getRemotionCliPath,
  getRemotionExecutable,
  getStoryPath,
  getStorySlug,
  REMOTION_ENTRY_POINT,
} from "../scripts/renderSupport.ts";

describe("render command support", () => {
  it("requires exactly one story path", () => {
    assert.throws(
      () => getStoryPath([]),
      /Missing story path/,
    );
    assert.throws(
      () => getStoryPath(["one.yaml", "two.yaml"]),
      /exactly one story path/,
    );
    assert.equal(
      getStoryPath(["stories/friday-deploy.yaml"]),
      "stories/friday-deploy.yaml",
    );
  });

  it("derives a stable slug and output path from the input filename", () => {
    assert.equal(
      getStorySlug("stories/friday-deploy.yaml"),
      "friday-deploy",
    );
    assert.equal(
      getOutputPath("stories/friday-deploy.yaml"),
      "output/friday-deploy.mp4",
    );
    assert.equal(
      getOutputPath("stories/Deploy de Tóra!.yml"),
      "output/deploy-de-tora.mp4",
    );
  });

  it("rejects filenames that cannot produce an output slug", () => {
    assert.throws(
      () => getOutputPath("stories/😀.yaml"),
      /Could not derive an output filename/,
    );
  });

  it("launches the Remotion JavaScript CLI through the current Node executable", () => {
    assert.equal(getRemotionExecutable(), process.execPath);
    assert.equal(
      getRemotionCliPath(),
      resolve(
        "node_modules",
        "@remotion",
        "cli",
        "remotion-cli.js",
      ),
    );
  });

  it("builds a deterministic H.264 Remotion invocation", () => {
    assert.deepEqual(
      buildRenderArgs(
        "output/friday-deploy.mp4",
        "/tmp/tora/props.json",
      ),
      [
        getRemotionCliPath(),
        "render",
        REMOTION_ENTRY_POINT,
        COMPOSITION_ID,
        "output/friday-deploy.mp4",
        "--codec=h264",
        "--overwrite=true",
        "--props=/tmp/tora/props.json",
      ],
    );
  });
});
