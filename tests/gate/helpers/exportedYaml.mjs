// ASSET-006 Part B step 7: an exported Story carries local refs and nothing
// that identifies bytes or the machine: no blob:, data: or file: URLs, no
// base64 runs, no paths. Returns the problems found (empty = clean).

// Not preceded by a letter or digit, so "metadata:" and "https:" do not match
// "data:" / "file:", and "https://" does not look like a drive path ("s:/").
const NOT_AFTER_WORD = "(?<![A-Za-z0-9])";

const FORBIDDEN = [
  ["a blob: URL", /blob:/iu],
  ["a data: URL", new RegExp(`${NOT_AFTER_WORD}data:`, "iu")],
  ["a file: URL", new RegExp(`${NOT_AFTER_WORD}file:`, "iu")],
  ["a backslash path", /\\/u],
  [
    "a Windows drive path",
    new RegExp(`${NOT_AFTER_WORD}[A-Za-z]:[\\\\/]`, "u"),
  ],
  [
    "a Unix home or temp path",
    /(?:^|[\s"'(])\/(?:Users|home|tmp|var|private)\//u,
  ],
  ["a base64 run", /[A-Za-z0-9+/=]{100,}/u],
];

/**
 * @param {string} text  exported Story YAML
 * @param {string[]} [names]  strings that must not appear (fixture file names)
 * @returns {string[]}
 */
export const forbiddenInExportedYaml = (text, names = []) => [
  ...FORBIDDEN.filter(([, pattern]) => pattern.test(text)).map(
    ([label]) => label,
  ),
  ...names.filter((name) => text.includes(name)).map((name) => `"${name}"`),
];
