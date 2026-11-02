import { useCallback, useState } from "react";

const COMPACT_KEY = "zli.mobile.compact.v1";

/**
 * Whether a device's pop-out window hides its bottom bar so it takes little room over other windows, remembered
 * per device. Off until the person turns it on.
 */
export function useCompactWindow(deviceId: string): [boolean, (compact: boolean) => void] {
  const [compactIds, setCompactIds] = useState<readonly string[]>(readCompactIds);
  const compact = compactIds.includes(deviceId);
  const setCompact = useCallback(
    (next: boolean) => {
      const updated = compactIds.filter((id) => id !== deviceId);
      if (next) updated.push(deviceId);
      setCompactIds(updated);
      try {
        if (updated.length === 0) window.localStorage.removeItem(COMPACT_KEY);
        else window.localStorage.setItem(COMPACT_KEY, JSON.stringify(updated));
      } catch {
        // Without storage the choice lasts until the window closes.
      }
    },
    [deviceId, compactIds],
  );
  return [compact, setCompact];
}

function readCompactIds(): string[] {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(COMPACT_KEY) ?? "[]");
    return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}
