import { createContext, useContext, useEffect, useMemo, useState, type PropsWithChildren } from "react";

import type { RuntimeProjection, RpcResponse } from "@zli-v2/contracts";
import { getBridge, type ZliBridge } from "./bridge.js";

type RuntimeContextValue = {
  bridge: ZliBridge | undefined;
  projection: RuntimeProjection | undefined;
  connected: boolean;
  dispatch(request: unknown): Promise<RpcResponse | undefined>;
};

const RuntimeContext = createContext<RuntimeContextValue | undefined>(undefined);

export function RuntimeProvider({ children, bridge = getBridge() }: PropsWithChildren<{ bridge?: ZliBridge | undefined }>) {
  const [projection, setProjection] = useState<RuntimeProjection>();
  useEffect(() => {
    if (!bridge) return;
    let active = true;
    void bridge.runtime.getProjection().then((next) => { if (active && next) setProjection(next); }).catch(() => undefined);
    const unsubscribe = bridge.runtime.onProjection((next) => { if (active) setProjection(next); });
    return () => { active = false; unsubscribe(); };
  }, [bridge]);

  const value = useMemo<RuntimeContextValue>(() => ({
    bridge,
    projection,
    connected: bridge !== undefined && projection !== undefined,
    dispatch: async (request) => bridge?.runtime.dispatch(request),
  }), [bridge, projection]);
  return <RuntimeContext.Provider value={value}>{children}</RuntimeContext.Provider>;
}

export function useRuntime(): RuntimeContextValue {
  const value = useContext(RuntimeContext);
  if (!value) throw new Error("useRuntime must be used inside RuntimeProvider");
  return value;
}
