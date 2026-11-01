import type { MobilePackageVerdict, MobileProjectFacts, MobileProposalAction } from "@zli-v2/contracts";

import type { DirectoryEntry } from "./directory.js";

export const UNCHECKED_REASON = "React Native Directory could not be reached; this package was not checked.";

/** The guard rules for one package, from React Native Directory's entry and the doctor's facts about the app. */
export function verdictFor(
  name: string,
  entry: DirectoryEntry | undefined,
  facts: MobileProjectFacts | undefined,
): MobilePackageVerdict {
  if (!entry) return { name, verdict: "unchecked", reasons: [UNCHECKED_REASON] };
  if (!entry.found)
    return {
      name,
      verdict: "warn",
      reasons: ["React Native Directory does not list it. Check that it works with React Native before you add it."],
    };
  let level = 0;
  const reasons: string[] = [];
  const raise = (to: 1 | 2, reason: string) => {
    level = Math.max(level, to);
    reasons.push(reason);
  };
  const archOn = facts?.newArch?.enabled;
  switch (entry.newArchitecture) {
    case "supported":
      reasons.push("Supports the New Architecture.");
      break;
    case "untested":
      if (archOn === true) raise(2, "It is not tested with the New Architecture, which this project uses.");
      else if (archOn === undefined) raise(1, "It is not tested with the New Architecture.");
      break;
    case "unsupported":
      if (archOn === true) raise(2, "It does not support the New Architecture, which this project uses.");
      else if (archOn === undefined) raise(1, "It does not support the New Architecture.");
      break;
    case "new-arch-only":
      if (archOn === false) raise(2, "It needs the New Architecture, which this project has turned off.");
      else reasons.push("Works only with the New Architecture.");
      break;
  }
  if (entry.unmaintained) raise(1, "React Native Directory marks it unmaintained. Look for a maintained alternative.");
  if (entry.archived) raise(1, "Its GitHub repository is archived.");
  if (entry.expoGo === false && facts?.client?.kind === "expo-go")
    raise(1, "It does not run in Expo Go, so the app needs a development build.");
  if (entry.configPlugin && facts?.stack === "expo")
    reasons.push("It has a config plugin. Add it to plugins in app.json and rebuild.");
  return {
    name,
    verdict: level === 2 ? "block" : level === 1 ? "warn" : "ok",
    reasons: reasons.slice(0, 10),
    ...(entry.newArchitecture ? { newArchitecture: entry.newArchitecture } : {}),
    ...(entry.expoGo !== undefined ? { expoGo: entry.expoGo } : {}),
    ...(entry.configPlugin !== undefined ? { configPlugin: entry.configPlugin } : {}),
    ...(entry.unmaintained ? { unmaintained: true } : {}),
    ...(entry.latest ? { latest: entry.latest } : {}),
  };
}

/**
 * The command that installs these packages: npx expo install in Expo apps, so Expo picks versions that match the
 * SDK, otherwise the lockfile's package manager. Undefined when the app does not use npm packages.
 */
export function installAction(
  names: readonly string[],
  facts: MobileProjectFacts | undefined,
): MobileProposalAction | undefined {
  if (names.length === 0 || !facts || (facts.stack !== "expo" && facts.stack !== "react-native")) return undefined;
  const cwd = facts.appDir;
  if (facts.stack === "expo") return { kind: "command", program: "npx", args: ["expo", "install", ...names], cwd };
  switch (facts.packageManager) {
    case "pnpm":
      return { kind: "command", program: "pnpm", args: ["add", ...names], cwd };
    case "yarn":
      return { kind: "command", program: "yarn", args: ["add", ...names], cwd };
    case "bun":
      return { kind: "command", program: "bun", args: ["add", ...names], cwd };
    default:
      return { kind: "command", program: "npm", args: ["install", ...names], cwd };
  }
}
