import { type RefObject, useLayoutEffect, useState } from "react";

/** Where a popup sits next to its trigger, as fixed-position styles. */
export type AnchoredPlacement = { left: number; maxHeight: number; minWidth?: number } & (
  | { top: number }
  | { bottom: number }
);

/**
 * Whether a scroll event moved `anchor`, so a popup placed next to it is now out of place. Only scrolling
 * the page or one of the anchor's ancestors moves it; an agent's log scrolling in another tile does not.
 */
export function scrollMovesAnchor(event: Event, anchor: Element | null | undefined): boolean {
  if (!anchor) return true;
  return event.target instanceof Node && event.target.contains(anchor);
}

/**
 * Places an open popup beside its trigger: on the `prefer` side when it fits there, else on the side it fits,
 * else on the roomier side. It places the popup again whenever the popup changes size, because items can
 * arrive while it is open, and a menu placed above its trigger for one item would grow out of the window.
 * Returns undefined while closed and until the first measurement, so the popup can render hidden first.
 */
export function useAnchoredPlacement(
  open: boolean,
  triggerRef: RefObject<HTMLElement | null>,
  popupRef: RefObject<HTMLElement | null>,
  {
    prefer,
    align,
    gap,
    edge,
    matchWidth = false,
  }: { prefer: "above" | "below"; align: "start" | "end"; gap: number; edge: number; matchWidth?: boolean },
): AnchoredPlacement | undefined {
  const [placement, setPlacement] = useState<AnchoredPlacement>();

  useLayoutEffect(() => {
    if (!open) {
      setPlacement(undefined);
      return;
    }
    const popup = popupRef.current;
    if (!popup) return;
    const place = () => {
      const anchor = triggerRef.current?.getBoundingClientRect();
      if (!anchor) return;
      // The list scrolls once maxHeight caps it, so its full height comes from scrollHeight.
      const list = popup.querySelector<HTMLElement>(".picker-list");
      const height = popup.offsetHeight + (list ? list.scrollHeight - list.clientHeight : 0);
      const minWidth = matchWidth ? anchor.width : undefined;
      const width = Math.max(popup.offsetWidth, minWidth ?? 0);
      const above = anchor.top - gap - edge;
      const below = window.innerHeight - anchor.bottom - gap - edge;
      const other = prefer === "above" ? "below" : "above";
      const room = (side: "above" | "below") => (side === "above" ? above : below);
      const side = height <= room(prefer) ? prefer : height <= room(other) ? other : above >= below ? "above" : "below";
      const start = align === "end" ? anchor.right - width : anchor.left;
      const left = Math.max(edge, Math.min(start, window.innerWidth - width - edge));
      const next: AnchoredPlacement = {
        left,
        ...(minWidth === undefined ? {} : { minWidth }),
        ...(side === "above"
          ? { bottom: window.innerHeight - anchor.top + gap, maxHeight: above }
          : { top: anchor.bottom + gap, maxHeight: below }),
      };
      setPlacement((current) => (current && samePlacement(current, next) ? current : next));
    };
    place();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(place);
    observer.observe(popup);
    return () => observer.disconnect();
  }, [open, triggerRef, popupRef, prefer, align, gap, edge, matchWidth]);

  return placement;
}

function samePlacement(a: AnchoredPlacement, b: AnchoredPlacement): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof AnchoredPlacement>;
  for (const key of keys) if ((a as Record<string, number>)[key] !== (b as Record<string, number>)[key]) return false;
  return true;
}
