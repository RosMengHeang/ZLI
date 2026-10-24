import type { SendAttachment } from "../review/SendToAgentDialog.js";

/** One element picked in the browser panel, as design mode read it from the page. */
export type DesignPick = {
  id: string;
  selector: string;
  tag: string;
  name: string;
  url?: string | undefined;
  html?: string | undefined;
  htmlTruncated?: boolean | undefined;
  styles: Record<string, string>;
  bounds?: { x: number; y: number; width: number; height: number } | undefined;
  screenshot?: { data: string; mimeType: "image/png" | "image/jpeg" } | undefined;
};

/** Chat messages take up to 8 attachments, one screenshot per element. */
export const MAX_DESIGN_PICKS = 8;
const MAX_NAME_CHARS = 60;

/** The selector design mode reported for a click, or undefined when the pick was cancelled. */
export function pickedSelector(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.selector !== "string") return undefined;
  const selector = value.selector.trim();
  return selector ? selector : undefined;
}

/** Reads what the desktop app returned for a picked element; undefined when it is not usable. */
export function parseDesignInspection(value: unknown, selector: string, id: string): DesignPick | undefined {
  if (!isRecord(value) || typeof value.tag !== "string" || !value.tag) return undefined;
  const styles: Record<string, string> = {};
  if (isRecord(value.styles)) {
    for (const [key, style] of Object.entries(value.styles))
      if (typeof style === "string" && style) styles[key] = style;
  }
  const bounds = isRecord(value.bounds) ? value.bounds : undefined;
  const screenshot = isRecord(value.screenshot) ? value.screenshot : undefined;
  return {
    id,
    selector,
    tag: value.tag,
    name: typeof value.name === "string" ? value.name.replace(/\s+/gu, " ").trim() : "",
    ...(typeof value.url === "string" && value.url ? { url: value.url } : {}),
    ...(typeof value.html === "string" && value.html ? { html: value.html } : {}),
    ...(value.htmlTruncated === true ? { htmlTruncated: true } : {}),
    styles,
    ...(bounds &&
    typeof bounds.x === "number" &&
    typeof bounds.y === "number" &&
    typeof bounds.width === "number" &&
    typeof bounds.height === "number"
      ? { bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } }
      : {}),
    ...(screenshot &&
    typeof screenshot.data === "string" &&
    screenshot.data &&
    (screenshot.mimeType === "image/png" || screenshot.mimeType === "image/jpeg")
      ? { screenshot: { data: screenshot.data, mimeType: screenshot.mimeType } }
      : {}),
  };
}

/** `<button> "Save"`, with long text cut short. */
export function designSummary(pick: Pick<DesignPick, "tag" | "name">): string {
  const name = pick.name.length > MAX_NAME_CHARS ? `${pick.name.slice(0, MAX_NAME_CHARS - 1)}…` : pick.name;
  return name ? `<${pick.tag}> "${name}"` : `<${pick.tag}>`;
}

export function designSize(pick: Pick<DesignPick, "bounds">): string | undefined {
  return pick.bounds ? `${Math.round(pick.bounds.width)} × ${Math.round(pick.bounds.height)}` : undefined;
}

export function screenshotName(pick: Pick<DesignPick, "screenshot">, index: number): string {
  return `element-${index + 1}.${pick.screenshot?.mimeType === "image/jpeg" ? "jpg" : "png"}`;
}

/** Each element's screenshot, named the way the message refers to it. */
export function designAttachments(picks: readonly DesignPick[]): SendAttachment[] {
  return picks
    .slice(0, MAX_DESIGN_PICKS)
    .flatMap((pick, index) =>
      pick.screenshot
        ? [{ name: screenshotName(pick, index), mimeType: pick.screenshot.mimeType, dataBase64: pick.screenshot.data }]
        : [],
    );
}

/**
 * The message an agent receives: the request first, then for each element where it is, how it
 * looks now, and its markup. Screenshots go along as attachments.
 */
export function formatDesignMessage(picks: readonly DesignPick[], note: string, branch?: string): string {
  const shown = picks.slice(0, MAX_DESIGN_PICKS);
  const urls = [...new Set(shown.flatMap((pick) => (pick.url ? [pick.url] : [])))];
  const onePage = urls.length === 1 ? urls[0] : undefined;
  const subject = shown.length === 1 ? "this element" : `these ${shown.length} elements`;
  const where = [onePage ? `on ${onePage}` : "", branch ? `(worktree ${branch})` : ""].filter(Boolean).join(" ");
  const intro = `Please change ${subject} in the page${where ? ` ${where}` : ""}, which I picked in the ZLI browser panel.`;
  const request = note.trim();
  const sections = shown.map((pick, index) => {
    const lines = [`### Element ${index + 1}: ${designSummary(pick)}`, `Selector: \`${pick.selector}\``];
    if (pick.url && !onePage) lines.push(`Page: ${pick.url}`);
    const size = designSize(pick);
    if (size) lines.push(`Size: ${size} px`);
    if (pick.screenshot) lines.push(`Screenshot: ${screenshotName(pick, index)} (attached)`);
    const styles = Object.entries(pick.styles).map(([key, value]) => `${kebab(key)}: ${value}`);
    if (styles.length > 0) lines.push(`Computed styles: ${styles.join("; ")}`);
    if (pick.html) {
      const fence = fenceFor(pick.html);
      lines.push(
        `HTML${pick.htmlTruncated ? " (cut short)" : ""}:`,
        `${fence}html`,
        pick.htmlTruncated ? `${pick.html}…` : pick.html,
        fence,
      );
    }
    return lines.join("\n");
  });
  return [intro, request ? `What should change:\n${request}` : "", ...sections].filter(Boolean).join("\n\n");
}

function kebab(key: string): string {
  return key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);
}

/** A fence longer than any run of backticks in the text, so the text cannot close it early. */
function fenceFor(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/gu)].map((match) => match[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
