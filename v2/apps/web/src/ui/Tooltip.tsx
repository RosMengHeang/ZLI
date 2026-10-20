import { useEffect, useLayoutEffect, useRef, useState } from "react";

type Tip = { text: string; shortcut?: string | undefined; anchor: DOMRect; side: "top" | "bottom" };

const HOVER_DELAY_MS = 450;
const GAP = 6;
const EDGE = 8;

/**
 * One tooltip for the whole window. Any element with data-tooltip gets it on hover, after a short
 * delay, and at once on keyboard focus. Fixed positioning keeps it clear of panes that clip overflow.
 */
export function TooltipLayer() {
  const [tip, setTip] = useState<Tip>();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current: HTMLElement | undefined;
    const target = (node: EventTarget | null) =>
      node instanceof Element ? (node.closest<HTMLElement>("[data-tooltip]") ?? undefined) : undefined;
    const hide = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      current = undefined;
      setTip(undefined);
    };
    const show = (element: HTMLElement) => {
      const text = element.dataset.tooltip;
      if (!text || !element.isConnected) return;
      const anchor = element.getBoundingClientRect();
      const preferred = element.dataset.tooltipSide === "top" ? "top" : "bottom";
      const side = preferred === "bottom" && anchor.bottom + 40 > window.innerHeight ? "top" : preferred;
      setTip({ text, shortcut: element.dataset.shortcut, anchor, side });
    };
    const onOver = (event: PointerEvent) => {
      const element = target(event.target);
      if (element === current) return;
      hide();
      if (!element || event.pointerType === "touch") return;
      current = element;
      timer = setTimeout(() => show(element), HOVER_DELAY_MS);
    };
    const onOut = (event: PointerEvent) => {
      if (current && !(event.relatedTarget instanceof Node && current.contains(event.relatedTarget))) hide();
    };
    const onFocusIn = (event: FocusEvent) => {
      const element = target(event.target);
      if (!element || element !== event.target) return;
      let visible = false;
      try {
        visible = element.matches(":focus-visible");
      } catch {
        visible = false;
      }
      if (!visible) return;
      hide();
      current = element;
      show(element);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab" && event.key !== "Shift") hide();
    };
    document.addEventListener("pointerover", onOver);
    document.addEventListener("pointerout", onOut);
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", hide);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    window.addEventListener("blur", hide);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener("pointerover", onOver);
      document.removeEventListener("pointerout", onOut);
      document.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", hide);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
      window.removeEventListener("blur", hide);
    };
  }, []);

  // The tooltip is measured after it renders so it can be centered and kept inside the window.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !tip) return;
    const { width, height } = element.getBoundingClientRect();
    const center = tip.anchor.left + tip.anchor.width / 2;
    const left = Math.min(Math.max(EDGE, center - width / 2), window.innerWidth - width - EDGE);
    const top = tip.side === "bottom" ? tip.anchor.bottom + GAP : tip.anchor.top - height - GAP;
    element.style.left = `${Math.round(left)}px`;
    element.style.top = `${Math.round(Math.max(EDGE, top))}px`;
    element.style.visibility = "visible";
  }, [tip]);

  if (!tip) return null;
  return (
    <div className="tooltip" role="tooltip" ref={ref} style={{ left: 0, top: 0, visibility: "hidden" }}>
      <span>{tip.text}</span>
      {tip.shortcut ? <kbd>{tip.shortcut}</kbd> : null}
    </div>
  );
}
