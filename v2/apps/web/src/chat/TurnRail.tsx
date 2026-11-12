import { type RefObject, useEffect, useState } from "react";

import { promptLabel } from "./turns.js";

/** Below this many messages the whole chat is in reach by scrolling, so the rail stays away. */
export const RAIL_FROM = 3;

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

/**
 * A long chat at a glance: one mark for each message the person sent, down the edge of the log.
 * The mark of the turn in view is lit. Pointing at the rail lists the messages; picking one goes there.
 */
export function TurnRail({
  prompts,
  logRef,
}: {
  prompts: readonly { id: string; text: string }[];
  logRef: RefObject<HTMLElement | null>;
}) {
  const [active, setActive] = useState<string>();
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
  return (
    <nav className="turn-rail" aria-label="Messages in this chat">
      <span className="turn-rail-marks" aria-hidden="true">
        {prompts.map((prompt) => (
          <span key={prompt.id} className={`turn-rail-mark${prompt.id === active ? " is-active" : ""}`} />
        ))}
      </span>
      <ol className="turn-rail-list">
        {prompts.map((prompt, index) => (
          <li key={prompt.id}>
            <button
              type="button"
              className={`turn-rail-item${prompt.id === active ? " is-active" : ""}`}
              aria-current={prompt.id === active ? "true" : undefined}
              onClick={(event) => {
                if (logRef.current) scrollToTurn(logRef.current, prompt.id);
                // Focus would hold the list open over the message the person just went to.
                event.currentTarget.blur();
              }}
            >
              <span className="turn-rail-number">{index + 1}</span>
              <span className="turn-rail-text">{promptLabel(prompt.text)}</span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}
