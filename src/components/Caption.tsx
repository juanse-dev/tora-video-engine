import type {CSSProperties} from "react";
import {CAPTION_FONT_FAMILY} from "../fontCoverage.ts";
import {
  CAPTION_BOX_MAX_HEIGHT,
  getCaptionFontSize,
  layoutCaptionLines,
} from "../captionLayout.ts";
import type {
  CaptionPlacement,
  CaptionVariant,
} from "../scenePresets.ts";

type CaptionProps = {
  text: string;
  variant: CaptionVariant;
  placement: CaptionPlacement;
  align: "left" | "center";
};

const variantStyles: Record<CaptionVariant, CSSProperties> = {
  hero: {
    fontWeight: 800,
    letterSpacing: -2.5,
    lineHeight: 1.02,
    padding: "28px 34px",
  },
  dialogue: {
    fontWeight: 700,
    letterSpacing: -1.5,
    lineHeight: 1.12,
    padding: "24px 30px",
  },
  impact: {
    fontWeight: 900,
    letterSpacing: 1,
    lineHeight: 0.98,
    padding: "30px 34px",
  },
};

export const Caption = ({
  text,
  variant,
  placement,
  align,
}: CaptionProps) => {
  const fontSize = getCaptionFontSize(variant, text);
  const lines = layoutCaptionLines(text, variant, fontSize);

  return (
    <div
      style={{
        bottom: 96,
        display: "flex",
        flexDirection: "column",
        justifyContent:
          placement === "top" ? "flex-start" : "flex-end",
        left: 72,
        position: "absolute",
        right: 72,
        top: 96,
      }}
    >
      <div
        data-caption-align={align}
        data-caption-lines={lines.length}
        style={{
          ...variantStyles[variant],
          alignItems: align === "center" ? "center" : "flex-start",
          backgroundColor: "rgba(8, 12, 18, 0.72)",
          border: "2px solid rgba(255, 255, 255, 0.10)",
          borderRadius: 30,
          boxShadow: "0 18px 54px rgba(0, 0, 0, 0.28)",
          boxSizing: "border-box",
          color: "#f8fafc",
          display: "flex",
          flexDirection: "column",
          fontFamily: CAPTION_FONT_FAMILY,
          fontSize,
          maxHeight: CAPTION_BOX_MAX_HEIGHT,
          overflow: "hidden",
          textShadow: "0 4px 18px rgba(0, 0, 0, 0.45)",
          width: "100%",
        }}
      >
        {lines.map((line, index) => (
          <div data-caption-line={index} key={index}>
            {line}
          </div>
        ))}
      </div>
    </div>
  );
};
