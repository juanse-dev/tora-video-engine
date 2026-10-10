import {useContext} from "react";
import {
  parseLocalAssetRef,
  type LocalAssetCategory,
  type LocalAssetRef,
} from "../../localAssets/refs.ts";
import {shortAssetId} from "../../localAssets/sources.ts";
import {
  AssetLibraryContext,
  OPENING_ASSET_LIBRARY,
} from "../assetLibraryContext.ts";
import {
  localOnlyDisclosure,
  sceneNumbersUsingRef,
} from "../localAssetUi.ts";
import {
  LOCAL_ASSET_LOAD_ERROR,
  type LocalAssetPageEntry,
} from "../localAssetPageController.ts";
import {useLocalAssetImport} from "../useLocalAssetImport.ts";
import {useLocalAssetManage} from "../useLocalAssetManage.ts";
import {useLocalAssetPage} from "../useLocalAssetPage.ts";
import {LocalAssetCard} from "./LocalAssetCard.tsx";
import {
  MissingLocalAssetCard,
  type MissingLocalAssetKind,
} from "./MissingLocalAssetCard.tsx";

type MyAssetsSectionProps = {
  category: LocalAssetCategory;
  /** The selected scene's pose or background value for this category. */
  selectedValue: string;
  onSelect: (ref: LocalAssetRef) => void;
};

/**
 * Neutral stand-in for the Current card while its state is still being
 * determined (the library is opening, or the pinned row is loading). It keeps
 * the card in place instead of flickering out on every scene switch.
 */
const PendingCurrentCard = ({
  assetRef,
  category,
  message,
}: {
  assetRef: LocalAssetRef;
  category: LocalAssetCategory;
  message: string;
}) => (
  <div
    className="asset-card local-asset-card selected current local-asset-pending-card"
    role="group"
    aria-busy="true"
    aria-label={`Local ${category} ${shortAssetId(assetRef)}`}
    data-local-asset-pending={assetRef}
  >
    <span className="asset-card-copy">
      <strong>{`Local ${category}`}</strong>
      <small>{shortAssetId(assetRef)}</small>
      <span>{message}</span>
    </span>
  </div>
);

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
 * Import, rename and delete live in the two hooks below; a selected ref that
 * is not ready is shown as a MissingLocalAssetCard.
 */
export const MyAssetsSection = ({
  category,
  selectedValue,
  onSelect,
}: MyAssetsSectionProps) => {
  const context = useContext(AssetLibraryContext);
  const currentRef = currentLocalRef(category, selectedValue);
  const page = useLocalAssetPage(category, currentRef);
  // Importing applies the new ref to the selected scene like clicking a card.
  const imports = useLocalAssetImport(category, onSelect);
  const manage = useLocalAssetManage();

  if (context === null) {
    return null;
  }

  const {status, localAssetState, activeStory, transitionPending} = context;
  const ready = status.kind === "ready";
  const noun = categoryLabel(category);
  const renderMissing = (
    kind: MissingLocalAssetKind,
    assetRef: LocalAssetRef,
    unavailableMessage = "",
  ) => (
    <MissingLocalAssetCard
      assetRef={assetRef}
      category={category}
      kind={kind}
      sceneNumbers={sceneNumbersUsingRef(activeStory, assetRef)}
      unavailableMessage={unavailableMessage}
      // Only a disabled or unavailable LIBRARY hides the action (R11); a ref
      // that is unavailable in a ready library (for example a read failure)
      // can still be restored by importing the original file.
      onImportMatching={
        ready
          ? (file) => {
              manage.clearNotice();
              void imports.importMatchingFile(file, assetRef);
            }
          : undefined
      }
      importDisabled={transitionPending}
    />
  );

  const cardActions = (entry: LocalAssetPageEntry) => ({
    deleteDisabled: transitionPending,
    onRename: (label: string) => {
      imports.clearOutcome();

      return manage.rename(entry.ref, label);
    },
    onDelete: () => {
      imports.clearOutcome();
      manage.requestDelete({
        ref: entry.ref,
        label:
          entry.row.status === "present"
            ? entry.row.value.label
            : `Damaged entry ${shortAssetId(entry.ref)}`,
        category,
      });
    },
  });

  const renderCurrent = () => {
    if (currentRef === null) {
      return null;
    }

    if (status === OPENING_ASSET_LIBRARY) {
      return (
        <PendingCurrentCard
          assetRef={currentRef}
          category={category}
          message={OPENING_ASSET_LIBRARY.message}
        />
      );
    }

    if (!ready) {
      return renderMissing("unavailable", currentRef, status.message);
    }

    const refState =
      localAssetState.kind === "resolved"
        ? localAssetState.refs.find((item) => item.usage.ref === currentRef)
        : undefined;

    if (refState !== undefined && refState.status !== "ready") {
      return renderMissing(
        refState.status,
        currentRef,
        refState.detail ?? "",
      );
    }

    // `pinned` describes the ref it was loaded for; for any other ref (the
    // scene just changed) it is still loading, never the previous ref's card.
    const pinned =
      page.pinnedFor === currentRef ? page.pinned : {kind: "loading" as const};

    if (pinned.kind === "missing") {
      return renderMissing("missing", currentRef);
    }

    if (pinned.kind === "error") {
      return renderMissing("unavailable", currentRef, LOCAL_ASSET_LOAD_ERROR);
    }

    if (pinned.kind !== "present" || pinned.entry.ref !== currentRef) {
      return (
        <PendingCurrentCard
          assetRef={currentRef}
          category={category}
          message="Loading…"
        />
      );
    }

    if (pinned.entry.row.status !== "present") {
      return renderMissing("corrupt", currentRef);
    }

    return (
      <LocalAssetCard
        entry={pinned.entry}
        selected
        current
        canManage={ready}
        {...cardActions(pinned.entry)}
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
            <label className="file-button import-asset-button">
              Import {noun}
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                // Never start an import under a pending App transition panel
                // (an open asset dialog already disables the whole fieldset).
                disabled={transitionPending}
                onChange={(event) => {
                  const file = event.target.files?.[0];

                  if (file !== undefined) {
                    manage.clearNotice();
                    void imports.importFile(file);
                  }

                  // Lets the same file be chosen again.
                  event.target.value = "";
                }}
              />
            </label>
          </div>
          <p className="my-assets-status" role="status">
            {imports.statusText}
          </p>
          {imports.errorText === null ? null : (
            <p className="my-assets-status my-assets-error" role="alert">
              {imports.errorText}
            </p>
          )}
          {manage.notice === null ? null : (
            <p className="my-assets-status my-assets-error" role="alert">
              {manage.notice}
            </p>
          )}
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
              {...cardActions(entry)}
              onSelect={() => onSelect(entry.ref)}
            />
          ))}
        </div>
      ) : null}

      {ready && page.error !== null ? (
        <p className="my-assets-status" role="alert">
          {page.error}
        </p>
      ) : null}

      {ready &&
      page.error === null &&
      page.total === 0 &&
      currentRef === null &&
      page.loaded &&
      !page.loading ? (
        <p className="my-assets-empty">No imported {noun}s yet.</p>
      ) : null}

      {ready && (page.hasPrevious || page.hasNext) ? (
        <div className="my-assets-paging">
          <button
            type="button"
            onClick={page.previous}
            disabled={page.loading || !page.hasPrevious}
          >
            <span aria-hidden="true">‹</span> Previous
          </button>
          <button
            type="button"
            onClick={page.next}
            disabled={page.loading || !page.hasNext}
          >
            Next <span aria-hidden="true">›</span>
          </button>
        </div>
      ) : null}
    </div>
  );
};
