import type {CaptionVariant} from "./scenePresets.ts";

export const CAPTION_BOX_MAX_HEIGHT = 620;
export const CAPTION_TEXT_MAX_HEIGHT = 520;
export const CAPTION_MIN_FONT_SIZE = 32;
export const CAPTION_CONTENT_WIDTH = 868;
export const CAPTION_LINE_HEIGHT = 1.12;

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

const glyphAdvanceEm = (character: string): number => {
  if (/\s/u.test(character)) {
    return 0.33;
  }

  if (/[MW@%&]/u.test(character)) {
    return 0.95;
  }

  if (/[A-Z]/u.test(character)) {
    return 0.72;
  }

  if (/[mw]/u.test(character)) {
    return 0.82;
  }

  if (/[ilIjtfr1|]/u.test(character)) {
    return 0.36;
  }

  if (/[a-z0-9]/u.test(character)) {
    return 0.58;
  }

  if (/[.,:;!'"\-()\[\]{}]/u.test(character)) {
    return 0.38;
  }

  // Inter's supported non-ASCII ranges are conservatively treated as
  // full-em glyphs. This keeps explicit wrapping deterministic without
  // relying on browser CSS word-breaking behavior.
  return 1;
};

export const estimateCaptionLineWidth = (
  text: string,
  variant: CaptionVariant,
  fontSize: number,
): number => {
  const characters = Array.from(text);

  if (characters.length === 0) {
    return 0;
  }

  const glyphWidth = characters.reduce(
    (sum, character) => sum + glyphAdvanceEm(character) * fontSize,
    0,
  );

  return (
    glyphWidth +
    Math.max(0, characters.length - 1) * letterSpacing[variant]
  );
};

const splitOversizedToken = (
  token: string,
  variant: CaptionVariant,
  fontSize: number,
): string[] => {
  const parts: string[] = [];
  let current = "";

  for (const character of Array.from(token)) {
    const candidate = current + character;

    if (
      current.length > 0 &&
      estimateCaptionLineWidth(candidate, variant, fontSize) >
        CAPTION_CONTENT_WIDTH
    ) {
      parts.push(current);
      current = character;
      continue;
    }

    current = candidate;
  }

  if (current.length > 0) {
    parts.push(current);
  }

  return parts;
};

export const layoutCaptionLines = (
  text: string,
  variant: CaptionVariant,
  fontSize: number,
): string[] => {
  const words = text.trim().split(/\s+/u).filter(Boolean);

  if (words.length === 0) {
    return [""];
  }

  const lines: string[] = [];
  let current = "";

  const pushToken = (token: string) => {
    if (current.length === 0) {
      if (
        estimateCaptionLineWidth(token, variant, fontSize) <=
        CAPTION_CONTENT_WIDTH
      ) {
        current = token;
        return;
      }

      const chunks = splitOversizedToken(token, variant, fontSize);
      lines.push(...chunks.slice(0, -1));
      current = chunks.at(-1) ?? "";
      return;
    }

    const candidate = `${current} ${token}`;

    if (
      estimateCaptionLineWidth(candidate, variant, fontSize) <=
      CAPTION_CONTENT_WIDTH
    ) {
      current = candidate;
      return;
    }

    lines.push(current);
    current = "";

    if (
      estimateCaptionLineWidth(token, variant, fontSize) <=
      CAPTION_CONTENT_WIDTH
    ) {
      current = token;
      return;
    }

    const chunks = splitOversizedToken(token, variant, fontSize);
    lines.push(...chunks.slice(0, -1));
    current = chunks.at(-1) ?? "";
  };

  for (const word of words) {
    pushToken(word);
  }

  if (current.length > 0) {
    lines.push(current);
  }

  return lines.length > 0 ? lines : [""];
};

export const estimateCaptionLineCount = (
  text: string,
  variant: CaptionVariant,
  fontSize: number,
): number => layoutCaptionLines(text, variant, fontSize).length;

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
