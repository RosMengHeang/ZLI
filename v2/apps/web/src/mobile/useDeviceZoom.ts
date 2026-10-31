import { useCallback, useState } from "react";

/** Fit scales the screen to the panel; actual shows one device pixel per screen pixel, scrolling when it is larger. */
export type Zoom = "fit" | "actual";

const ZOOM_KEY = "zli.mobile.zoom.v1";

/** The zoom remembered for a device, Fit until the person picks 100%. */
export function useDeviceZoom(deviceId: string | undefined): [Zoom, (zoom: Zoom) => void] {
  const [zooms, setZooms] = useState<Record<string, Zoom>>(readZooms);
  const zoom = (deviceId && zooms[deviceId]) || "fit";
  const setZoom = useCallback(
    (next: Zoom) => {
      if (!deviceId) return;
      const updated = { ...zooms };
      if (next === "fit") delete updated[deviceId];
      else updated[deviceId] = next;
      setZooms(updated);
      try {
        window.localStorage.setItem(ZOOM_KEY, JSON.stringify(updated));
      } catch {
        // Without storage the zoom lasts until the panel closes.
      }
    },
    [deviceId, zooms],
  );
  return [zoom, setZoom];
}

function readZooms(): Record<string, Zoom> {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(ZOOM_KEY) ?? "{}");
    if (!stored || typeof stored !== "object") return {};
    return Object.fromEntries(Object.entries(stored).filter(([, value]) => value === "actual")) as Record<string, Zoom>;
  } catch {
    return {};
  }
}
