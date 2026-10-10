/**
 * SHA-256 of exactly the given bytes, as 64 lowercase hex characters.
 * Used for local asset identity (INV-3): hash the original file bytes, never a
 * thumbnail, filename, label, MIME type or category.
 *
 * Works in browsers and Node 22 (both expose `globalThis.crypto.subtle`).
 */
export const sha256Hex = async (
  bytes: Uint8Array,
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<string> => {
  const digest = await subtle.digest("SHA-256", bytes as BufferSource);
  const view = new Uint8Array(digest);
  let hex = "";

  for (const byte of view) {
    hex += byte.toString(16).padStart(2, "0");
  }

  return hex;
};
