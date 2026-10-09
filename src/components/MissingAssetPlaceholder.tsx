import type {LocalAssetCategory, LocalAssetRef} from "../localAssets/refs.ts";
import {shortAssetId} from "../localAssets/sources.ts";

type MissingAssetPlaceholderProps = {
  category: LocalAssetCategory;
  assetRef: LocalAssetRef;
  variant: "missing" | "pending";
};

export const MissingAssetPlaceholder = ({
  category,
  assetRef,
  variant,
}: MissingAssetPlaceholderProps) => {
  const title =
    variant === "pending"
      ? `Loading local ${category}…`
      : `Missing local ${category}`;
  const shortId = shortAssetId(assetRef);
  const marker =
    variant === "pending"
      ? {"data-pending-local-asset": assetRef}
      : {"data-missing-local-asset": assetRef};
  const isPose = category === "pose";

  const text = (
    <div
      {...marker}
      aria-label={`${title} ${shortId}`}
      role="img"
      style={{
        alignItems: "center",
        backgroundColor: isPose ? "#2b3140" : "#1f2430",
        color: "#f8fafc",
        display: "flex",
        flexDirection: "column",
        fontFamily: "Inter, sans-serif",
        fontSize: isPose ? 28 : 48,
        height: isPose ? "60%" : "100%",
        justifyContent: "center",
        width: isPose ? "60%" : "100%",
      }}
    >
      <div>{title}</div>
      <div>{shortId}</div>
    </div>
  );

  if (!isPose) {
    return text;
  }

  return (
    <div
      style={{
        alignItems: "center",
        display: "flex",
        height: "100%",
        justifyContent: "center",
        width: "100%",
      }}
    >
      {text}
    </div>
  );
};
