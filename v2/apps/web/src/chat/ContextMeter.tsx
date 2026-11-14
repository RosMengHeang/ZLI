import { useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useAnchoredPlacement } from "../ui/anchoredPopup.js";
import { type ContextUsage, cachedShare, cacheStatus, formatTokens } from "../usage/usage.js";

/** Past this share of the window the agent will soon compact or stop, so the ring turns amber. */
const NEARLY_FULL = 0.85;
const RADIUS = 5.25;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * How full the context window was after the agent's last turn, as a small ring. Hovering or focusing it
 * shows the token counts behind the ring.
 */
export function ContextMeter({ context, now = Date.now }: { context: ContextUsage; now?: () => number }) {
  const { tokens, window, turn } = context;
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const popupId = useId();
  const placement = useAnchoredPlacement(open, triggerRef, popupRef, {
    prefer: "above",
    align: "end",
    gap: 8,
    edge: 8,
  });
  const share = window ? Math.min(1, tokens / window) : undefined;
  const percent = share === undefined ? undefined : Math.round(share * 100);
  const full = share !== undefined && share > NEARLY_FULL;
  const label =
    percent === undefined
      ? `${formatTokens(tokens)} tokens in context`
      : `${percent}% of context used, ${formatTokens(tokens)} of ${formatTokens(window ?? 0)} tokens`;
  const rows = turn
    ? ([
        ["Input", turn.input],
        ["Cached", turn.cached],
        ["Output", turn.output],
      ] as const)
    : [];
  const cached = turn ? cachedShare(turn) : undefined;
  // Read when the popup opens, which re-renders, so the minutes are current each time it shows.
  const cache = open ? cacheStatus(context.cacheExpiresAt, now()) : undefined;

  return (
    <>
      <button
        ref={triggerRef}
        className={`composer-context${full ? " is-full" : ""}`}
        type="button"
        aria-label={label}
        aria-describedby={open ? popupId : undefined}
        onPointerEnter={() => setOpen(true)}
        onPointerLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <circle className="context-ring-track" cx="7" cy="7" r={RADIUS} />
          {share !== undefined ? (
            <circle
              className="context-ring-fill"
              cx="7"
              cy="7"
              r={RADIUS}
              strokeDasharray={CIRCUMFERENCE}
              strokeDashoffset={CIRCUMFERENCE * (1 - share)}
            />
          ) : null}
        </svg>
      </button>
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={popupRef}
              id={popupId}
              className="context-popup"
              role="tooltip"
              style={placement ? { ...placement, maxHeight: undefined } : { left: 0, top: 0, visibility: "hidden" }}
            >
              <div className="context-popup-head">
                <span className="context-popup-title">Context</span>
                {percent !== undefined ? (
                  <span className={`context-popup-percent${full ? " is-full" : ""}`}>{percent}%</span>
                ) : null}
              </div>
              <p className="context-popup-tokens">
                {formatTokens(tokens)}
                {window ? ` / ${formatTokens(window)}` : ""} tokens
              </p>
              {rows.some(([, value]) => value !== undefined) ? (
                <>
                  <p className="context-popup-section">Last turn</p>
                  <dl className="context-popup-turn">
                    {rows.map(([name, value]) =>
                      value === undefined ? null : (
                        <div className="context-popup-row" key={name}>
                          <dt>{name}</dt>
                          <dd>
                            {formatTokens(value)}
                            {name === "Cached" && cached !== undefined ? ` · ${Math.round(cached * 100)}%` : ""}
                          </dd>
                        </div>
                      ),
                    )}
                  </dl>
                  {turn?.cacheMissed ? (
                    <p className="context-popup-note">
                      Most of this turn was sent without the prompt cache, so it used more of your plan's limit.
                    </p>
                  ) : null}
                </>
              ) : null}
              {cache?.warm ? (
                <p className="context-popup-cache">Prompt cache: {cache.minutesLeft} min left</p>
              ) : cache ? (
                <p className="context-popup-note">
                  Prompt cache expired. The next message rereads this thread at full price.
                </p>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
