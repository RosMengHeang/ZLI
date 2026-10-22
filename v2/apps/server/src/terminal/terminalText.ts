// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal output is full of control sequences.
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/gu;
/** Cursor moves to another row; replaced with a line break so words on different rows stay apart. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal output is full of control sequences.
const ROW_MOVE = /\u001b\[[0-9;?]*[ABEFHf]/gu;
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal output is full of control sequences.
const CSI = /\u001b\[[0-?]*[ -/]*[@-~]/gu;
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal output is full of control sequences.
const OTHER_ESCAPE = /\u001b[@-Z\\-_]|\u001b[()][0-9A-Za-z]/gu;
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal output is full of control sequences.
const CONTROL = /[\u0000-\u0007\u000b\u000c\u000e-\u001f\u007f]/gu;

/**
 * Terminal output as plain text an agent can read: color and cursor codes removed, carriage-return
 * redraws collapsed to their final text, and runs of blank lines squeezed. Full-screen programs still
 * read roughly, because their layout depends on cursor positions this does not replay.
 */
export function readableTerminalText(raw: string, maxLines = 400): { text: string; cutLines: boolean } {
  const withoutCodes = raw
    .replace(OSC, "")
    .replace(ROW_MOVE, "\n")
    .replace(CSI, "")
    .replace(OTHER_ESCAPE, "")
    .replace(/\r\n/gu, "\n");
  const lines: string[] = [];
  for (const line of withoutCodes.split("\n")) {
    const redrawn = line
      .split("\r")
      .reduce((shown, part) => (part.length >= shown.length ? part : part + shown.slice(part.length)));
    let text = "";
    for (const char of redrawn) text = char === "\b" ? text.slice(0, -1) : text + char;
    lines.push(text.replace(CONTROL, "").trimEnd());
  }
  const squeezed: string[] = [];
  for (const line of lines) {
    if (line === "" && (squeezed.length === 0 || squeezed[squeezed.length - 1] === "")) continue;
    squeezed.push(line);
  }
  while (squeezed[squeezed.length - 1] === "") squeezed.pop();
  const cutLines = squeezed.length > maxLines;
  return { text: squeezed.slice(-maxLines).join("\n"), cutLines };
}
