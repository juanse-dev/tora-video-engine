export const CAPTION_FONT_FAMILY = "Inter Variable";

export const REQUIRED_FONT_WEIGHTS = [700, 800, 900] as const;

// Keep this in sync with @fontsource-variable/inter@5.3.0 unicode ranges
// loaded by wght.css: cyrillic-ext, cyrillic, greek-ext, greek,
// vietnamese, latin-ext, and latin.
const INTER_UNICODE_RANGES: readonly (readonly [number, number])[] = [
  [0x0460, 0x052f],
  [0x1c80, 0x1c8a],
  [0x20b4, 0x20b4],
  [0x2de0, 0x2dff],
  [0xa640, 0xa69f],
  [0xfe2e, 0xfe2f],
  [0x0301, 0x0301],
  [0x0400, 0x045f],
  [0x0490, 0x0491],
  [0x04b0, 0x04b1],
  [0x2116, 0x2116],
  [0x1f00, 0x1fff],
  [0x0370, 0x0377],
  [0x037a, 0x037f],
  [0x0384, 0x038a],
  [0x038c, 0x038c],
  [0x038e, 0x03a1],
  [0x03a3, 0x03ff],
  [0x0102, 0x0103],
  [0x0110, 0x0111],
  [0x0128, 0x0129],
  [0x0168, 0x0169],
  [0x01a0, 0x01a1],
  [0x01af, 0x01b0],
  [0x0300, 0x0301],
  [0x0303, 0x0304],
  [0x0308, 0x0309],
  [0x0323, 0x0323],
  [0x0329, 0x0329],
  [0x1ea0, 0x1ef9],
  [0x20ab, 0x20ab],
  [0x0100, 0x02ba],
  [0x02bd, 0x02c5],
  [0x02c7, 0x02cc],
  [0x02ce, 0x02d7],
  [0x02dd, 0x02ff],
  [0x0304, 0x0304],
  [0x0308, 0x0308],
  [0x0329, 0x0329],
  [0x1d00, 0x1dbf],
  [0x1e00, 0x1e9f],
  [0x1ef2, 0x1eff],
  [0x2020, 0x2020],
  [0x20a0, 0x20ab],
  [0x20ad, 0x20c0],
  [0x2113, 0x2113],
  [0x2c60, 0x2c7f],
  [0xa720, 0xa7ff],
  [0x0000, 0x00ff],
  [0x0131, 0x0131],
  [0x0152, 0x0153],
  [0x02bb, 0x02bc],
  [0x02c6, 0x02c6],
  [0x02da, 0x02da],
  [0x02dc, 0x02dc],
  [0x0304, 0x0304],
  [0x0308, 0x0308],
  [0x0329, 0x0329],
  [0x2000, 0x206f],
  [0x20ac, 0x20ac],
  [0x2122, 0x2122],
  [0x2191, 0x2191],
  [0x2193, 0x2193],
  [0x2212, 0x2212],
  [0x2215, 0x2215],
  [0xfeff, 0xfeff],
  [0xfffd, 0xfffd],
];

export type FontLoader = (
  font: string,
  text: string,
) => Promise<readonly unknown[]>;

const isSupportedCodePoint = (codePoint: number): boolean =>
  INTER_UNICODE_RANGES.some(
    ([start, end]) => codePoint >= start && codePoint <= end,
  );

export const isCaptionTextSupported = (text: string): boolean =>
  Array.from(text).every((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && isSupportedCodePoint(codePoint);
  });

const formatCodePoint = (character: string): string =>
  `U+${character.codePointAt(0)?.toString(16).toUpperCase().padStart(4, "0")}`;

export const loadCaptionFontForText = async (
  captionText: string,
  loadFont: FontLoader,
): Promise<void> => {
  const unsupportedCharacter = Array.from(captionText).find((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint === undefined || !isSupportedCodePoint(codePoint);
  });

  if (unsupportedCharacter) {
    throw new Error(
      `Bundled caption font does not support ${formatCodePoint(unsupportedCharacter)} ("${unsupportedCharacter}")`,
    );
  }

  const results = await Promise.all(
    REQUIRED_FONT_WEIGHTS.map(async (weight) => {
      const font = `${weight} 16px "${CAPTION_FONT_FAMILY}"`;
      const faces = await loadFont(font, captionText);

      return {
        weight,
        faces,
      };
    }),
  );

  const failedWeight = results.find(({faces}) => faces.length === 0);

  if (failedWeight) {
    throw new Error(
      `Bundled caption font failed to load caption text at weight ${failedWeight.weight}`,
    );
  }
};
