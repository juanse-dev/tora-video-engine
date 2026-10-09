export const localAssetCategories = ["pose", "background"] as const;
export type LocalAssetCategory = (typeof localAssetCategories)[number];

export type LocalPoseRef = `local:pose:sha256:${string}`;
export type LocalBackgroundRef = `local:background:sha256:${string}`;
export type LocalAssetRef = LocalPoseRef | LocalBackgroundRef;

export const LOCAL_ASSET_REF_PATTERN =
  /^local:(pose|background):sha256:[0-9a-f]{64}$/u;
export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/u;

export const isLocalAssetRef = (value: string): value is LocalAssetRef =>
  LOCAL_ASSET_REF_PATTERN.test(value);

export const isLocalPoseRef = (value: string): value is LocalPoseRef =>
  isLocalAssetRef(value) && value.startsWith("local:pose:");

export const isLocalBackgroundRef = (
  value: string,
): value is LocalBackgroundRef =>
  isLocalAssetRef(value) && value.startsWith("local:background:");

/** Returns null for anything that is not an exact canonical local ref. */
export const parseLocalAssetRef = (
  value: string,
): {category: LocalAssetCategory; digest: string} | null => {
  const match = LOCAL_ASSET_REF_PATTERN.exec(value);

  if (match === null) {
    return null;
  }

  return {
    category: match[1] as LocalAssetCategory,
    digest: value.slice(value.length - 64),
  };
};

const isLocalAssetCategory = (value: unknown): value is LocalAssetCategory =>
  typeof value === "string" &&
  (localAssetCategories as readonly string[]).includes(value);

/** Primary-key prefix for one category, e.g. "local:pose:sha256:". */
export const localAssetRefPrefix = (category: LocalAssetCategory): string =>
  `local:${category}:sha256:`;

/** Throws if digest is not 64 lowercase hex. */
export const buildLocalAssetRef = (
  category: LocalAssetCategory,
  digest: string,
): LocalAssetRef => {
  if (!isLocalAssetCategory(category)) {
    throw new Error(`Unknown local asset category: ${String(category)}`);
  }

  if (!SHA256_HEX_PATTERN.test(digest)) {
    throw new Error("Local asset digest must be 64 lowercase hex characters");
  }

  return `${localAssetRefPrefix(category)}${digest}` as LocalAssetRef;
};
