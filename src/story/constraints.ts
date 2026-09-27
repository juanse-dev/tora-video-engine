export const MAX_CAPTION_LENGTH = 180;

export const captionCodePointLength = (text: string): number =>
  Array.from(text).length;
