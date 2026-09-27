export const CAPTION_FONT_FAMILY = "Inter Variable";

const REQUIRED_FONT_WEIGHTS = [700, 800, 900] as const;

export type FontLoader = (
  font: string,
  text: string,
) => Promise<readonly unknown[]>;

const uniqueRenderableCodePoints = (text: string): string[] =>
  [...new Set(Array.from(text).filter((character) => !/\s/u.test(character)))];

const formatCodePoint = (character: string): string =>
  `U+${character.codePointAt(0)?.toString(16).toUpperCase().padStart(4, "0")}`;

export const loadCaptionFontForText = async (
  captionText: string,
  loadFont: FontLoader,
): Promise<void> => {
  const characters = uniqueRenderableCodePoints(captionText);

  for (const weight of REQUIRED_FONT_WEIGHTS) {
    const font = `${weight} 16px "${CAPTION_FONT_FAMILY}"`;

    for (const character of characters) {
      const faces = await loadFont(font, character);

      if (faces.length === 0) {
        throw new Error(
          `Bundled caption font does not support ${formatCodePoint(character)} ("${character}") at weight ${weight}`,
        );
      }
    }
  }
};
