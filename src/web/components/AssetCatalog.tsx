import {staticFile} from "remotion";
import {
  animationCatalog,
  backgroundCatalog,
  toraPoseCatalog,
} from "../../assets.ts";
import type {
  LocalBackgroundRef,
  LocalPoseRef,
} from "../../localAssets/refs.ts";
import type {VisualSceneDraft} from "../visualDraft.ts";
import {MyAssetsSection} from "./MyAssetsSection.tsx";

type AssetCatalogProps = {
  scene: VisualSceneDraft;
  onChange: (patch: Partial<VisualSceneDraft>) => void;
};

const SelectionMark = ({selected}: {selected: boolean}) => (
  <span className="asset-selection-mark" aria-hidden="true">
    {selected ? "✓ Selected" : "Select"}
  </span>
);

export const AssetCatalog = ({
  scene,
  onChange,
}: AssetCatalogProps) => {
  return (
    <section
      className="asset-catalog"
      aria-labelledby="asset-catalog-heading"
    >
      <div className="asset-catalog-heading">
        <div>
          <p className="section-kicker">Visual vocabulary</p>
          <h3 id="asset-catalog-heading">Available assets</h3>
        </div>
        <small>Applies to the selected scene</small>
      </div>

      <div className="asset-category">
        <h4>Tora poses</h4>
        <h5 className="asset-subheading">Bundled</h5>
        <div className="asset-grid pose-grid">
          {Object.values(toraPoseCatalog).map((asset) => {
            const selected = scene.pose === asset.storyValue;

            return (
              <button
                key={asset.id}
                type="button"
                className={
                  selected
                    ? "asset-card image-card selected"
                    : "asset-card image-card"
                }
                aria-pressed={selected}
                onClick={() =>
                  onChange({pose: asset.storyValue})
                }
              >
                {/* Editor chrome thumbnail, not Remotion composition media. */}
                {/* eslint-disable-next-line @remotion/warn-native-media-tag */}
                <img
                  src={staticFile(asset.previewPath)}
                  alt=""
                  className="asset-thumbnail pose-thumbnail"
                />
                <span className="asset-card-copy">
                  <strong>{asset.label}</strong>
                  <SelectionMark selected={selected} />
                </span>
              </button>
            );
          })}
        </div>
        <MyAssetsSection
          category="pose"
          selectedValue={scene.pose}
          // The section only lists refs of its own category.
          onSelect={(ref) => onChange({pose: ref as LocalPoseRef})}
        />
      </div>

      <div className="asset-category">
        <h4>Backgrounds</h4>
        <h5 className="asset-subheading">Bundled</h5>
        <div className="asset-grid background-grid">
          {Object.values(backgroundCatalog).map((asset) => {
            const selected = scene.background === asset.storyValue;

            return (
              <button
                key={asset.id}
                type="button"
                className={
                  selected
                    ? "asset-card image-card selected"
                    : "asset-card image-card"
                }
                aria-pressed={selected}
                onClick={() =>
                  onChange({background: asset.storyValue})
                }
              >
                {/* Editor chrome thumbnail, not Remotion composition media. */}
                {/* eslint-disable-next-line @remotion/warn-native-media-tag */}
                <img
                  src={staticFile(asset.previewPath)}
                  alt=""
                  className="asset-thumbnail background-thumbnail"
                />
                <span className="asset-card-copy">
                  <strong>{asset.label}</strong>
                  <SelectionMark selected={selected} />
                </span>
              </button>
            );
          })}
        </div>
        <MyAssetsSection
          category="background"
          selectedValue={scene.background}
          onSelect={(ref) =>
            onChange({background: ref as LocalBackgroundRef})
          }
        />
      </div>

      <div className="asset-category">
        <h4>Animations</h4>
        <div className="animation-grid">
          <button
            type="button"
            className={
              scene.animation === ""
                ? "asset-card animation-card selected"
                : "asset-card animation-card"
            }
            aria-pressed={scene.animation === ""}
            onClick={() => onChange({animation: ""})}
          >
            <span>
              <strong>Auto / scene default</strong>
              <small>Use the scene preset animation.</small>
            </span>
            <SelectionMark selected={scene.animation === ""} />
          </button>

          {Object.values(animationCatalog).map((asset) => {
            const selected = scene.animation === asset.storyValue;

            return (
              <button
                key={asset.id}
                type="button"
                className={
                  selected
                    ? "asset-card animation-card selected"
                    : "asset-card animation-card"
                }
                aria-pressed={selected}
                onClick={() =>
                  onChange({animation: asset.storyValue})
                }
              >
                <span>
                  <strong>{asset.label}</strong>
                  <small>{asset.storyValue}</small>
                </span>
                <SelectionMark selected={selected} />
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
};
