import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

/** One thing that may sit above the message box, keyed so a new thing fades in rather than morphing the old. */
export type DockItem = { key: string; node: ReactNode };

/** The first item that is present, in the order given: the most pressing comes first. */
export function firstDockItem(items: readonly (DockItem | false | "" | null | undefined)[]): DockItem | undefined {
  for (const item of items) if (item) return item;
  return undefined;
}

/**
 * The one place above the message box where something waits on the person. It holds a single item, and its height
 * follows that item, so the message box glides rather than jumps when an item comes, changes or goes.
 */
export function DockSlot({ item }: { item: DockItem | undefined }) {
  const inner = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number>();
  useLayoutEffect(() => {
    const element = inner.current;
    // Without a way to watch the size, as in tests, the slot keeps its natural height and simply does not animate.
    if (!element || typeof ResizeObserver === "undefined") return;
    const measure = () => setHeight(element.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <div className={`chat-slot${item ? " is-filled" : ""}`} style={height === undefined ? undefined : { height }}>
      <div className="chat-slot-inner" ref={inner}>
        {item ? (
          <div key={item.key} className="chat-slot-item">
            {item.node}
          </div>
        ) : null}
      </div>
    </div>
  );
}
