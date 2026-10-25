import { createContext, useContext } from "react";

export type Route =
  | { name: "home" }
  | { name: "agent"; threadId: string }
  | { name: "start"; projectId?: string }
  | { name: "terminal"; terminalId: string }
  | { name: "settings" };

export type Navigation = {
  push(route: Route): void;
  /** Swaps the current screen, so Back skips it. */
  replace(route: Route): void;
  back(): void;
};

export const NavigationContext = createContext<Navigation | undefined>(undefined);

export function useNavigation(): Navigation {
  const navigation = useContext(NavigationContext);
  if (!navigation) throw new Error("useNavigation needs a NavigationContext");
  return navigation;
}
