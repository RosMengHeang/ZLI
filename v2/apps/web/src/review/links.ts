import { useCallback, useEffect, useRef, useState } from "react";

import type { ZliBridge } from "../runtime/bridge.js";

/** Opens a link in the system browser; resolves with a message when that is not possible. */
export async function openExternalLink(bridge: ZliBridge | undefined, url: string): Promise<string | undefined> {
  if (!bridge?.app.openExternal) return `This window cannot open links. Open ${url} in a browser.`;
  try {
    await bridge.app.openExternal(url);
    return undefined;
  } catch (cause) {
    return cause instanceof Error ? cause.message : "The link could not be opened.";
  }
}

/** Copy feedback that resets itself; the clipboard can refuse when the window is not focused. */
export function useCopyFeedback(): [state: "idle" | "copied" | "failed", copy: (value: string) => void] {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = useCallback((value: string) => {
    void navigator.clipboard
      .writeText(value)
      .then(
        () => true,
        () => false,
      )
      .then((copied) => {
        setState(copied ? "copied" : "failed");
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setState("idle"), 1600);
      });
  }, []);
  return [state, copy];
}
