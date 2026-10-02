import type {CaptionVariant} from "./scenePresets.ts";

export const CAPTION_BOX_MAX_HEIGHT = 620;
export const CAPTION_TEXT_MAX_HEIGHT = 520;
export const CAPTION_MIN_FONT_SIZE = 32;
export const CAPTION_CONTENT_WIDTH = 864;
export const CAPTION_LINE_HEIGHT = 1.12;
export const CAPTION_FRAME_WIDTH = 936;

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

const COMBINING_MARK = /^\p{Mark}$/u;
const ZERO_WIDTH_SPACE = "\u200B";
const WORD_JOINER = "\u2060";
const HARD_WRAP_NO_BREAK_CHARACTERS = new Set([
  "\u00A0", // NO-BREAK SPACE
  "\u2007", // FIGURE SPACE
  "\u202F", // NARROW NO-BREAK SPACE
  "\uFEFF", // ZERO WIDTH NO-BREAK SPACE
  WORD_JOINER,
]);

const isHardWrapNoBreakCharacter = (
  grapheme: string | undefined,
): boolean =>
  grapheme !== undefined &&
  HARD_WRAP_NO_BREAK_CHARACTERS.has(grapheme);

// Preserve every supported Unicode no-break whitespace character. JavaScript's
// \s includes all four, so each must be excluded explicitly from the
// collapsible set to avoid creating new line-break opportunities.
const COLLAPSIBLE_WHITESPACE = /[^\S\u00A0\u2007\u202F\uFEFF]+/u;
const LEADING_COLLAPSIBLE_WHITESPACE =
  /^[^\S\u00A0\u2007\u202F\uFEFF]+/u;
const TRAILING_COLLAPSIBLE_WHITESPACE =
  /[^\S\u00A0\u2007\u202F\uFEFF]+$/u;

// Inter Variable's accepted uppercase/non-ASCII glyphs at weights 700/800/900
// are conservatively bounded below 1.1em. Overestimating here is intentional:
// explicit wrapping must never depend on CSS overflow recovery.
const CONSERVATIVE_WIDE_ADVANCE_EM = 1.1;

const segmentSupportedGraphemes = (text: string): string[] => {
  const clusters: string[] = [];

  for (const character of Array.from(text)) {
    if (COMBINING_MARK.test(character) && clusters.length > 0) {
      clusters[clusters.length - 1] += character;
      continue;
    }

    clusters.push(character);
  }

  return clusters;
};

const glyphAdvanceEm = (grapheme: string): number => {
  const baseCharacter =
    Array.from(grapheme).find(
      (character) => !COMBINING_MARK.test(character),
    ) ?? grapheme;

  if (baseCharacter === "\u2007") {
    // FIGURE SPACE is digit-width in Inter. Bound it like the digit class so
    // retained no-break whitespace cannot make an explicit line clip.
    return CONSERVATIVE_WIDE_ADVANCE_EM;
  }

  if (
    baseCharacter === "\uFEFF" ||
    baseCharacter === WORD_JOINER ||
    baseCharacter === ZERO_WIDTH_SPACE
  ) {
    // ZWNBSP and WORD JOINER prohibit a break; ZERO WIDTH SPACE permits one.
    // All three are format controls with no glyph advance.
    return 0;
  }

  if (/\s/u.test(baseCharacter)) {
    // NBSP and NNBSP use the ordinary whitespace bound; FIGURE SPACE and
    // ZWNBSP are handled above because their advances are materially different.
    return 0.33;
  }

  if (/[A-Z0-9@%&]/u.test(baseCharacter)) {
    return CONSERVATIVE_WIDE_ADVANCE_EM;
  }

  if (/[mw]/u.test(baseCharacter)) {
    // Heavy Inter can render these close to a full em. Use the same
    // conservative bound as other wide glyphs to prevent native clipping.
    return CONSERVATIVE_WIDE_ADVANCE_EM;
  }

  if (/[ilIjtfr|]/u.test(baseCharacter)) {
    return 0.36;
  }

  if (/[a-z]/u.test(baseCharacter)) {
    // Inter's ordinary lowercase advances can exceed the previous 0.58em
    // estimate at the supported weights. Keep an explicit safety margin so
    // a deterministic line never falls back to native browser wrapping.
    return 0.62;
  }

  if (`.,:;!'"-()[]{}`.includes(baseCharacter)) {
    return 0.38;
  }

  // Accepted non-ASCII glyphs are intentionally treated as wide.
  return CONSERVATIVE_WIDE_ADVANCE_EM;
};

