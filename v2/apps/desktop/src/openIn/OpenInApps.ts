import { spawn } from "node:child_process";
import { access, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { OpenInApp, OpenInKind } from "@zli-v2/contracts";

type Platform = "darwin" | "win32" | "linux";

/** One app ZLI knows how to find. Each platform lists where to look; an app with none is skipped there. */
type Candidate = {
  id: string;
  name: string;
  kind: OpenInKind;
  /** Bundle paths under /Applications, ~/Applications, or /System/Applications. */
  mac?: string[];
  /** Absolute paths with %VAR% placeholders. A segment with * matches the first folder that fits. */
  windows?: string[];
  /** Executable names searched on PATH. On Windows `.exe` is added. */
  commands?: string[];
  /** Arguments for the folder; the folder itself by default. Ignored on macOS, where `open -a` takes it. */
  args?: (folder: string) => string[];
};

const CANDIDATES: readonly Candidate[] = [
  {
    id: "vscode",
    name: "VS Code",
    kind: "editor",
    mac: ["Visual Studio Code.app"],
    windows: ["%LOCALAPPDATA%\\Programs\\Microsoft VS Code\\Code.exe", "%ProgramFiles%\\Microsoft VS Code\\Code.exe"],
    commands: ["code"],
  },
  {
    id: "vscode-insiders",
    name: "VS Code Insiders",
    kind: "editor",
    mac: ["Visual Studio Code - Insiders.app"],
    windows: [
      "%LOCALAPPDATA%\\Programs\\Microsoft VS Code Insiders\\Code - Insiders.exe",
      "%ProgramFiles%\\Microsoft VS Code Insiders\\Code - Insiders.exe",
    ],
    commands: ["code-insiders"],
  },
  {
    id: "cursor",
    name: "Cursor",
    kind: "editor",
    mac: ["Cursor.app"],
    windows: ["%LOCALAPPDATA%\\Programs\\cursor\\Cursor.exe"],
    commands: ["cursor"],
  },
  {
    id: "windsurf",
    name: "Windsurf",
    kind: "editor",
    mac: ["Windsurf.app"],
    windows: ["%LOCALAPPDATA%\\Programs\\Windsurf\\Windsurf.exe"],
    commands: ["windsurf"],
  },
  {
    id: "antigravity",
    name: "Antigravity",
    kind: "editor",
    mac: ["Antigravity.app"],
    windows: ["%LOCALAPPDATA%\\Programs\\Antigravity\\Antigravity.exe"],
    commands: ["antigravity"],
  },
  {
    id: "kiro",
    name: "Kiro",
    kind: "editor",
    mac: ["Kiro.app"],
    windows: ["%LOCALAPPDATA%\\Programs\\Kiro\\Kiro.exe"],
    commands: ["kiro"],
  },
  {
    id: "zed",
    name: "Zed",
    kind: "editor",
    mac: ["Zed.app"],
    windows: ["%LOCALAPPDATA%\\Programs\\Zed\\Zed.exe"],
    commands: ["zed", "zeditor"],
  },
  {
    id: "vscodium",
    name: "VSCodium",
    kind: "editor",
    mac: ["VSCodium.app"],
    windows: ["%LOCALAPPDATA%\\Programs\\VSCodium\\VSCodium.exe", "%ProgramFiles%\\VSCodium\\VSCodium.exe"],
    commands: ["codium"],
  },
  {
    id: "sublime",
    name: "Sublime Text",
    kind: "editor",
    mac: ["Sublime Text.app"],
    windows: ["%ProgramFiles%\\Sublime Text\\sublime_text.exe", "%ProgramFiles%\\Sublime Text 3\\sublime_text.exe"],
    commands: ["subl"],
  },
  {
    id: "intellij",
    name: "IntelliJ IDEA",
    kind: "editor",
    mac: ["IntelliJ IDEA.app", "IntelliJ IDEA Ultimate.app", "IntelliJ IDEA CE.app"],
    windows: [
      "%LOCALAPPDATA%\\Programs\\IntelliJ IDEA Ultimate\\bin\\idea64.exe",
      "%LOCALAPPDATA%\\Programs\\IntelliJ IDEA Community Edition\\bin\\idea64.exe",
      "%ProgramFiles%\\JetBrains\\IntelliJ IDEA*\\bin\\idea64.exe",
    ],
    commands: ["idea"],
  },
  {
    id: "webstorm",
    name: "WebStorm",
    kind: "editor",
    mac: ["WebStorm.app"],
    windows: [
      "%LOCALAPPDATA%\\Programs\\WebStorm\\bin\\webstorm64.exe",
      "%ProgramFiles%\\JetBrains\\WebStorm*\\bin\\webstorm64.exe",
    ],
    commands: ["webstorm"],
  },
  {
    id: "pycharm",
    name: "PyCharm",
    kind: "editor",
    mac: ["PyCharm.app", "PyCharm CE.app", "PyCharm Professional Edition.app"],
    windows: [
      "%LOCALAPPDATA%\\Programs\\PyCharm*\\bin\\pycharm64.exe",
      "%ProgramFiles%\\JetBrains\\PyCharm*\\bin\\pycharm64.exe",
    ],
    commands: ["pycharm"],
  },
  {
    id: "goland",
    name: "GoLand",
    kind: "editor",
    mac: ["GoLand.app"],
    windows: [
      "%LOCALAPPDATA%\\Programs\\GoLand\\bin\\goland64.exe",
      "%ProgramFiles%\\JetBrains\\GoLand*\\bin\\goland64.exe",
    ],
    commands: ["goland"],
  },
  {
    id: "rider",
    name: "Rider",
    kind: "editor",
    mac: ["Rider.app"],
    windows: [
      "%LOCALAPPDATA%\\Programs\\Rider\\bin\\rider64.exe",
      "%ProgramFiles%\\JetBrains\\JetBrains Rider*\\bin\\rider64.exe",
    ],
    commands: ["rider"],
  },
  {
    id: "android-studio",
    name: "Android Studio",
    kind: "editor",
    mac: ["Android Studio.app"],
    windows: ["%ProgramFiles%\\Android\\Android Studio\\bin\\studio64.exe"],
    commands: ["studio", "android-studio"],
  },
  { id: "xcode", name: "Xcode", kind: "editor", mac: ["Xcode.app"] },
  {
    id: "codex",
    name: "Codex",
    kind: "agent",
    mac: ["Codex.app"],
    windows: ["%LOCALAPPDATA%\\Programs\\Codex\\Codex.exe"],
  },
  {
    id: "claude",
    name: "Claude",
    kind: "agent",
    mac: ["Claude.app"],
    windows: ["%LOCALAPPDATA%\\AnthropicClaude\\claude.exe"],
  },
  { id: "terminal", name: "Terminal", kind: "terminal", mac: ["Utilities/Terminal.app"] },
  { id: "iterm", name: "iTerm", kind: "terminal", mac: ["iTerm.app"] },
  { id: "ghostty", name: "Ghostty", kind: "terminal", mac: ["Ghostty.app"], commands: ["ghostty"], args: () => [] },
  { id: "warp", name: "Warp", kind: "terminal", mac: ["Warp.app"] },
  {
    id: "windows-terminal",
    name: "Windows Terminal",
    kind: "terminal",
    windows: ["%LOCALAPPDATA%\\Microsoft\\WindowsApps\\wt.exe"],
    args: (folder) => ["-d", folder],
  },
  {
    id: "gnome-terminal",
    name: "Terminal",
    kind: "terminal",
    commands: ["gnome-terminal"],
    args: (folder) => [`--working-directory=${folder}`],
  },
  { id: "konsole", name: "Konsole", kind: "terminal", commands: ["konsole"], args: (folder) => ["--workdir", folder] },
];

const MAC_ROOTS = ["/Applications", join(homedir(), "Applications"), "/System/Applications"];

export type OpenInEnvironment = {
  platform: Platform;
  env: Record<string, string | undefined>;
  exists(path: string): Promise<boolean>;
  list(folder: string): Promise<string[]>;
  macRoots?: readonly string[];
};

/** An installed app and how to start it. */
export type ResolvedApp = OpenInApp & { executable: string; args: (folder: string) => string[] };

const FILE_MANAGERS: Record<Platform, { name: string; executable: string }> = {
  darwin: { name: "Finder", executable: "/System/Library/CoreServices/Finder.app" },
  win32: { name: "File Explorer", executable: "%SystemRoot%\\explorer.exe" },
  linux: { name: "Files", executable: "" },
};

export function nodeEnvironment(): OpenInEnvironment {
  const platform = process.platform === "darwin" || process.platform === "win32" ? process.platform : "linux";
  return {
    platform,
    env: process.env,
    exists: async (path) => {
      try {
        await access(path);
        return true;
      } catch {
        return false;
      }
    },
    list: async (folder) => {
      try {
        return (await readdir(folder, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((e) => e.name);
      } catch {
        return [];
      }
    },
  };
}

/** The apps found on this computer, in catalog order, with the file manager last. */
export async function detectApps(environment: OpenInEnvironment): Promise<ResolvedApp[]> {
  const found = await Promise.all(CANDIDATES.map((candidate) => resolveCandidate(candidate, environment)));
  const apps = found.filter((app): app is ResolvedApp => app !== undefined);
  const fileManager = FILE_MANAGERS[environment.platform];
  apps.push({
    id: "files",
    name: fileManager.name,
    kind: "files",
    executable: expandVariables(fileManager.executable, environment.env) ?? "",
    args: (folder) => [folder],
  });
  return apps;
}

async function resolveCandidate(
  candidate: Candidate,
  environment: OpenInEnvironment,
): Promise<ResolvedApp | undefined> {
  const executable = await findExecutable(candidate, environment);
  if (!executable) return undefined;
  return {
    id: candidate.id,
    name: candidate.name,
    kind: candidate.kind,
    executable,
    args: candidate.args ?? ((folder) => [folder]),
  };
}

async function findExecutable(candidate: Candidate, environment: OpenInEnvironment): Promise<string | undefined> {
  if (environment.platform === "darwin") {
    for (const bundle of candidate.mac ?? []) {
      for (const root of environment.macRoots ?? MAC_ROOTS) {
        const path = `${root}/${bundle}`;
        if (await environment.exists(path)) return path;
      }
    }
    return undefined;
  }
  if (environment.platform === "win32") {
    for (const template of candidate.windows ?? []) {
      const path = await matchWindowsPath(template, environment);
      if (path) return path;
    }
  }
  for (const command of candidate.commands ?? []) {
    const path = await onPath(command, environment);
    if (path) return path;
  }
  return undefined;
}

function expandVariables(template: string, env: Record<string, string | undefined>): string | undefined {
  let missing = false;
  const expanded = template.replace(/%([^%]+)%/gu, (_match, name: string) => {
    const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    const value = key ? env[key] : undefined;
    if (!value) missing = true;
    return value ?? "";
  });
  return missing ? undefined : expanded;
}

async function matchWindowsPath(template: string, environment: OpenInEnvironment): Promise<string | undefined> {
  const expanded = expandVariables(template, environment.env);
  if (!expanded) return undefined;
  const segments = expanded.split("\\");
  let current = segments[0] ?? "";
  for (const segment of segments.slice(1)) {
    if (!segment.includes("*")) {
      current = `${current}\\${segment}`;
      continue;
    }
    const [prefix = "", suffix = ""] = segment.split("*");
    // Versioned folders such as "IntelliJ IDEA 2025.2" sort so the newest comes last.
    const match = (await environment.list(current))
      .filter(
        (name) =>
          name.toLowerCase().startsWith(prefix.toLowerCase()) && name.toLowerCase().endsWith(suffix.toLowerCase()),
      )
      .sort()
      .at(-1);
    if (!match) return undefined;
    current = `${current}\\${match}`;
  }
  return (await environment.exists(current)) ? current : undefined;
}

async function onPath(command: string, environment: OpenInEnvironment): Promise<string | undefined> {
  const pathKey = Object.keys(environment.env).find((key) => key.toLowerCase() === "path");
  const folders = (pathKey ? (environment.env[pathKey] ?? "") : "").split(environment.platform === "win32" ? ";" : ":");
  // On Windows only real executables count: a .cmd shim needs a shell, which would also run whatever is in the folder name.
  const file = environment.platform === "win32" ? `${command}.exe` : command;
  for (const folder of folders) {
    if (!folder) continue;
    const path =
      environment.platform === "win32"
        ? `${folder.replace(/\\+$/u, "")}\\${file}`
        : `${folder.replace(/\/+$/u, "")}/${file}`;
    if (await environment.exists(path)) return path;
  }
  return undefined;
}

/** The program and arguments that open `folder` in `app`. Undefined means the system file manager opens it. */
export function launchCommand(
  app: ResolvedApp,
  folder: string,
  platform: Platform,
): { command: string; args: string[] } | undefined {
  if (app.kind === "files") return undefined;
  if (platform === "darwin") return { command: "open", args: ["-a", app.executable, folder] };
  return { command: app.executable, args: app.args(folder) };
}

/** Starts `app` on `folder` without tying it to ZLI's lifetime. */
export function launchApp(
  app: ResolvedApp,
  folder: string,
  platform: Platform,
  openPath: (path: string) => Promise<string>,
): Promise<void> {
  const launch = launchCommand(app, folder, platform);
  if (!launch) {
    return openPath(folder).then((error) => {
      if (error) throw new Error(error);
    });
  }
  const env = { ...process.env };
  // ZLI is an Electron app; these would make another Electron editor start as plain Node or attach to this console.
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  return new Promise((resolve, reject) => {
    const child = spawn(launch.command, launch.args, { cwd: folder, env, detached: true, stdio: "ignore" });
    child.once("error", (error) => reject(new Error(`${app.name} could not start: ${error.message}`)));
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
