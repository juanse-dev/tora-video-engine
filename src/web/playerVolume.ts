export const PLAYER_VOLUME_STORAGE_KEY = "tora.playerVolume";

type VolumeStorage = Pick<Storage, "getItem" | "setItem">;

/** Returns null when storage is unavailable; reading `window.localStorage` itself can throw. */
const browserStorage = (): VolumeStorage | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

const isVolume = (value: number): boolean =>
  Number.isFinite(value) && value >= 0 && value <= 1;

/**
 * The remembered Player volume, or null when nothing usable is stored. A
 * convenience only: every failure (no storage, a throwing getter, garbage,
 * a number outside [0, 1]) yields null.
 */
export const readStoredPlayerVolume = (
  getStorage: () => VolumeStorage | null = browserStorage,
): number | null => {
  try {
    const raw = getStorage()?.getItem(PLAYER_VOLUME_STORAGE_KEY);

    if (typeof raw !== "string" || raw.trim() === "") {
      return null;
    }

    const value = Number(raw);

    return isVolume(value) ? value : null;
  } catch {
    return null;
  }
};

/** Remembers the volume; silently does nothing when storage fails or the value is not in [0, 1]. */
export const storePlayerVolume = (
  volume: number,
  getStorage: () => VolumeStorage | null = browserStorage,
): void => {
  try {
    if (!isVolume(volume)) {
      return;
    }

    getStorage()?.setItem(PLAYER_VOLUME_STORAGE_KEY, String(volume));
  } catch {
    // The remembered volume is a convenience, never required.
  }
};
