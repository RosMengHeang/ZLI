import type { RpcResponse, RuntimeProjection } from "@zli-v2/contracts";
import { createContext, type PropsWithChildren, useContext, useEffect, useMemo, useSyncExternalStore } from "react";

import { getBridge, type ZliBridge } from "./bridge.js";
import { createRuntimeStore, createSelection, type RuntimeStore, sameShellProjection } from "./runtimeStore.js";

type RuntimeContextValue = {
  bridge: ZliBridge | undefined;
  store: RuntimeStore;
  dispatch(request: unknown): Promise<RpcResponse | undefined>;
};

const RuntimeContext = createContext<RuntimeContextValue | undefined>(undefined);

export function RuntimeProvider({
  children,
  bridge = getBridge(),
}: PropsWithChildren<{ bridge?: ZliBridge | undefined }>) {
  const store = useMemo(() => createRuntimeStore(bridge), [bridge]);
  useEffect(() => store.start(), [store]);
  const value = useMemo<RuntimeContextValue>(
    () => ({ bridge, store, dispatch: async (request) => bridge?.runtime.dispatch(request) }),
    [bridge, store],
  );
  return <RuntimeContext.Provider value={value}>{children}</RuntimeContext.Provider>;
}

function useRuntimeContext(): RuntimeContextValue {
  const value = useContext(RuntimeContext);
  if (!value) throw new Error("Runtime hooks must be used inside RuntimeProvider");
  return value;
}

/** The bridge and command dispatch. Both stay the same for the life of the provider, so reading them never re-renders. */
export function useRuntime(): Pick<RuntimeContextValue, "bridge" | "dispatch"> {
  const { bridge, dispatch } = useRuntimeContext();
  return useMemo(() => ({ bridge, dispatch }), [bridge, dispatch]);
}

/**
 * Subscribes to the part of the projection that `selector` returns. The component re-renders only
 * when that result changes, compared with `isEqual`, which must be a stable function.
 */
export function useRuntimeSelector<T>(
  selector: (projection: RuntimeProjection | undefined) => T,
  isEqual?: (left: T, right: T) => boolean,
): T {
  const { store } = useRuntimeContext();
  const select = useMemo(() => createSelection<T>(store.getSnapshot, isEqual), [store, isEqual]);
  const getSnapshot = () => select(selector);
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

const whole = (projection: RuntimeProjection | undefined) => projection;

/** The whole projection; re-renders on every runtime update. Prefer a narrower selector. */
export function useProjection(): RuntimeProjection | undefined {
  return useRuntimeSelector(whole);
}

/**
 * The projection for the workspace shell. It skips updates that only touch chat messages, activities,
 * or requests, so `messages` in it can be older than the runtime's; it is only current enough to name
 * each agent. Chat views read their own messages with useRuntimeSelector.
 */
export function useShellProjection(): RuntimeProjection | undefined {
  return useRuntimeSelector(whole, sameShellProjection);
}
