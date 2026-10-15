import {staticFile} from "remotion";
import {checkLocalAssetByteSize} from "../../src/localAssets/imageInspection.ts";
import type {
  AudioPayloadMetadata,
  ImagePayloadMetadata,
} from "../../src/localAssets/readiness.ts";
import {
  buildLocalAssetRef,
  type ImageAssetCategory,
  type LocalAssetCategory,
  type LocalAssetRef,
  type LocalAudioRef,
  type LocalImageRef,
} from "../../src/localAssets/refs.ts";
import {resolveVisualAssetSrc} from "../../src/localAssets/sources.ts";
import {
  countLocalAssets,
  deleteLocalAsset,
  listLocalAssetPage,
  readAudioDurations,
  renameLocalAsset,
  type AssetLibrary,
} from "../../src/web/assetLibrary/library.ts";
import type {AssetLibraryStore} from "../../src/web/assetLibrary/store.ts";
import {createLocalAssetPageController} from "../../src/web/localAssetPageController.ts";

declare const digest: string;
declare const store: AssetLibraryStore;
declare const library: AssetLibrary;
declare const audioRef: LocalAudioRef;
declare const imageRef: LocalImageRef;

// The widened library APIs accept audio.
export const audioBuilt: LocalAudioRef = buildLocalAssetRef("audio", digest);
export const anyBuilt: LocalAssetRef = buildLocalAssetRef("audio" as LocalAssetCategory, digest);
void checkLocalAssetByteSize(1, "audio");
void store.countAssets("audio");
void store.listAssets("audio", {}, 10);
void store.getAssetRow(audioRef);
void renameLocalAsset(library, audioRef, "Name");
void deleteLocalAsset(library, audioRef);
void listLocalAssetPage(store, "audio");
void countLocalAssets(store, "audio");
void readAudioDurations(store, [audioRef]);
void createLocalAssetPageController({store, category: "audio"});

// Image-only APIs reject an audio category or ref.
// @ts-expect-error an audio ref is not an image ref
export const notImageRef: LocalImageRef = audioRef;
// @ts-expect-error "audio" is not an image category
export const notImageCategory: ImageAssetCategory = "audio";
// @ts-expect-error the visual resolver takes an image category
void resolveVisualAssetSrc("audio", "formal", undefined, staticFile);
// @ts-expect-error a local audio ref is not a Pose
void resolveVisualAssetSrc("pose", audioRef, undefined, staticFile);
// @ts-expect-error image metadata is not audio metadata
export const notImageMeta: ImagePayloadMetadata = {} as AudioPayloadMetadata;
// @ts-expect-error the audio durations are read for audio refs only
void readAudioDurations(store, [imageRef]);
// @ts-expect-error the image overload does not return an audio ref
export const notAudioRef: LocalAudioRef = buildLocalAssetRef("pose", digest);
