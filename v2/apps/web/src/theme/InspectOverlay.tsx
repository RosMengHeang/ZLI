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

/** The colors an element shows: what it sits on first, then its text and its edge. */
export function fieldsAt(element: Element | null, colors: Map<string, EditableField[]>): EditableField[] {
  const found: EditableField[] = [];
  const add = (fields: EditableField[] | undefined) => {
    for (const field of fields ?? []) if (!found.includes(field)) found.push(field);
  };
  if (!element) return found;
  // The nearest painted background, which may belong to a parent.
  for (let node: Element | null = element; node; node = node.parentElement) {
    const background = getComputedStyle(node).backgroundColor;
    if (TRANSPARENT.has(background)) continue;
    add(colors.get(background));
    break;
  }
  const style = getComputedStyle(element);
  add(colors.get(style.color));
  if (style.borderTopWidth !== "0px") add(colors.get(style.borderTopColor));
  return found;
}

type Target = { rect: DOMRect; fields: EditableField[] };

/**
 * Covers the window while the person points at the part of the app they want to recolor. Clicks never
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
    if (!element || element.closest(".theme-editor")) return undefined;
    return { rect: element.getBoundingClientRect(), fields: fieldsAt(element, colors) };
  };

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
        if (picked && picked.fields.length > 0) onPick(picked.fields);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      {target ? (
        <>
          <div
            className="inspect-box"
            style={{
              left: target.rect.left,
              top: target.rect.top,
              width: target.rect.width,
              height: target.rect.height,
            }}
          />
          <div
            className="inspect-label"
            style={{
              left: Math.max(4, Math.min(target.rect.left, window.innerWidth - 220)),
              top:
                target.rect.bottom + 6 > window.innerHeight - 28
                  ? Math.max(4, target.rect.top - 28)
                  : target.rect.bottom + 6,
            }}
          >
            {target.fields.length > 0
              ? target.fields.map((field) => FIELD_LABELS[field]).join(" · ")
              : "No theme color here"}
          </div>
        </>
      ) : null}
    </div>,
    document.body,
  );
}
