export const MAX_THUMBNAIL_DIMENSION = 256;
export const MAX_THUMBNAIL_BYTES = 512 * 1024;
/** Thumbnails are PNG or WebP only (D-6); payloads may also be JPEG. */
export const THUMBNAIL_MIME_TYPES = ["image/png", "image/webp"] as const;
export const LOCAL_ASSET_PAGE_SIZE = 50;
/** Code points, counted after trimming. */
export const MAX_LOCAL_ASSET_LABEL_LENGTH = 80;
export const ASSET_DB_NAME = "tora-video-engine-assets";
export const ASSET_DB_VERSION = 1;
export const ASSET_LIBRARY_LOCK = "tora-video-engine:asset-library";
export const ASSET_LIBRARY_CHANNEL = "tora-video-engine:asset-library";
