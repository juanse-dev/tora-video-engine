const MAX_DOWNLOAD_BASENAME_BYTES = 96;
const FALLBACK_BASENAME = "tora-video";
const OBJECT_URL_REVOKE_GRACE_MS = 60_000;

type ScheduleObjectUrlRevocation = (callback: () => void) => void;

const scheduleObjectUrlRevocation: ScheduleObjectUrlRevocation = (
  callback,
) => {
  globalThis.setTimeout(callback, OBJECT_URL_REVOKE_GRACE_MS);
};

const WINDOWS_RESERVED =
  /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\..*)?$/iu;

const trimUnsafeEdges = (value: string): string =>
  value.replace(/^[ .-]+|[ .-]+$/gu, "");

const RESERVED_FILENAME_CHARACTERS = new Set(
  Array.from('<>:"/\\|?*'),
);

const replaceControlAndReservedCharacters = (value: string): string =>
  Array.from(value, (codePoint) => {
    const scalar = codePoint.codePointAt(0) ?? 0;
    const isControl =
      scalar <= 0x1f || (scalar >= 0x7f && scalar <= 0x9f);

    return isControl || RESERVED_FILENAME_CHARACTERS.has(codePoint)
      ? "-"
      : codePoint;
  }).join("");

const utf8Length = (value: string): number =>
  new TextEncoder().encode(value).byteLength;

const protectWindowsReservedName = (value: string): string =>
  WINDOWS_RESERVED.test(value) ? `tora-${value}` : value;

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
  let basename = replaceControlAndReservedCharacters(
    title.normalize("NFC"),
  )
    .replace(/\s+/gu, "-")
    .replace(/-+/gu, "-");

  basename = trimUnsafeEdges(basename);

  if (basename.length === 0) {
    return FALLBACK_BASENAME;
  }

  basename = protectWindowsReservedName(basename);
  basename = truncateUtf8(basename, MAX_DOWNLOAD_BASENAME_BYTES);
  basename = trimUnsafeEdges(basename);

  if (basename.length === 0) {
    return FALLBACK_BASENAME;
  }

  return protectWindowsReservedName(basename);
};

export const getYamlDownloadFilename = (title: string): string =>
  `${getDownloadBasename(title)}.yaml`;

export const getMp4DownloadFilename = (title: string): string =>
  `${getDownloadBasename(title)}.mp4`;

export const downloadBlob = (
  blob: Blob,
  filename: string,
  documentRef: Document = document,
  urlRef: Pick<typeof URL, "createObjectURL" | "revokeObjectURL"> = URL,
  scheduleRevoke: ScheduleObjectUrlRevocation =
    scheduleObjectUrlRevocation,
): void => {
  const url = urlRef.createObjectURL(blob);
  const anchor = documentRef.createElement("a");

  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  scheduleRevoke(() => {
    urlRef.revokeObjectURL(url);
  });
};

export const downloadText = (
  source: string,
  filename: string,
  documentRef: Document = document,
): void => {
  const blob = new Blob([source], {type: "text/plain;charset=utf-8"});
  downloadBlob(blob, filename, documentRef);
};
