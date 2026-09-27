export const MAX_CAPTION_LENGTH = 180;

const SUPPORTED_CAPTION_CHARACTER =
  /[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Mark}\p{Number}\p{Punctuation}\p{Separator}]/u;

const EXTRA_SUPPORTED_CHARACTERS = new Set([
  "\t",
  "\n",
  "\r",
  "+",
  "=",
  "<",
  ">",
  "~",
  "^",
  "|",
  "°",
  "$",
  "€",
  "£",
  "¥",
  "©",
  "®",
  "™",
]);

export const captionCodePointLength = (text: string): number =>
  Array.from(text).length;

export const hasOnlySupportedCaptionCharacters = (
  text: string,
): boolean =>
  Array.from(text).every(
    (character) =>
      SUPPORTED_CAPTION_CHARACTER.test(character) ||
      EXTRA_SUPPORTED_CHARACTERS.has(character),
  );
