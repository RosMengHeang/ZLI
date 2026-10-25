import type { MobileUiNode } from "@zli-v2/contracts";

import { decodeXml } from "./AndroidRepository.js";

type RawNode = { attributes: Record<string, string>; depth: number };

function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of source.matchAll(/([\w:-]+)="([^"]*)"/gu)) {
    if (match[1]) attributes[match[1]] = decodeXml(match[2] ?? "");
  }
  return attributes;
}

/** Each <node> in document order with its nesting depth. */
function walkNodes(xml: string): RawNode[] {
  const nodes: RawNode[] = [];
  let depth = 0;
  for (const match of xml.matchAll(/<(\/?)node\b([^>]*?)(\/?)>/gu)) {
    const closing = match[1] === "/";
    const selfClosing = match[3] === "/";
    if (closing) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    nodes.push({ attributes: parseAttributes(match[2] ?? ""), depth });
    if (!selfClosing) depth += 1;
  }
  return nodes;
}

export function parseBounds(value: string | undefined): MobileUiNode["bounds"] | undefined {
  const match = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/u.exec(value ?? "");
  if (!match) return undefined;
  const [left, top, right, bottom] = match.slice(1).map(Number) as [number, number, number, number];
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

export type UiTree = { readonly nodes: MobileUiNode[]; readonly depths: number[] };

/**
 * Turns a uiautomator dump into the elements worth acting on: anything with text, a description, an id,
 * or an action. Layout-only containers are dropped so the agent reads a short list, and each element
 * gets a ref (e1, e2, ...) that mobile_tap resolves to the element's center.
 */
export function parseUiAutomatorDump(xml: string): UiTree {
  const nodes: MobileUiNode[] = [];
  const depths: number[] = [];
  for (const raw of walkNodes(xml)) {
    const a = raw.attributes;
    const bounds = parseBounds(a.bounds);
    if (!bounds || bounds.width === 0 || bounds.height === 0) continue;
    const text = a.text?.trim();
    const label = a["content-desc"]?.trim();
    const id = a["resource-id"]?.trim();
    const clickable = a.clickable === "true" || a["long-clickable"] === "true";
    const scrollable = a.scrollable === "true";
    const checkable = a.checkable === "true";
    const editable = /EditText/u.test(a.class ?? "");
    const meaningful = Boolean(
      text || label || clickable || scrollable || checkable || editable || a.focused === "true",
    );
    if (!meaningful) continue;
    const node: MobileUiNode = {
      ref: `e${nodes.length + 1}`,
      role: roleFor(a.class ?? "", { clickable, scrollable, checkable, editable }),
      bounds,
      ...(text ? { text } : {}),
      ...(label ? { label } : {}),
      ...(id ? { id } : {}),
      ...(clickable ? { clickable } : {}),
      ...(a.focused === "true" ? { focused: true } : {}),
      ...(a.enabled === "false" ? { enabled: false } : {}),
      ...(checkable ? { checked: a.checked === "true" } : {}),
      ...(scrollable ? { scrollable } : {}),
    };
    nodes.push(node);
    depths.push(raw.depth);
  }
  return { nodes, depths };
}

function roleFor(
  className: string,
  flags: { clickable: boolean; scrollable: boolean; checkable: boolean; editable: boolean },
): string {
  const simple = className.split(".").pop() ?? "";
  if (flags.editable) return "textfield";
  if (/Switch/u.test(simple)) return "switch";
  if (/CheckBox/u.test(simple)) return "checkbox";
  if (/RadioButton/u.test(simple)) return "radio";
  if (/Button/u.test(simple)) return "button";
  if (/Image/u.test(simple)) return flags.clickable ? "button" : "image";
  if (flags.scrollable || /RecyclerView|ScrollView|ListView/u.test(simple)) return "list";
  if (/TextView/u.test(simple)) return flags.clickable ? "button" : "text";
  if (flags.checkable) return "checkbox";
  if (flags.clickable) return "button";
  return simple ? simple.toLowerCase() : "view";
}

/** One line per element, indented by relative depth, in the form agents read quickly. */
export function formatUiTree(tree: UiTree): string {
  const minDepth = Math.min(...tree.depths, Number.POSITIVE_INFINITY);
  return tree.nodes
    .map((node, index) => {
      const indent = "  ".repeat(Math.min(8, Math.max(0, (tree.depths[index] ?? 0) - minDepth)));
      const parts = [`[${node.ref}]`, node.role];
      if (node.text) parts.push(JSON.stringify(node.text.slice(0, 200)));
      if (node.label && node.label !== node.text) parts.push(`label=${JSON.stringify(node.label.slice(0, 200))}`);
      if (node.id) parts.push(`id=${node.id}`);
      if (node.checked !== undefined) parts.push(node.checked ? "checked" : "unchecked");
      if (node.focused) parts.push("focused");
      if (node.enabled === false) parts.push("disabled");
      if (node.scrollable) parts.push("scrollable");
      const { x, y, width, height } = node.bounds;
      parts.push(`@${x},${y} ${width}x${height}`);
      return `${indent}${parts.join(" ")}`;
    })
    .join("\n");
}

export function centerOf(node: MobileUiNode): { x: number; y: number } {
  return {
    x: Math.round(node.bounds.x + node.bounds.width / 2),
    y: Math.round(node.bounds.y + node.bounds.height / 2),
  };
}
