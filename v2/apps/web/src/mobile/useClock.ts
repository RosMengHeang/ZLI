import { useEffect, useState } from "react";

/** The current time, refreshed every intervalMs while one is given, for labels that count. */
export function useClock(intervalMs: number | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (intervalMs === undefined) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}
