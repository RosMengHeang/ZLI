import { useCallback, useEffect, useState } from "react";

const FRAME_KEY = "zli.mobile.skin.v1";

/**
 * Whether the device frame shows around the screen: on until the person turns it off. The setting is shared by
 * the panel and device windows, and a change in one shows in the others.
 */
export function useDeviceFrame(): [boolean, (shown: boolean) => void] {
  const [shown, setShownState] = useState(readShown);
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === FRAME_KEY || event.key === null) setShownState(readShown());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  const setShown = useCallback((next: boolean) => {
    setShownState(next);
    try {
      if (next) window.localStorage.removeItem(FRAME_KEY);
      else window.localStorage.setItem(FRAME_KEY, "off");
    } catch {
      // Without storage the choice lasts until the panel closes.
    }
  }, []);
  return [shown, setShown];
}

function readShown(): boolean {
  try {
    return window.localStorage.getItem(FRAME_KEY) !== "off";
  } catch {
    return true;
  }
}
