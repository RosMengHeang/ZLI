import type { SendAttachment } from "../review/SendToAgentDialog.js";

export type DesignRect = { x: number; y: number; width: number; height: number };
export type DesignStroke = { tool: "pen" | "rect" | "ellipse"; points: number[] };
export type DesignImage = { data: string; mimeType: "image/png" | "image/jpeg" };
/** The element's text, when it holds only text, and current values of the styles the editor offers. */
export type DesignEditable = { text: string | null; styles: Record<string, string> };
export type DesignCssEdit = { property: string; from: string; to: string };
/** Changes previewed on the live page, which the agent should make in the source. */
export type DesignEdits = { text?: { from: string; to: string } | undefined; css: DesignCssEdit[] };

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
  bounds?: DesignRect | undefined;
  screenshot?: DesignImage | undefined;
  editable?: DesignEditable | undefined;
};

export type DesignElementAnnotation = DesignPick & {
  kind: "element";
  instruction: string;
  edits?: DesignEdits | undefined;
};

/** A rectangle drawn on the page, with an optional sketch, in page coordinates. */
export type DesignRegionAnnotation = {
  kind: "region";
  id: string;
  /** The page's own id for the region, which its overlay uses. */
  regionId: string;
  url?: string | undefined;
  bounds: DesignRect;
  viewport?: { width: number; height: number } | undefined;
  strokes: DesignStroke[];
  screenshot?: DesignImage | undefined;
  instruction: string;
};

export type DesignAnnotation = DesignElementAnnotation | DesignRegionAnnotation;

export type DesignPickResult =
  | { kind: "element"; selector: string }
  | {
      kind: "region";
      regionId: string;
      bounds: DesignRect;
      viewport?: { width: number; height: number } | undefined;
      strokes: DesignStroke[];
    };

export type DesignMark =
  | { kind: "element"; id: string; n: number; selector: string }
  | { kind: "region"; id: string; n: number; bounds: DesignRect; strokes: DesignStroke[] };

/** Chat messages take up to 8 attachments, one image per annotation. */
export const MAX_DESIGN_ANNOTATIONS = 8;
/** Style properties the editor previews on the page, in the CSS spelling the message uses. */
export const DESIGN_EDITABLE_STYLES = ["background-color", "color", "padding", "font-size", "border-radius"] as const;
const MAX_NAME_CHARS = 60;
const STROKE_TOOLS: readonly string[] = ["pen", "rect", "ellipse"];

/** What the person did in the page while annotating, or undefined when the session ended. */
export function parseDesignPickResult(value: unknown): DesignPickResult | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === "region") {
    const bounds = parseRect(value.bounds);
    if (typeof value.id !== "string" || !value.id || !bounds) return undefined;
    const viewport = isRecord(value.viewport) ? value.viewport : undefined;
    return {
      kind: "region",
      regionId: value.id,
      bounds,
      ...(viewport && finite(viewport.width) && finite(viewport.height) && viewport.width > 0 && viewport.height > 0
        ? { viewport: { width: Math.round(viewport.width), height: Math.round(viewport.height) } }
        : {}),
      strokes: parseStrokes(value.strokes),
    };
  }
  if (typeof value.selector !== "string") return undefined;
  const selector = value.selector.trim();
  return selector ? { kind: "element", selector } : undefined;
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
  const screenshot = parseDesignImage(value.screenshot);
  const editable = parseEditable(value.editable);
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
    ...(screenshot ? { screenshot } : {}),
    ...(editable ? { editable } : {}),
  };
}

export function parseDesignImage(value: unknown): DesignImage | undefined {
  if (!isRecord(value) || typeof value.data !== "string" || !value.data) return undefined;
  return value.mimeType === "image/png" || value.mimeType === "image/jpeg"
    ? { data: value.data, mimeType: value.mimeType }
    : undefined;
}

/** `<button> "Save"`, with long text cut short; a drawn region is just "Region". */
export function designSummary(annotation: Pick<DesignPick, "tag" | "name"> | DesignRegionAnnotation): string {
  if (!("tag" in annotation)) return "Region";
  const name =
    annotation.name.length > MAX_NAME_CHARS ? `${annotation.name.slice(0, MAX_NAME_CHARS - 1)}…` : annotation.name;
  return name ? `<${annotation.tag}> "${name}"` : `<${annotation.tag}>`;
}

