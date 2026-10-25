import { useCallback, useEffect, useRef, useState } from "react";

/** How long a confirmation such as "Saved Pixel_8.png" stays before it fades. */
export const NOTICE_MS = 3_000;

export type Notice = { text: string; key: number };

/** A short confirmation that clears itself. Showing the same text again restarts it. */
export function useNotice(durationMs = NOTICE_MS): [Notice | undefined, (text: string) => void] {
  const [notice, setNotice] = useState<Notice>();
  const timerRef = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timerRef.current), []);
  const show = useCallback(
    (text: string) => {
      window.clearTimeout(timerRef.current);
      setNotice((current) => ({ text, key: (current?.key ?? 0) + 1 }));
      timerRef.current = window.setTimeout(() => setNotice(undefined), durationMs);
    },
    [durationMs],
  );
  return [notice, show];
}
