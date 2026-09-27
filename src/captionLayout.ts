import type {CaptionVariant} from "./scenePresets.ts";
import {captionCodePointLength} from "./story/constraints.ts";

export const CAPTION_BOX_MAX_HEIGHT = 620;
export const CAPTION_TEXT_MAX_HEIGHT = 520;
export const CAPTION_MIN_FONT_SIZE = 32;
export const CAPTION_CONTENT_WIDTH = 868;

const CAPTION_LINE_HEIGHT = 1.12;
const WORST_CASE_GLYPH_EM = 2;

const baseFontSizes: Record<CaptionVariant, number> = {
  hero: 86,
  dialogue: 60,
  impact: 92,
};

const letterSpacing: Record<CaptionVariant, number> = {
  hero: -2.5,
  dialogue: -1.5,
  impact: 1,
};

const estimateCharactersPerLine = (
  variant: CaptionVariant,
  fontSize: number,
): number => {
  const conservativeAdvance =
    fontSize * WORST_CASE_GLYPH_EM +
    Math.max(0, letterSpacing[variant]);

  return Math.max(
    1,
    Math.floor(CAPTION_CONTENT_WIDTH / conservativeAdvance),
  );
};

export const estimateCaptionLineCount = (
  text: string,
  variant: CaptionVariant,
  fontSize: number,
): number => {
  const capacity = estimateCharactersPerLine(variant, fontSize);
  const codePointCount = Math.max(1, captionCodePointLength(text));

  return Math.ceil(codePointCount / capacity);
};

export const estimateCaptionHeight = (
  text: string,
  variant: CaptionVariant,
  fontSize: number,
): number =>
  estimateCaptionLineCount(text, variant, fontSize) *
  fontSize *
  CAPTION_LINE_HEIGHT;

export const getCaptionFontSize = (
  variant: CaptionVariant,
  text: string,
): number => {
  const baseFontSize = baseFontSizes[variant];

  for (
    let fontSize = baseFontSize;
    fontSize >= CAPTION_MIN_FONT_SIZE;
    fontSize -= 1
  ) {
    if (
      estimateCaptionHeight(text, variant, fontSize) <=
      CAPTION_TEXT_MAX_HEIGHT
    ) {
      return fontSize;
    }
  }

  return CAPTION_MIN_FONT_SIZE;
};
