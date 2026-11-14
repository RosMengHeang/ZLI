import { type CSSProperties, type PointerEvent, type RefObject, useEffect, useRef, useState } from "react";

import { promptLabel } from "./turns.js";

/** Below this many messages the whole chat is in reach by scrolling, so the rail stays away. */
export const RAIL_FROM = 3;

/** How far from the pointer, in pixels, a tick still grows. */
const REACH = 44;

/** Scrolls the log so the message sits near its top. */
export function scrollToTurn(log: HTMLElement, id: string): void {
  const target = [...log.querySelectorAll<HTMLElement>("[data-turn]")].find((element) => element.dataset.turn === id);
  if (!target) return;
  const top = target.getBoundingClientRect().top - log.getBoundingClientRect().top + log.scrollTop - 16;
  log.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
}

/** The message whose turn is in view: the last one that starts above the middle of the log. */
function turnInView(log: HTMLElement): string | undefined {
  const middle = log.getBoundingClientRect().top + log.clientHeight / 2;
  let current: string | undefined;
  for (const element of log.querySelectorAll<HTMLElement>("[data-turn]")) {
    if (element.getBoundingClientRect().top > middle && current) break;
    current = element.dataset.turn;
  }
  return current;
}

/** The start of a reply as one plain line, without the marks markdown puts around words. */
function replyLine(text: string | undefined): string {
  if (!text) return "";
  return text
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/[#*_`>|[\]]/gu, "")
    .replace(/\(https?:[^)]*\)/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 220);
}

/**
 * A long chat at a glance: a tick down the left edge for each message the person sent, with the tick of the
 * turn in view lit. Ticks grow as the pointer comes near, like a dock. The tick under the pointer shows a
 * card with the message and the start of its reply; clicking it goes there.
 */
export function TurnRail({
  prompts,
  logRef,
}: {
  prompts: readonly { id: string; text: string; reply?: string | undefined }[];
  logRef: RefObject<HTMLElement | null>;
}) {
  const [active, setActive] = useState<string>();
  const [pointer, setPointer] = useState<number>();
  const [shown, setShown] = useState<{ id: string; top: number }>();
  const marksRef = useRef<HTMLDivElement>(null);
  const count = prompts.length;

  useEffect(() => {
    const log = logRef.current;
    if (!log || count < RAIL_FROM) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      setActive(turnInView(log));
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    log.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      log.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [logRef, count]);

  if (count < RAIL_FROM) return null;

  const show = (element: HTMLElement, id: string) => {
    const box = marksRef.current?.getBoundingClientRect();
    const tick = element.getBoundingClientRect();
    setShown({ id, top: box ? tick.top + tick.height / 2 - box.top : 0 });
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const marks = marksRef.current;
    // Ticks are measured from the top of the list, so a scrolled list adds what is scrolled away.
    if (marks) setPointer(event.clientY - marks.getBoundingClientRect().top + marks.scrollTop);
  };

  const card = shown ? prompts.find((prompt) => prompt.id === shown.id) : undefined;

  return (
    <nav className="turn-rail" aria-label="Messages in this chat">
      <div
        ref={marksRef}
        className="turn-rail-marks"
        onPointerMove={onPointerMove}
        onPointerLeave={() => {
          setPointer(undefined);
          setShown(undefined);
        }}
      >
        {prompts.map((prompt) => (
          <button
            key={prompt.id}
            type="button"
            className={`turn-rail-tick${prompt.id === active ? " is-active" : ""}${prompt.id === shown?.id ? " is-shown" : ""}`}
            aria-current={prompt.id === active ? "true" : undefined}
            style={{ "--near": nearness(marksRef.current, prompt.id, pointer) } as CSSProperties}
            data-turn-id={prompt.id}
            onPointerEnter={(event) => show(event.currentTarget, prompt.id)}
            onFocus={(event) => show(event.currentTarget, prompt.id)}
            onBlur={() => setShown(undefined)}
            onClick={(event) => {
              if (logRef.current) scrollToTurn(logRef.current, prompt.id);
              // Focus would hold the card open over the message the person just went to.
              event.currentTarget.blur();
            }}
          >
            <span className="turn-rail-line" aria-hidden="true" />
            <span className="turn-rail-text sr-only">{promptLabel(prompt.text)}</span>
          </button>
        ))}
      </div>
      {card && shown ? (
        // Keyed by message, so moving to another tick replays the card's short slide-in.
        <div className="turn-rail-card" key={card.id} style={{ top: shown.top }} aria-hidden="true">
          <span className="turn-rail-card-title">{promptLabel(card.text)}</span>
          {replyLine(card.reply) ? <span className="turn-rail-card-reply">{replyLine(card.reply)}</span> : null}
        </div>
      ) : null}
    </nav>
  );
}

/** 1 for the tick under the pointer, falling to 0 at REACH pixels away. */
function nearness(box: HTMLElement | null, id: string, pointer: number | undefined): number {
  if (pointer === undefined || !box) return 0;
  const tick = [...box.querySelectorAll<HTMLElement>("[data-turn-id]")].find(
    (element) => element.dataset.turnId === id,
  );
  if (!tick) return 0;
  const middle = tick.offsetTop + tick.offsetHeight / 2;
  return Math.max(0, 1 - Math.abs(middle - pointer) / REACH);
}