export function designSize(annotation: { bounds?: DesignRect | undefined }): string | undefined {
  return annotation.bounds
    ? `${Math.round(annotation.bounds.width)} × ${Math.round(annotation.bounds.height)}`
    : undefined;
}

/** `element-1.png` or `region-2.png`, numbered by the annotation's place in the list. */
export function screenshotName(
  annotation: { kind?: DesignAnnotation["kind"]; screenshot?: DesignImage | undefined },
  index: number,
): string {
  const extension = annotation.screenshot?.mimeType === "image/jpeg" ? "jpg" : "png";
  return `${annotation.kind === "region" ? "region" : "element"}-${index + 1}.${extension}`;
}

/** Each annotation's image, named the way the message refers to it. */
export function designAttachments(annotations: readonly DesignAnnotation[]): SendAttachment[] {
  return annotations.slice(0, MAX_DESIGN_ANNOTATIONS).flatMap((annotation, index) =>
    annotation.screenshot
      ? [
          {
            name: screenshotName(annotation, index),
            mimeType: annotation.screenshot.mimeType,
            dataBase64: annotation.screenshot.data,
          },
        ]
      : [],
  );
}

export function designEditCount(edits: DesignEdits | undefined): number {
  return edits ? edits.css.length + (edits.text ? 1 : 0) : 0;
}

/** "2 CSS edits · text", or undefined when nothing was edited. */
export function designEditSummary(edits: DesignEdits | undefined): string | undefined {
  if (!edits || designEditCount(edits) === 0) return undefined;
  const parts = [
    edits.css.length > 0 ? `${edits.css.length} CSS edit${edits.css.length === 1 ? "" : "s"}` : "",
    edits.text ? "text" : "",
  ];
  return parts.filter(Boolean).join(" · ");
}

/** The values the editor changed from what the page had, or undefined when nothing changed. */
export function diffDesignEdits(
  editable: DesignEditable,
  next: { text?: string | undefined; styles: Record<string, string> },
): DesignEdits | undefined {
  const css: DesignCssEdit[] = [];
  for (const property of DESIGN_EDITABLE_STYLES) {
    const to = next.styles[property]?.trim() ?? "";
    const from = editable.styles[property] ?? "";
    if (to && to !== from) css.push({ property, from, to });
  }
  const text =
    editable.text !== null && next.text !== undefined && next.text !== editable.text
      ? { from: editable.text, to: next.text }
      : undefined;
  return css.length > 0 || text ? { css, ...(text ? { text } : {}) } : undefined;
}

/** The page preview that shows these edits, or null to put the element back. */
export function designEditsPreview(
  edits: DesignEdits | undefined,
): { text?: string; styles: Record<string, string> } | null {
  if (!edits || designEditCount(edits) === 0) return null;
  return {
    ...(edits.text ? { text: edits.text.to } : {}),
    styles: Object.fromEntries(edits.css.map((edit) => [edit.property, edit.to])),
  };
}

/** An annotation can go to the agent once it says what should change, in words or as edits. */
export function designAnnotationReady(annotation: DesignAnnotation): boolean {
  return (
    annotation.instruction.trim().length > 0 || (annotation.kind === "element" && designEditCount(annotation.edits) > 0)
  );
}

/** Numbered markers for the annotations made on the page the tab shows now. */
export function designMarks(annotations: readonly DesignAnnotation[], url: string | undefined): DesignMark[] {
  return annotations.slice(0, MAX_DESIGN_ANNOTATIONS).flatMap((annotation, index): DesignMark[] => {
    if (annotation.url && url && annotation.url !== url) return [];
    return annotation.kind === "region"
      ? [
          {
            kind: "region",
            id: annotation.regionId,
            n: index + 1,
            bounds: annotation.bounds,
            strokes: annotation.strokes,
          },
        ]
      : [{ kind: "element", id: annotation.id, n: index + 1, selector: annotation.selector }];
  });
}

/**
 * The message an agent receives: one section per annotation saying where it is, what should
 * change, and how it looks now. Screenshots and sketches go along as attachments.
 */
