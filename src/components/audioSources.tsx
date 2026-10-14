import {createContext, useContext, useMemo, type ReactNode} from "react";
import type {
  AudioSourceMap,
  BundledAudioPolicy,
} from "../audio/sources.ts";

type AudioSourcesValue = {
  sources: AudioSourceMap | undefined;
  policy: BundledAudioPolicy;
};

const AudioSourcesContext = createContext<AudioSourcesValue>({
  sources: undefined,
  policy: "static-fallback",
});

/** Carries `{sources, policy}` to `StoryAudio`; the image provider is separate. */
export const AudioSourcesProvider = ({
  sources,
  policy,
  children,
}: {
  sources: AudioSourceMap | undefined;
  policy: BundledAudioPolicy;
  children: ReactNode;
}) => {
  const value = useMemo(() => ({sources, policy}), [sources, policy]);

  return (
    <AudioSourcesContext.Provider value={value}>
      {children}
    </AudioSourcesContext.Provider>
  );
};

export const useAudioSources = (): AudioSourcesValue =>
  useContext(AudioSourcesContext);
