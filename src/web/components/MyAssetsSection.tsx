import {useContext} from "react";
import {
  parseLocalAssetRef,
  type LocalAssetCategory,
  type LocalAssetRef,
} from "../../localAssets/refs.ts";
import {shortAssetId} from "../../localAssets/sources.ts";
import {AssetLibraryContext} from "../assetLibraryContext.ts";
import {
  describeMissingLocalAsset,
  localOnlyDisclosure,
  sceneNumbersUsingRef,
} from "../localAssetUi.ts";
import {useLocalAssetPage} from "../useLocalAssetPage.ts";
import {LocalAssetCard} from "./LocalAssetCard.tsx";

type MyAssetsSectionProps = {
  category: LocalAssetCategory;
  /** The selected scene's pose or background value for this category. */
  selectedValue: string;
  onSelect: (ref: LocalAssetRef) => void;
};

const categoryLabel = (category: LocalAssetCategory) =>
  category === "pose" ? "pose" : "background";

/** The selected value when it is a local ref of this category, else null. */
const currentLocalRef = (
  category: LocalAssetCategory,
  value: string,
): LocalAssetRef | null => {
  const parsed = parseLocalAssetRef(value);

  return parsed !== null && parsed.category === category
    ? (value as LocalAssetRef)
    : null;
};

/**
 * One category's My assets block: heading with the total, the local-only
 * disclosure, the current selection pinned first, the page of cards and paging.
 *
 * Importing, renaming and deleting are wired in ASSET-003 task 3, and the real
 * recovery card replaces the placeholder in task 4.
 */
export const MyAssetsSection = ({
  category,
  selectedValue,
  onSelect,
}: MyAssetsSectionProps) => {
  const context = useContext(AssetLibraryContext);
  const currentRef = currentLocalRef(category, selectedValue);
  const page = useLocalAssetPage(category, currentRef);

  if (context === null) {
    return null;
  }

  const {status, localAssetState, activeStory} = context;
  const ready = status.kind === "ready";
  const noun = categoryLabel(category);
  const placeholder = (
    kind: "missing" | "corrupt" | "unavailable",
    ref: LocalAssetRef,
  ) => {
    if (kind === "unavailable") {
      return (
        <div
          className="asset-card local-asset-card selected current local-asset-placeholder"
          role="group"
          data-local-asset-placeholder={ref}
        >
          <span className="asset-card-copy">
            <strong>Local {noun} unavailable</strong>
            <small>{shortAssetId(ref)}</small>
            <span>{status.kind === "ready" ? "" : status.message}</span>
          </span>
        </div>
      );
    }

    const copy = describeMissingLocalAsset({
      ref,
      sceneNumbers: sceneNumbersUsingRef(activeStory, ref),
      damaged: kind === "corrupt",
    });

    return (
      <div
        className="asset-card local-asset-card selected current local-asset-placeholder"
        role="group"
        data-local-asset-placeholder={ref}
      >
        <span className="asset-card-copy">
          <strong>{copy.title}</strong>
          <small>{copy.shortId}</small>
          <span>{copy.usedBy}</span>
          {copy.damagedNote === null ? null : <span>{copy.damagedNote}</span>}
          <span>{copy.hint}</span>
        </span>
      </div>
    );
  };

  const renderCurrent = () => {
    if (currentRef === null) {
      return null;
    }

    if (!ready) {
      return placeholder("unavailable", currentRef);
    }

    const refState =
      localAssetState.kind === "resolved"
        ? localAssetState.refs.find((item) => item.usage.ref === currentRef)
        : undefined;

    if (refState !== undefined && refState.status !== "ready") {
      return placeholder(refState.status, currentRef);
    }

    const {pinned} = page;

    if (pinned.kind === "missing") {
      return placeholder("missing", currentRef);
    }

    if (pinned.kind !== "present") {
      return null; // still loading
    }

    if (pinned.entry.row.status !== "present") {
      return placeholder("corrupt", currentRef);
    }

    return (
      <LocalAssetCard
        entry={pinned.entry}
        selected
        current
        canManage={ready}
        onSelect={() => onSelect(currentRef)}
      />
    );
  };

  const gridClass =
    category === "pose" ? "asset-grid pose-grid" : "asset-grid background-grid";
  const visibleEntries = page.entries.filter(
    (entry) => entry.ref !== currentRef,
  );

  return (
    <div className="my-assets" data-my-assets={category}>
      <h5>{ready ? `My assets · ${page.total}` : "My assets"}</h5>
      {ready ? (
        <>
          <p className="my-assets-disclosure">
            {localOnlyDisclosure(window.location.origin)}
          </p>
          <div className="my-assets-toolbar">
            {/* Selecting a file is wired in ASSET-003 task 3. */}
            <label className="file-button import-asset-button">
              Import {noun}
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                disabled
              />
            </label>
          </div>
        </>
      ) : (
        <p className="my-assets-status" data-my-assets-status>
          {status.message}
        </p>
      )}

      {ready || currentRef !== null ? (
        <div className={`${gridClass} my-assets-grid`}>
          {renderCurrent()}
          {visibleEntries.map((entry) => (
            <LocalAssetCard
              key={entry.ref}
              entry={entry}
              selected={false}
              canManage={ready}
              onSelect={() => onSelect(entry.ref)}
            />
          ))}
        </div>
      ) : null}

      {ready && page.total === 0 && currentRef === null && !page.loading ? (
        <p className="my-assets-empty">No imported {noun}s yet.</p>
      ) : null}

      {ready && (page.hasPrevious || page.hasNext) ? (
        <div className="my-assets-paging">
          <button
            type="button"
            onClick={page.previous}
            disabled={!page.hasPrevious}
          >
            ‹ Previous
          </button>
          <button type="button" onClick={page.next} disabled={!page.hasNext}>
            Next ›
          </button>
        </div>
      ) : null}
    </div>
  );
};
