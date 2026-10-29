/**
 * Whether a scroll event moved `anchor`, so a popup placed next to it is now out of place. Only scrolling
 * the page or one of the anchor's ancestors moves it; an agent's log scrolling in another tile does not.
 */
export function scrollMovesAnchor(event: Event, anchor: Element | null | undefined): boolean {
  if (!anchor) return true;
  return event.target instanceof Node && event.target.contains(anchor);
}