export const estimateCaptionLineWidth = (
  text: string,
  variant: CaptionVariant,
  fontSize: number,
): number => {
  const graphemes = segmentSupportedGraphemes(text);

  if (graphemes.length === 0) {
    return 0;
  }

  const glyphWidth = graphemes.reduce(
    (sum, grapheme) => sum + glyphAdvanceEm(grapheme) * fontSize,
    0,
  );

  return (
    glyphWidth +
    Math.max(0, graphemes.length - 1) * letterSpacing[variant]
  );
};

const segmentHardWrapUnits = (token: string): string[] => {
  const graphemes = segmentSupportedGraphemes(token);
  const units: string[] = [];
  let current = "";

  for (let index = 0; index < graphemes.length; index += 1) {
    const grapheme = graphemes[index];
    const next = graphemes[index + 1];

    current += grapheme;

    // Unicode no-break separators and WORD JOINER forbid a break on either
    // side. Keep both adjacent graphemes in one indivisible hard-wrap unit so
    // splitting an oversized token cannot reintroduce a forbidden boundary.
    if (
      isHardWrapNoBreakCharacter(grapheme) ||
      isHardWrapNoBreakCharacter(next)
    ) {
      continue;
    }

    units.push(current);
    current = "";
  }

  if (current.length > 0) {
    units.push(current);
  }

  return units;
};

const splitOversizedToken = (
  token: string,
  variant: CaptionVariant,
  fontSize: number,
): string[] => {
  const parts: string[] = [];
  let current = "";

  for (const unit of segmentHardWrapUnits(token)) {
    const candidate = current + unit;

    if (
      current.length > 0 &&
      estimateCaptionLineWidth(candidate, variant, fontSize) >
        CAPTION_CONTENT_WIDTH
    ) {
      parts.push(current);
      current = unit;
      continue;
    }

    current = candidate;
  }

  if (current.length > 0) {
    parts.push(current);
  }

  return parts;
};

type CaptionToken = {
  text: string;
  separatorBefore: "" | " ";
};

const tokenizeCaption = (text: string): CaptionToken[] => {
  const trimmed = text
    .replace(LEADING_COLLAPSIBLE_WHITESPACE, "")
    .replace(TRAILING_COLLAPSIBLE_WHITESPACE, "");
  const tokens: CaptionToken[] = [];
  let current = "";
  let separatorBefore: "" | " " = "";

  const pushCurrent = () => {
    if (current.length === 0) {
      return;
    }

    tokens.push({
      text: current,
      separatorBefore,
    });
    current = "";
    separatorBefore = "";
  };

  for (const grapheme of segmentSupportedGraphemes(trimmed)) {
    if (COLLAPSIBLE_WHITESPACE.test(grapheme)) {
      pushCurrent();
      separatorBefore = " ";
      continue;
    }

    current += grapheme;

    if (grapheme === ZERO_WIDTH_SPACE) {
      // Preserve U+200B in the text while exposing its Unicode break
      // opportunity to the deterministic layout.
      pushCurrent();
    }
  }

  pushCurrent();

  return tokens;
};

export const layoutCaptionLines = (
  text: string,
  variant: CaptionVariant,
  fontSize: number,
): string[] => {
  const tokens = tokenizeCaption(text);

  if (tokens.length === 0) {
    return [""];
  }

  const lines: string[] = [];
  let current = "";

  const pushToken = (token: CaptionToken) => {
    if (current.length === 0) {
      if (
        estimateCaptionLineWidth(token.text, variant, fontSize) <=
        CAPTION_CONTENT_WIDTH
      ) {
        current = token.text;
        return;
      }

      const chunks = splitOversizedToken(token.text, variant, fontSize);
      lines.push(...chunks.slice(0, -1));
      current = chunks.at(-1) ?? "";
      return;
    }

    const candidate =
      current + token.separatorBefore + token.text;

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
      estimateCaptionLineWidth(token.text, variant, fontSize) <=
      CAPTION_CONTENT_WIDTH
    ) {
      current = token.text;
      return;
    }

    const chunks = splitOversizedToken(token.text, variant, fontSize);
    lines.push(...chunks.slice(0, -1));
    current = chunks.at(-1) ?? "";
  };

  for (const token of tokens) {
    pushToken(token);
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
