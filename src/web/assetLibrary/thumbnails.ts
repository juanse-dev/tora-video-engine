import {MAX_THUMBNAIL_BYTES, MAX_THUMBNAIL_DIMENSION} from "./constants.ts";
import type {ThumbnailRecord} from "./records.ts";

const THUMBNAIL_MIME_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
];

/** Scales to fit inside `max` x `max`, keeps the aspect ratio, never upscales, each side >= 1. */
export const fitWithin = (
  width: number,
  height: number,
  max: number,
): {width: number; height: number} => {
  const scale = Math.min(1, max / width, max / height);

  return {
    width: Math.min(max, Math.max(1, Math.round(width * scale))),
    height: Math.min(max, Math.max(1, Math.round(height * scale))),
  };
};

/**
 * Browser-only default thumbnail generator (needs createImageBitmap and
 * OffscreenCanvas). Node tests inject their own `makeThumbnail`.
 *
 * The image is decoded with the default orientation, so a JPEG with EXIF
 * rotation yields a thumbnail that is already upright. `width`/`height` are
 * the header dimensions; the decoded size must be equal or swapped.
 *
 * Asks for WebP; Safari answers with PNG, so the MIME type that was actually
 * produced is recorded (D-6).
 */
export const createThumbnail = async (
  blob: Blob,
  width: number,
  height: number,
): Promise<ThumbnailRecord> => {
  const bitmap = await createImageBitmap(blob);

  try {
    const sameSize = bitmap.width === width && bitmap.height === height;
    const swappedSize = bitmap.width === height && bitmap.height === width;

    if (!sameSize && !swappedSize) {
      throw new Error("The decoded image size does not match its header.");
    }

    const target = fitWithin(
      bitmap.width,
      bitmap.height,
      MAX_THUMBNAIL_DIMENSION,
    );
    const canvas = new OffscreenCanvas(target.width, target.height);
    const context = canvas.getContext("2d");

    if (context === null) {
      throw new Error("A 2D canvas context is not available.");
    }

    context.drawImage(bitmap, 0, 0, target.width, target.height);

    const thumbnail = await canvas.convertToBlob({
      type: "image/webp",
      quality: 0.8,
    });

    if (!THUMBNAIL_MIME_TYPES.includes(thumbnail.type)) {
      throw new Error(`Unsupported thumbnail type: ${thumbnail.type}`);
    }

    if (thumbnail.size <= 0 || thumbnail.size > MAX_THUMBNAIL_BYTES) {
      throw new Error("The thumbnail size is out of range.");
    }

    return {
      blob: thumbnail,
      mimeType: thumbnail.type,
      width: target.width,
      height: target.height,
    };
  } finally {
    bitmap.close();
  }
};
