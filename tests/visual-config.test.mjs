import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {
  backgroundAssets,
  toraPoseAssets,
} from "../src/assets.ts";
import {scenePresets} from "../src/scenePresets.ts";
import {
  animations,
  backgrounds,
  poses,
  sceneTypes,
} from "../src/story/schema.ts";

describe("visual configuration", () => {
  it("maps every supported pose to a local asset", () => {
    assert.deepEqual(Object.keys(toraPoseAssets), [...poses]);

    for (const path of Object.values(toraPoseAssets)) {
      assert.match(path, /^characters\/tora\/.+\.png$/);
      assert.doesNotMatch(path, /^https?:\/\//);
    }
  });

  it("maps every supported background to a local asset", () => {
    assert.deepEqual(Object.keys(backgroundAssets), [...backgrounds]);

    for (const path of Object.values(backgroundAssets)) {
      assert.match(path, /^backgrounds\/.+\.png$/);
      assert.doesNotMatch(path, /^https?:\/\//);
    }
  });

  it("defines one preset for every scene type", () => {
    assert.deepEqual(Object.keys(scenePresets), [...sceneTypes]);

    for (const preset of Object.values(scenePresets)) {
      if (preset.defaultAnimation) {
        assert.ok(animations.includes(preset.defaultAnimation));
      }
    }
  });

  it("keeps the four presets visually distinct", () => {
    const signatures = Object.values(scenePresets).map((preset) =>
      JSON.stringify({
        captionVariant: preset.captionVariant,
        captionPlacement: preset.captionPlacement,
        toraWidth: preset.toraWidth,
        toraPlacement: preset.toraPlacement,
        overlay: preset.overlay,
      }),
    );

    assert.equal(new Set(signatures).size, sceneTypes.length);
  });
});
