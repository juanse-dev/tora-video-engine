import {useSyncExternalStore} from "react";
import {audioPreview, type PreviewState} from "./previewPlayback.ts";

/** The page's audio preview state (idle, loading, playing or failed, and for which sound). */
export const useAudioPreviewState = (): PreviewState => {
  const preview = audioPreview();

  return useSyncExternalStore(
    preview.subscribe,
    preview.getState,
    preview.getState,
  );
};
