import {useContext, useEffect} from "react";
import type {LocalAudioRef} from "../../localAssets/refs.ts";
import {shortAssetId} from "../../localAssets/sources.ts";
import {audioPreview} from "../audio/previewPlayback.ts";
import {useAudioPreviewState} from "../audio/useAudioPreview.ts";
import {AssetLibraryContext} from "../assetLibraryContext.ts";
import type {MutationCancelable} from "../localAssetManageFlow.ts";
import {
  LOCAL_ASSET_LOAD_ERROR,
  type LocalAssetPageEntry,
} from "../localAssetPageController.ts";
import {
  activeStoryAudioUsage,
  audioRefUsesMusic,
  fileAcceptFor,
  localOnlyDisclosure,
  sceneNumbersUsingAudioRef,
  type SceneAudioValues,
} from "../localAssetUi.ts";
import {useLocalAssetImport} from "../useLocalAssetImport.ts";
import {useLocalAssetManage} from "../useLocalAssetManage.ts";
import {useLocalAssetPage} from "../useLocalAssetPage.ts";
import {LocalAssetCard} from "./LocalAssetCard.tsx";
import {MissingLocalAssetCard} from "./MissingLocalAssetCard.tsx";

type MyAudioSectionProps = {
  /** What the user is looking at: the visual draft's music and scenes (a pending draft is never under-counted). */
  music?: {readonly src: string};
  scenes: readonly SceneAudioValues[];
};

// Nothing is selected from this list, by design: the Music, Sound effect and Voice selects pick sounds.
const ignoreImportedRef = () => {};

/**
 * Ends a preview whose card is not listed (another page of the list, or the row
 * is gone): it has no Stop button left. Renders nothing; a component only so
 * that its effect can sit below `MyAudioSection`'s early return.
 */
const StopPreviewWhenUnlisted = ({listedRefs}: {listedRefs: readonly string[]}) => {
  useEffect(() => {
    const current = audioPreview().getState();

    if (current.kind !== "idle" && !listedRefs.includes(current.ref)) {
      audioPreview().stopRef(current.ref);
    }
  });

  return null;
};

/**
 * The minimal My audio list: heading with the total, the local-only
 * disclosure, Import audio, a card per file (label, duration, rename, delete),
 * a missing card for every audio ref of the Story that is not usable here
 * (with Import matching file), and paging.
 */
export const MyAudioSection = ({music, scenes}: MyAudioSectionProps) => {
  const context = useContext(AssetLibraryContext);
  const page = useLocalAssetPage("audio");
  const imports = useLocalAssetImport("audio", ignoreImportedRef);
  const manage = useLocalAssetManage();
  const preview = useAudioPreviewState();

  // Leaving the editor (or this section) ends a preview that is still playing.
  useEffect(() => () => audioPreview().stop(), []);

  if (context === null) {
    return null;
  }

  const {status, localAssetState, transitionPending, acquirePreviewUrl} = context;
  const ready = status.kind === "ready";
  const story = {music, scenes};
  const usageOf = (ref: LocalAudioRef) => ({
    sceneNumbers: sceneNumbersUsingAudioRef(story, ref),
    usesMusic: audioRefUsesMusic(story, ref),
  });
  const missing =
    localAssetState.kind === "resolved"
      ? localAssetState.refs.filter(
          (item) => item.usage.category === "audio" && item.status !== "ready",
        )
      : [];
  // A ref shown as missing/damaged never also gets a regular card (same React key,
  // and a damaged asset must not look usable), as the image section does for its current ref.
  const missingRefs = new Set<string>(missing.map((item) => item.usage.ref));
  const visibleEntries = page.entries.filter((entry) => !missingRefs.has(entry.ref));

  const cardActions = (entry: LocalAssetPageEntry) => ({
    deleteDisabled: transitionPending,
    onRename: (label: string, onCancelable: MutationCancelable) => {
      imports.clearOutcome();

      return manage.rename(entry.ref, label, onCancelable);
    },
    onDelete: () => {
      const usage = usageOf(entry.ref as LocalAudioRef);

      audioPreview().stopRef(entry.ref as LocalAudioRef);
      imports.clearOutcome();
      manage.requestDelete({
        ref: entry.ref,
        label:
          entry.row.status === "present"
            ? entry.row.value.label
            : `Damaged entry ${shortAssetId(entry.ref)}`,
        category: "audio",
        sceneCount: usage.sceneNumbers.length,
        usesMusic: usage.usesMusic,
        sceneNumbers: usage.sceneNumbers,
      });
    },
  });

  return (
    <div className="my-assets my-audio" data-my-audio="">
      <StopPreviewWhenUnlisted
        listedRefs={ready ? visibleEntries.map((entry) => entry.ref) : []}
      />
      <h5>{ready ? `My audio · ${page.total}` : "My audio"}</h5>
      {ready ? (
        <>
          <p className="my-assets-disclosure">
            {localOnlyDisclosure(window.location.origin)}
          </p>
          <div className="my-assets-toolbar">
            <label className="file-button import-asset-button">
              Import audio
              <input
                type="file"
                accept={fileAcceptFor("audio")}
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
            {imports.statusText !== ""
              ? imports.statusText
              : (manage.cancelledNotice ?? "")}
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

      {missing.length > 0 || (ready && page.entries.length > 0) ? (
        <div className="asset-grid audio-grid my-assets-grid">
          {missing.map((item) => (
            <MissingLocalAssetCard
              key={item.usage.ref}
              assetRef={item.usage.ref}
              category="audio"
              kind={item.status === "ready" ? "missing" : item.status}
              {...activeStoryAudioUsage(item.usage)}
              unavailableMessage={item.detail ?? ""}
              // Only a disabled or unavailable LIBRARY hides the action (R11).
              onImportMatching={
                ready
                  ? (file) => {
                      manage.clearNotice();
                      void imports.importMatchingFile(file, item.usage.ref);
                    }
                  : undefined
              }
              importDisabled={transitionPending}
            />
          ))}
          {ready
            ? visibleEntries.map((entry) => (
                <LocalAssetCard
                  key={entry.ref}
                  entry={entry}
                  selected={false}
                  canManage
                  {...cardActions(entry)}
                  preview={{
                    active:
                      (preview.kind === "loading" || preview.kind === "playing") &&
                      preview.ref === entry.ref,
                    error:
                      preview.kind === "failed" && preview.ref === entry.ref
                        ? preview.message
                        : null,
                    onToggle: () =>
                      void audioPreview().toggle(
                        entry.ref as LocalAudioRef,
                        acquirePreviewUrl,
                      ),
                  }}
                />
              ))
            : null}
        </div>
      ) : null}

      {ready && page.error !== null ? (
        <p className="my-assets-status" role="alert">
          {LOCAL_ASSET_LOAD_ERROR}
        </p>
      ) : null}

      {ready &&
      missing.length === 0 &&
      page.error === null &&
      page.total === 0 &&
      page.loaded &&
      !page.loading ? (
        <p className="my-assets-empty">No imported audio yet.</p>
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
