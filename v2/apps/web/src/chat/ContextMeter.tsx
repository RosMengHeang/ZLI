import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useAnchoredPlacement } from "../ui/anchoredPopup.js";
import { Button } from "../ui/Button.js";
import { type ContextUsage, cachedShare, cacheStatus, formatTokens } from "../usage/usage.js";
import { useCompactAction } from "./compactAction.js";

/** Past this share of the window the agent will soon compact or stop, so the ring turns amber. */
const NEARLY_FULL = 0.85;
const RADIUS = 5.25;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
/** Time to move the pointer from the ring onto the popup before it closes. */
const LEAVE_DELAY_MS = 150;

/**
 * How full the context window was after the agent's last turn, as a small ring. Hovering or focusing it
 * shows the token counts behind the ring. When the chat can compact, clicking the ring keeps the popup open
 * with "Compact now".
 */
export function ContextMeter({ context, now = Date.now }: { context: ContextUsage; now?: () => number }) {
  const { tokens, window, turn } = context;
  const action = useCompactAction();
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const quietFocus = useRef(false);
  const popupId = useId();
  const shown = open || pinned;
  const placement = useAnchoredPlacement(shown, triggerRef, popupRef, {
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
  const cache = shown ? cacheStatus(context.cacheExpiresAt, now()) : undefined;

  const cancelLeave = useCallback(() => {
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    leaveTimer.current = undefined;
  }, []);
  const leave = () => {
    cancelLeave();
    if (!action) {
      setOpen(false);
      return;
    }
    leaveTimer.current = setTimeout(() => setOpen(false), LEAVE_DELAY_MS);
  };
  useEffect(() => cancelLeave, [cancelLeave]);

  // A pinned popup closes on Escape or a press outside it, like a menu.
  useEffect(() => {
    if (!pinned) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setPinned(false);
      setOpen(false);
      // Focus goes back to the ring without opening the popup again.
      quietFocus.current = true;
      triggerRef.current?.focus();
      quietFocus.current = false;
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (popupRef.current?.contains(target) || triggerRef.current?.contains(target))) return;
      setPinned(false);
      setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [pinned]);

  useEffect(() => {
    if (pinned && action?.status === "ready") actionRef.current?.focus();
  }, [pinned, action?.status]);

  const compact = () => {
    action?.run();
    setPinned(false);
    setOpen(false);
  };

  return (
    <>
      <button
        ref={triggerRef}
        className={`composer-context${full ? " is-full" : ""}`}
        type="button"
        aria-label={label}
        aria-describedby={shown && !action ? popupId : undefined}
        aria-expanded={action ? pinned : undefined}
        aria-controls={action && pinned ? popupId : undefined}
        onPointerEnter={() => {
          cancelLeave();
          setOpen(true);
        }}
        onPointerLeave={leave}
        onFocus={() => {
          if (!quietFocus.current) setOpen(true);
        }}
        onBlur={() => {
          if (!pinned) setOpen(false);
        }}
        onClick={() => {
          if (action) setPinned((value) => !value);
        }}
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
      {shown && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={popupRef}
              id={popupId}
              className={`context-popup${action ? " is-interactive" : ""}`}
              role={action ? "dialog" : "tooltip"}
              {...(action ? { "aria-label": "Context" } : {})}
              onPointerEnter={cancelLeave}
              onPointerLeave={() => {
                if (!pinned) leave();
              }}
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
              {action ? (
                <div className="context-popup-compact">
                  <Button
                    ref={actionRef}
                    size="xs"
                    variant="secondary"
                    disabled={action.status !== "ready"}
                    loading={action.status === "compacting"}
                    onClick={compact}
                  >
                    {action.status === "compacting" ? "Compacting…" : "Compact now"}
                  </Button>
                  {action.note || action.autoAt !== undefined ? (
                    <p className="context-popup-cache">
                      {action.note ??
                        `Compacts by itself at ${Math.round((action.autoAt ?? 0) * 100)}% after a turn ends.`}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
