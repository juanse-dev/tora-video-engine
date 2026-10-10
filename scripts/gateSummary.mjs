// GATE-001 G7(c): the first lines of a failing Playwright run, for the report.

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

/**
 * @param {string} output  Playwright's combined stdout and stderr
 * @param {number} [maxLines]
 * @returns {string}
 */
export const summarizePlaywrightOutput = (output, maxLines = 12) => {
  const lines = output
    .replace(ANSI, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");

  if (lines.length === 0) {
    return "(Playwright produced no output)";
  }

  // The list reporter prints failures as "  1) file:line › title".
  let start = lines.findIndex((line) => /^1\) /.test(line));

  if (start === -1) {
    start = lines.findIndex((line) => /error/i.test(line));
  }

  if (start === -1) {
    start = Math.max(0, lines.length - maxLines);
  }

  return lines.slice(start, start + maxLines).join("\n");
};
