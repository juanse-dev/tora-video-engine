import type {CaptionVariant} from "./scenePresets.ts";

export const CAPTION_BOX_MAX_HEIGHT = 620;
export const CAPTION_TEXT_MAX_HEIGHT = 520;
export const CAPTION_MIN_FONT_SIZE = 32;
export const CAPTION_CONTENT_WIDTH = 868;

const CAPTION_LINE_HEIGHT = 1.12;

const baseFontSizes: Record<CaptionVariant, number> = {
  hero: 86,
  dialogue: 60,
  impact: 92,
};

export const estimateCaptionHeight = (
  textLength: number,
  fontSize: number,
): number => {
  const charactersPerLine = Math.max(
    1,
    Math.floor(CAPTION_CONTENT_WIDTH / fontSize),
  );
  const lineCount = Math.ceil(
    Math.max(1, textLength) / charactersPerLine,
  );

  return lineCount * fontSize * CAPTION_LINE_HEIGHT;
};

export const getCaptionFontSize = (
  variant: CaptionVariant,
  textLength: number,
): number => {
  const baseFontSize = baseFontSizes[variant];

  for (
    let fontSize = baseFontSize;
    fontSize >= CAPTION_MIN_FONT_SIZE;
    fontSize -= 1
  ) {
    if (
      estimateCaptionHeight(textLength, fontSize) <=
      CAPTION_TEXT_MAX_HEIGHT
    ) {
      return fontSize;
    }
  }

  return CAPTION_MIN_FONT_SIZE;
};
