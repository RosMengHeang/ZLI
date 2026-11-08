import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { type EditableField, FIELD_LABELS, TOKEN_FIELDS } from "./customThemes.js";

/**
 * The editable colors behind each computed color value on screen right now. Several can share a value,
 * such as a sidebar the same color as the window, and all of them are offered.
 */
function colorFields(): Map<string, EditableField[]> {
  const probe = document.createElement("span");
  probe.style.display = "none";
  document.body.append(probe);
  const fields = new Map<string, EditableField[]>();
  for (const [token, field] of Object.entries(TOKEN_FIELDS)) {
    probe.style.color = `var(${token})`;
    const color = getComputedStyle(probe).color;
    if (!color) continue;
    const list = fields.get(color) ?? [];
    if (!list.includes(field)) list.push(field);
    fields.set(color, list);
  }
  probe.remove();
  return fields;
}

const TRANSPARENT = new Set(["transparent", "rgba(0, 0, 0, 0)"]);

/** A theme color found on an element, with the value it shows there. */
export type FoundColor = { field: EditableField; color: string };

/** The colors an element shows: what it sits on first, then its text and its edge. */
export function colorsAt(element: Element | null, colors: Map<string, EditableField[]>): FoundColor[] {
  const found: FoundColor[] = [];
  const add = (color: string) => {
    for (const field of colors.get(color) ?? []) {
      if (!found.some((entry) => entry.field === field)) found.push({ field, color });
    }
  };
  if (!element) return found;
  // The nearest painted background, which may belong to a parent.
  for (let node: Element | null = element; node; node = node.parentElement) {
    const background = getComputedStyle(node).backgroundColor;
    if (TRANSPARENT.has(background)) continue;
    add(background);
    break;
  }
  const style = getComputedStyle(element);
  add(style.color);
  if (style.borderTopWidth !== "0px") add(style.borderTopColor);
  return found;
}

/** `rgb(…)` or `rgba(…)` as `#rrggbb`, ignoring alpha. */
function toHex(color: string): string {
  const parts =
    color
      .match(/\d+(\.\d+)?/gu)
      ?.slice(0, 3)
      .map(Number) ?? [];
  return `#${parts.map((part) => Math.round(part).toString(16).padStart(2, "0")).join("")}`;
}

type Edges = { top: number; right: number; bottom: number; left: number };

function edges(style: CSSStyleDeclaration, prefix: "margin" | "padding" | "border", suffix = ""): Edges {
  // Negative margins pull neighbours in; the overlay draws them as none.
  const read = (side: string) =>
    Math.max(0, Number.parseFloat(style.getPropertyValue(`${prefix}-${side}${suffix}`)) || 0);
  return { top: read("top"), right: read("right"), bottom: read("bottom"), left: read("left") };
}

type Target = {
  rect: DOMRect;
  margin: Edges;
  border: Edges;
  padding: Edges;
  /** Like `button.theme-row-name`, as developer tools label an element. */
  tag: string;
  colors: FoundColor[];
};

function describe(element: Element): string {
  const first = [...element.classList].find(Boolean);
  return `${element.tagName.toLowerCase()}${first ? `.${first}` : ""}`;
}

const px = (value: number) => `${Math.max(0, value)}px`;
const borderWidths = (box: Edges) => `${px(box.top)} ${px(box.right)} ${px(box.bottom)} ${px(box.left)}`;

/**
 * Covers the window while the person points at the part of the app they want to recolor, the way the
 * element picker of browser developer tools does: the element under the pointer shows its margin,
 * border, padding, and content, with a label naming it, its size, and its theme colors. Clicks never
 * reach the app underneath. Escape or right-click leaves without picking.
 */
export function InspectOverlay({ onPick, onCancel }: { onPick(fields: EditableField[]): void; onCancel(): void }) {
  const layerRef = useRef<HTMLDivElement>(null);
  const colors = useMemo(colorFields, []);
  const [target, setTarget] = useState<Target>();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  const read = (x: number, y: number): Target | undefined => {
    const layer = layerRef.current;
    if (!layer) return undefined;
    // The layer steps aside for a moment so the element under the pointer can be found.
    layer.style.pointerEvents = "none";
    const element = document.elementFromPoint(x, y);
    layer.style.pointerEvents = "";
    if (!element || element.closest(".theme-editor, .color-popover")) return undefined;
    const style = getComputedStyle(element);
    return {
      rect: element.getBoundingClientRect(),
      margin: edges(style, "margin"),
      border: edges(style, "border", "-width"),
      padding: edges(style, "padding"),
      tag: describe(element),
      colors: colorsAt(element, colors),
    };
  };

  const label = target ? labelPosition(target.rect) : undefined;

  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: a pointer-only aiming layer; Escape leaves it from the keyboard.
    <div
      ref={layerRef}
      className="inspect-layer"
      role="presentation"
      onPointerMove={(event) => setTarget(read(event.clientX, event.clientY))}
      onPointerLeave={() => setTarget(undefined)}
      onClick={(event) => {
        const picked = read(event.clientX, event.clientY);
        if (picked && picked.colors.length > 0) onPick(picked.colors.map((entry) => entry.field));
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      {target ? (
        <>
          <div
            className="inspect-margin"
            style={{
              left: target.rect.left - target.margin.left,
              top: target.rect.top - target.margin.top,
              width: target.rect.width + target.margin.left + target.margin.right,
              height: target.rect.height + target.margin.top + target.margin.bottom,
              borderWidth: borderWidths(target.margin),
            }}
          >
            <div className="inspect-border" style={{ borderWidth: borderWidths(target.border) }}>
              <div className="inspect-padding" style={{ borderWidth: borderWidths(target.padding) }}>
                <div className="inspect-content" />
              </div>
            </div>
          </div>
          {label ? (
            <div className="inspect-label" style={label}>
              <div className="inspect-label-head">
                <span className="inspect-label-tag">{target.tag}</span>
                <span className="inspect-label-size">
                  {Math.round(target.rect.width)} × {Math.round(target.rect.height)}
                </span>
              </div>
              {target.colors.length > 0 ? (
                <ul className="inspect-label-colors">
                  {target.colors.map((entry) => (
                    <li key={entry.field}>
                      <span className="inspect-label-swatch" style={{ background: entry.color }} />
                      <span className="inspect-label-name">{FIELD_LABELS[entry.field]}</span>
                      <span className="inspect-label-hex">{toHex(entry.color)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="inspect-label-empty">No theme color here</p>
              )}
            </div>
          ) : null}
        </>
      ) : null}
    </div>,
    document.body,
  );
}

const LABEL_WIDTH = 240;
const LABEL_GAP = 8;

/** Under the element when there is room, above it otherwise, kept inside the window. */
function labelPosition(rect: DOMRect): { left: number; top?: number; bottom?: number } {
  const left = Math.max(LABEL_GAP, Math.min(rect.left, window.innerWidth - LABEL_WIDTH - LABEL_GAP));
  const below = rect.bottom + LABEL_GAP;
  if (below < window.innerHeight - 140) return { left, top: below };
  return { left, bottom: Math.max(LABEL_GAP, window.innerHeight - rect.top + LABEL_GAP) };
}
