import { parseDevServerUrl } from "@zli-v2/contracts";

// CSI, OSC (including OSC 8 hyperlinks, whose visible text is kept), and two-byte escapes.
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal output is full of control sequences.
const ESCAPE_SEQUENCES = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/gu;
// biome-ignore lint/suspicious/noControlCharactersInRegex: see above.
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f]/gu;
/** Expo prints Metro's address as exp:// when it serves on localhost, and Metro answers plain http there too. */
const LOCAL_URL = /\b(?:https?|exp):\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):\d{1,5}(?:\/[^\s"'<>`)\]]*)?/giu;
/**
 * Words dev servers put on the line with their address. A command the person typed, such as
 * `curl http://localhost:3000`, has none of them, so its echo is not taken for a server.
 */
const SERVER_WORDS = /\b(?:local|loopback|listening|running|ready|serving|server|started|available|url|waiting on)\b/iu;
/**
 * Error and request logs often name a local address next to a server word ("proxy error ... url",
 * "GET http://localhost:3000/api 500"), but they describe a call to a server, not one starting.
 */
const LOG_WORDS =
  /\b(?:errors?|err|exceptions?|fail(?:s|ed|ure)?|refused|unable|cannot|could not|warn(?:ing)?|timed? ?out|request(?:ed|ing)?|fetch(?:ed|ing)?|proxy(?:ing)?|E(?:CONN[A-Z]+|TIMEDOUT|ADDRINUSE|HOSTUNREACH|NOTFOUND))\b/iu;
const HTTP_METHODS = /\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/u;
const MAX_LINE = 1_000;
const MAX_PARTIAL = 4_096;

export function stripTerminalEscapes(text: string): string {
  return text.replace(ESCAPE_SEQUENCES, "").replace(CONTROL_CHARACTERS, "");
}

/** Local server addresses announced on one line of terminal output, ready to open. */
export function detectDevServerUrls(rawLine: string): string[] {
  if (rawLine.length > MAX_LINE * 4 || !rawLine.includes("://")) return [];
  const line = stripTerminalEscapes(rawLine);
  if (line.length > MAX_LINE) return [];
  const matches = line.match(LOCAL_URL);
  if (!matches) return [];
  const words = line.replace(LOCAL_URL, " ");
  if (!SERVER_WORDS.test(words) || LOG_WORDS.test(words) || HTTP_METHODS.test(words)) return [];
  const urls: string[] = [];
  for (const match of matches) {
    const parsed = parseDevServerUrl(match.replace(/[.,;:!]+$/u, "").replace(/^exp:/iu, "http:"));
    if (parsed && !urls.includes(parsed.url)) urls.push(parsed.url);
  }
  return urls;
}

/** Splits each terminal's output into lines, holding the unfinished tail until the next chunk. */
export class DevServerLineScanner {
  private readonly partial = new Map<string, string>();

  push(key: string, data: string): string[] {
    const parts = `${this.partial.get(key) ?? ""}${data}`.split(/\r\n|\n|\r/u);
    const rest = parts.pop() ?? "";
    // Output with no line breaks (progress bars, binary dumps) cannot be a server banner.
    this.partial.set(key, rest.length > MAX_PARTIAL ? "" : rest);
    const urls: string[] = [];
    for (const line of parts) {
      for (const url of detectDevServerUrls(line)) if (!urls.includes(url)) urls.push(url);
    }
    return urls;
  }

  forget(key: string): void {
    this.partial.delete(key);
  }
}
