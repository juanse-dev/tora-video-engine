import {createContext, useContext, type ReactNode} from "react";
import {staticFile} from "remotion";
import type {LocalAssetCategory} from "../localAssets/refs.ts";
import {
  resolveVisualAssetSrc,
  type LocalAssetSourceMap,
  type VisualAssetResolution,
} from "../localAssets/sources.ts";
import type {Background, Pose} from "../story/types.ts";

const LocalAssetSourcesContext = createContext<LocalAssetSourceMap | undefined>(
  undefined,
);

export const LocalAssetSourcesProvider = ({
  sources,
  children,
}: {
  sources: LocalAssetSourceMap | undefined;
  children: ReactNode;
}) => (
  <LocalAssetSourcesContext.Provider value={sources}>
    {children}
  </LocalAssetSourcesContext.Provider>
);

/** Reads the context and calls resolveVisualAssetSrc(category, value, sources, staticFile). */
export const useVisualAssetSrc = (
  category: LocalAssetCategory,
  value: Pose | Background,
): VisualAssetResolution =>
  resolveVisualAssetSrc(
    category,
    value,
    useContext(LocalAssetSourcesContext),
    staticFile,
  );
