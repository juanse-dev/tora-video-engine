import type {ImageRejection} from "../../localAssets/imageInspection.ts";
import type {LocalAssetCategory} from "../../localAssets/refs.ts";
import {MAX_LOCAL_ASSET_LABEL_LENGTH} from "./constants.ts";

export type ImportPhase =
  | "reading"
  | "validating"
  | "decoding"
  | "hashing"
  | "storing";

export type LocalAssetImportErrorCode =
  | ImageRejection
  | "decode-failed"
  | "thumbnail-failed"
  | "audio-rejected"
  | "audio-decode-failed"
  | "audio-truncated"
  | "storage-full"
  | "storage-error"
  /** The user cancelled while the commit was still waiting for the library lock; nothing was written. */
  | "cancelled";

export class LocalAssetImportError extends Error {
  code: LocalAssetImportErrorCode;
  cause?: unknown;

  constructor(
    code: LocalAssetImportErrorCode,
    message: string,
    options?: {cause?: unknown},
  ) {
    super(message);
    this.name = "LocalAssetImportError";
    this.code = code;

    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/**
 * D-12: filename without its last extension, trimmed, cut to the label limit in
 * code points; falls back to "Untitled <category>" when nothing is left.
 */
export const buildDefaultLabel = (
  filename: string,
  category: LocalAssetCategory,
): string => {
  const dot = filename.lastIndexOf(".");
  const stem = dot === -1 ? filename : filename.slice(0, dot);
  const label = Array.from(stem.trim())
    .slice(0, MAX_LOCAL_ASSET_LABEL_LENGTH)
    .join("")
    .trim();

  return label === "" ? `Untitled ${category}` : label;
};
