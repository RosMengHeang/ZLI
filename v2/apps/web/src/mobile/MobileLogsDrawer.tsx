import { type MobileDevice, MobilePanelLaunchInput } from "@zli-v2/contracts";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import type { MobileBridge } from "../runtime/bridge.js";
import { IconButton } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { errorText, logLineCount } from "./mobile.js";

const OPEN_KEY = "zli.mobile.logs.v1";
export const LOGS_AUTO_REFRESH_MS = 2_000;

/**
 * The device's recent log lines, folded under the controls. It reads only while open, and the open state lasts
 * for the session. The device refuses panel reads while an agent holds it, so the drawer waits for Take over.
 */
export function MobileLogsDrawer({
  mobile,
  device,
  inputBlocked,
  onBlockedInput,
  onNotice,
}: {
  mobile: Pick<MobileBridge, "logs">;
  device: MobileDevice;
  inputBlocked: boolean;
  onBlockedInput(): void;
  onNotice(message: string): void;
}) {
  const deviceId = device.deviceId;
  const [open, setOpenState] = useState(readOpen);
  const [filter, setFilter] = useState("");
  const [appId, setAppId] = useState("");
  const [lineCount, setLineCount] = useState("200");
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [lines, setLines] = useState<string[]>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const loadingRef = useRef(false);
  const queryRef = useRef({ filter, appId, lineCount });
  queryRef.current = { filter, appId, lineCount };
  const listRef = useRef<HTMLPreElement>(null);
  /** Whether the list was scrolled to its end, so new lines keep it there. */
  const followRef = useRef(true);
  const panelId = useId();

  const setOpen = (next: boolean) => {
    setOpenState(next);
    try {
      window.sessionStorage.setItem(OPEN_KEY, next ? "open" : "closed");
    } catch {
      // Without storage the drawer starts closed next time.
    }
  };

  const load = useCallback(async () => {
    if (loadingRef.current) return;
    const query = queryRef.current;
    const app = query.appId.trim();
    if (app && !MobilePanelLaunchInput.shape.appId.safeParse(app).success) {
      setError("Use an app id like com.example.app.");
      return;
    }
    const text = query.filter.trim();
    loadingRef.current = true;
    setLoading(true);
    try {
      const list = listRef.current;
      followRef.current = !list || list.scrollHeight - list.scrollTop - list.clientHeight < 8;
      setLines(
        await mobile.logs(deviceId, {
          lines: logLineCount(query.lineCount),
          ...(app ? { appId: app } : {}),
          ...(text ? { filter: text } : {}),
        }),
      );
      setError(undefined);
    } catch (cause) {
      setError(errorText(cause, "The logs could not be read."));
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [mobile, deviceId]);

  const reading = open && !inputBlocked;
  useEffect(() => {
    if (reading) void load();
  }, [reading, load]);
  useEffect(() => {
    if (!reading || !autoRefresh) return;
    const timer = window.setInterval(() => void load(), LOGS_AUTO_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [reading, autoRefresh, load]);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (lines && list && followRef.current) list.scrollTop = list.scrollHeight;
  }, [lines]);

  const refresh = () => {
    if (inputBlocked) return onBlockedInput();
    void load();
  };
  const copyAll = () => {
    if (!lines?.length) return;
    if (!navigator.clipboard) {
      setError("ZLI could not copy the logs. Select the lines and copy them instead.");
      return;
    }
    navigator.clipboard.writeText(lines.join("\n")).then(
      () => onNotice(lines.length === 1 ? "Copied 1 log line." : `Copied ${lines.length} log lines.`),
      () => setError("ZLI could not copy the logs. Select the lines and copy them instead."),
    );
  };

  return (
    <section className="mobile-logs" aria-label="Logs">
      <button
        type="button"
        className="mobile-logs-toggle"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen(!open)}
      >
        <Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
        Logs
        {open && lines ? <span className="mobile-logs-count">{lines.length} lines</span> : null}
      </button>
      {open ? (
        <div className="mobile-logs-panel" id={panelId}>
          <form
            className="mobile-logs-query"
            onSubmit={(event) => {
              event.preventDefault();
              refresh();
            }}
          >
            <input
              className="input input-sm"
              aria-label="Only lines containing"
              placeholder="Filter"
              value={filter}
              spellCheck={false}
              onChange={(event) => setFilter(event.target.value)}
            />
            <input
              className="input input-sm"
              aria-label="Only this app"
              placeholder="App id, optional"
              value={appId}
              spellCheck={false}
              autoCapitalize="off"
              onChange={(event) => setAppId(event.target.value)}
            />
            <input
              className="input input-sm mobile-logs-lines"
              aria-label="Lines"
              title="Lines to read, up to 2,000"
              type="number"
              inputMode="numeric"
              min={1}
              max={2_000}
              value={lineCount}
              onChange={(event) => setLineCount(event.target.value)}
            />
            <IconButton type="submit" icon="reload" size="sm" iconSize={14} label="Refresh logs" disabled={loading} />
            <IconButton
              icon="copy"
              size="sm"
              iconSize={14}
              label="Copy all"
              tooltip="Copy all lines"
              disabled={!lines?.length}
              onClick={copyAll}
            />
            <label className="mobile-logs-auto" title="Read the logs again every 2 seconds">
              <input type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} />
              Auto-refresh
            </label>
          </form>
          {error ? (
            <div className="banner banner-danger" role="alert">
              <Icon name="alert" size={14} />
              <span className="banner-message">{error}</span>
            </div>
          ) : null}
          {inputBlocked ? (
            <p className="mobile-logs-empty">Take over to read this device's logs.</p>
          ) : lines === undefined ? (
            <p className="mobile-logs-empty">{loading ? "Reading the logs" : "No logs read yet."}</p>
          ) : lines.length === 0 ? (
            <p className="mobile-logs-empty">No log lines match.</p>
          ) : (
            // biome-ignore lint/a11y/noNoninteractiveTabindex: the list scrolls, and keyboard users need to reach it.
            <pre ref={listRef} className="mobile-logs-list" tabIndex={0} title={`${device.name} log lines`}>
              {lines.join("\n")}
            </pre>
          )}
        </div>
      ) : null}
    </section>
  );
}

function readOpen(): boolean {
  try {
    return window.sessionStorage.getItem(OPEN_KEY) === "open";
  } catch {
    return false;
  }
}