export function formatDesignMessage(annotations: readonly DesignAnnotation[], branch?: string): string {
  const shown = annotations.slice(0, MAX_DESIGN_ANNOTATIONS);
  const urls = [...new Set(shown.flatMap((annotation) => (annotation.url ? [annotation.url] : [])))];
  const onePage = urls.length === 1 ? urls[0] : undefined;
  const subject = shown.length === 1 ? "this design annotation" : `these ${shown.length} design annotations`;
  const where = [onePage ? `on ${onePage}` : "", branch ? `(worktree ${branch})` : ""].filter(Boolean).join(" ");
  const intro = `Please apply ${subject} I made in the ZLI browser panel${where ? ` ${where}` : ""}.`;
  const edited = shown.some((annotation) => annotation.kind === "element" && designEditCount(annotation.edits) > 0);
  const editNote = edited
    ? "Text and CSS changes marked with → were only previewed on the live page. Make them in the source code."
    : "";
  const sections = shown.map((annotation, index) => {
    const lines = [`### Annotation ${index + 1}: ${designSummary(annotation)}`];
    if (annotation.kind === "element") lines.push(`Selector: \`${annotation.selector}\``);
    if (annotation.url && !onePage) lines.push(`Page: ${annotation.url}`);
    if (annotation.kind === "region") {
      const { x, y, width, height } = annotation.bounds;
      const viewport = annotation.viewport
        ? ` (viewport ${annotation.viewport.width} × ${annotation.viewport.height})`
        : "";
      lines.push(`Bounds: x ${x}, y ${y}, ${width} × ${height} px in page coordinates${viewport}`);
    }
    const instruction = annotation.instruction.trim();
    if (instruction) lines.push(`Instruction: ${instruction}`);
    if (annotation.kind === "region") {
      if (annotation.screenshot)
        lines.push(
          annotation.strokes.length > 0
            ? `Sketch: ${screenshotName(annotation, index)} (attached; the red marks are my drawing)`
            : `Screenshot: ${screenshotName(annotation, index)} (attached)`,
        );
      return lines.join("\n");
    }
    if (annotation.edits?.text)
      lines.push(`Text: ${quoted(annotation.edits.text.from)} → ${quoted(annotation.edits.text.to)}`);
    if (annotation.edits && annotation.edits.css.length > 0)
      lines.push(
        `CSS: ${annotation.edits.css.map((edit) => `${edit.property}: ${edit.from || "unset"} → ${edit.to}`).join("; ")}`,
      );
    const size = designSize(annotation);
    if (size) lines.push(`Size: ${size} px`);
    if (annotation.screenshot) lines.push(`Screenshot: ${screenshotName(annotation, index)} (attached)`);
    const styles = Object.entries(annotation.styles).map(([key, value]) => `${kebab(key)}: ${value}`);
    if (styles.length > 0) lines.push(`Computed styles: ${styles.join("; ")}`);
    if (annotation.html) {
      const fence = fenceFor(annotation.html);
      lines.push(
        `HTML${annotation.htmlTruncated ? " (cut short)" : ""}:`,
        `${fence}html`,
        annotation.htmlTruncated ? `${annotation.html}…` : annotation.html,
        fence,
      );
    }
    return lines.join("\n");
  });
  return [intro, editNote, ...sections].filter(Boolean).join("\n\n");
}

function quoted(text: string): string {
  return JSON.stringify(text);
}

function kebab(key: string): string {
  return key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);
}

/** A fence longer than any run of backticks in the text, so the text cannot close it early. */
function fenceFor(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/gu)].map((match) => match[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

function parseEditable(value: unknown): DesignEditable | undefined {
  if (!isRecord(value) || !isRecord(value.styles)) return undefined;
  const styles: Record<string, string> = {};
  for (const property of DESIGN_EDITABLE_STYLES) {
    const style = value.styles[property];
    if (typeof style === "string") styles[property] = style;
  }
  return { text: typeof value.text === "string" ? value.text : null, styles };
}

function parseRect(value: unknown): DesignRect | undefined {
  if (!isRecord(value)) return undefined;
  const { x, y, width, height } = value;
  if (!finite(x) || !finite(y) || !finite(width) || !finite(height) || width <= 0 || height <= 0) return undefined;
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

function parseStrokes(value: unknown): DesignStroke[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((stroke): DesignStroke[] => {
    if (!isRecord(stroke) || typeof stroke.tool !== "string" || !STROKE_TOOLS.includes(stroke.tool)) return [];
    if (!Array.isArray(stroke.points) || !stroke.points.every(finite)) return [];
    return [{ tool: stroke.tool as DesignStroke["tool"], points: stroke.points as number[] }];
  });
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
