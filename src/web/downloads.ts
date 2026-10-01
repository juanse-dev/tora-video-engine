const MAX_DOWNLOAD_BASENAME_BYTES = 96;
const FALLBACK_BASENAME = "tora-video";

const WINDOWS_RESERVED =
  /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\..*)?$/iu;

const trimUnsafeEdges = (value: string): string =>
  value.replace(/^[ .-]+|[ .-]+$/gu, "");

const RESERVED_FILENAME_CHARACTERS = new Set(
  Array.from('<>:"/\\\\|?*'),
);

const replaceControlAndReservedCharacters = (value: string): string =>
  Array.from(value, (codePoint) => {
    const value = codePoint.codePointAt(0) ?? 0;
    const control =
      value <= 0x1f || (value >= 0x7f && value <= 0x9f);

    return control || RESERVED_FILENAME_CHARACTERS.has(codePoint)
      ? "-"
      : codePoint;
  }).join("");

const utf8Length = (value: string): number =>
  new TextEncoder().encode(value).byteLength;

const truncateUtf8 = (value: string, maxBytes: number): string => {
  let output = "";
  let bytes = 0;

  for (const codePoint of value) {
    const nextBytes = utf8Length(codePoint);

    if (bytes + nextBytes > maxBytes) {
      break;
    }

    output += codePoint;
    bytes += nextBytes;
  }

  return output;
};

export const getDownloadBasename = (title: string): string => {
  let basename = title
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f-\u009f<>:"/\\|?*]/gu, "-")
    .replace(/\s+/gu, "-")
    .replace(/-+/gu, "-");

  basename = trimUnsafeEdges(basename);

  if (basename.length === 0) {
    return FALLBACK_BASENAME;
  }

  if (WINDOWS_RESERVED.test(basename)) {
    basename = `tora-${basename}`;
  }

  basename = truncateUtf8(basename, MAX_DOWNLOAD_BASENAME_BYTES);
  basename = trimUnsafeEdges(basename);

  return basename.length === 0 ? FALLBACK_BASENAME : basename;
};

export const getYamlDownloadFilename = (title: string): string =>
  `${getDownloadBasename(title)}.yaml`;

export const downloadText = (
  source: string,
  filename: string,
  documentRef: Document = document,
): void => {
  const blob = new Blob([source], {type: "text/plain;charset=utf-8"});
  const url = URL.createObjectURL(blob);
  const anchor = documentRef.createElement("a");

  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
};
