import { useEffect, useMemo, useState } from "react";
import { BackHandler, View } from "react-native";

import { useLinkSnapshot } from "./LinkContext.js";
import { type Navigation, NavigationContext, type Route } from "./navigation.js";
import { AgentScreen } from "./screens/AgentScreen.js";
import { HomeScreen } from "./screens/HomeScreen.js";
import { SettingsScreen } from "./screens/SettingsScreen.js";
import { StartAgentScreen } from "./screens/StartAgentScreen.js";
import { TerminalScreen } from "./screens/TerminalScreen.js";
import { usePalette } from "./theme.js";
import { EmptyState, Header } from "./ui/components.js";

/** A screen stack. The app has five screens, which does not justify a navigation library. */
export function Navigator({ onForget }: { onForget: (notice?: string) => Promise<void> }) {
  const [stack, setStack] = useState<Route[]>([{ name: "home" }]);
  const snapshot = useLinkSnapshot();
  const palette = usePalette();

  const navigation = useMemo<Navigation>(
    () => ({
      push: (route) => setStack((current) => [...current, route]),
      replace: (route) => setStack((current) => [...current.slice(0, -1), route]),
      back: () => setStack((current) => (current.length > 1 ? current.slice(0, -1) : current)),
    }),
    [],
  );

  const depth = stack.length;
  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (depth <= 1) return false;
      navigation.back();
      return true;
    });
    return () => subscription.remove();
  }, [depth, navigation]);

  if (snapshot.state.kind === "blocked") {
    const message = snapshot.state.message;
    return (
      <View style={{ flex: 1, backgroundColor: palette.canvas }}>
        <Header title={snapshot.pairing.desktopName} subtitle="Not paired" />
        <EmptyState
          title="Pair this phone again"
          message={message}
          action={{ label: "Pair again", variant: "primary", onPress: () => void onForget(message) }}
        />
      </View>
    );
  }

  const route = stack[stack.length - 1] ?? { name: "home" };
  return (
    <NavigationContext.Provider value={navigation}>
      <Screen route={route} onForget={onForget} />
    </NavigationContext.Provider>
  );
}

function Screen({ route, onForget }: { route: Route; onForget: () => Promise<void> }) {
  switch (route.name) {
    case "home":
      return <HomeScreen />;
    case "agent":
      return <AgentScreen key={route.threadId} threadId={route.threadId} />;
    case "start":
      return <StartAgentScreen {...(route.projectId ? { projectId: route.projectId } : {})} />;
    case "terminal":
      return <TerminalScreen key={route.terminalId} terminalId={route.terminalId} />;
    case "settings":
      return <SettingsScreen onForget={onForget} />;
  }
}
