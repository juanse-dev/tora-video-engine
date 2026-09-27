import type {CSSProperties} from "react";
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
    fontSize: 86,
    fontWeight: 800,
    letterSpacing: -2.5,
    lineHeight: 1.02,
    padding: "28px 34px",
  },
  dialogue: {
    fontSize: 60,
    fontWeight: 700,
    letterSpacing: -1.5,
    lineHeight: 1.12,
    padding: "24px 30px",
  },
  impact: {
    fontSize: 92,
    fontWeight: 900,
    letterSpacing: 1,
    lineHeight: 0.98,
    padding: "30px 34px",
    textTransform: "uppercase",
  },
};

export const Caption = ({
  text,
  variant,
  placement,
  align,
}: CaptionProps) => {
  const verticalStyle =
    placement === "top" ? {top: 118} : {bottom: 112};

  return (
    <div
      style={{
        ...variantStyles[variant],
        ...verticalStyle,
        background: "rgba(8, 12, 18, 0.72)",
        border: "2px solid rgba(255, 255, 255, 0.10)",
        borderRadius: 30,
        boxShadow: "0 18px 54px rgba(0, 0, 0, 0.28)",
        color: "#f8fafc",
        fontFamily: "Arial, Helvetica, sans-serif",
        left: 72,
        maxWidth: 936,
        overflowWrap: "anywhere",
        position: "absolute",
        right: 72,
        textAlign: align,
        textShadow: "0 4px 18px rgba(0, 0, 0, 0.45)",
      }}
    >
      {text}
    </div>
  );
};
