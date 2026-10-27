import { describe, expect, it } from "vitest";

import { detectApps, launchCommand, type OpenInEnvironment } from "./OpenInApps.js";

function environment(
  platform: OpenInEnvironment["platform"],
  files: readonly string[],
  env: Record<string, string> = {},
): OpenInEnvironment {
  const present = new Set(files);
  return {
    platform,
    env,
    macRoots: ["/Applications", "/System/Applications"],
    exists: async (path) => present.has(path),
    list: async (folder) => {
      const prefix = `${folder}\\`;
      const names = new Set<string>();
      for (const file of present) {
        if (file.startsWith(prefix)) names.add(file.slice(prefix.length).split("\\")[0] ?? "");
      }
      return [...names];
    },
  };
}

describe("detectApps", () => {
  it("finds macOS app bundles and always offers Finder last", async () => {
    const apps = await detectApps(
      environment("darwin", [
        "/Applications/Visual Studio Code.app",
        "/Applications/Codex.app",
        "/System/Applications/Utilities/Terminal.app",
      ]),
    );
    expect(apps.map((app) => [app.id, app.kind, app.executable])).toEqual([
      ["vscode", "editor", "/Applications/Visual Studio Code.app"],
      ["codex", "agent", "/Applications/Codex.app"],
      ["terminal", "terminal", "/System/Applications/Utilities/Terminal.app"],
      ["files", "files", "/System/Library/CoreServices/Finder.app"],
    ]);
    expect(apps.at(-1)?.name).toBe("Finder");
  });

  it("expands Windows folders, picks the newest versioned folder, and ignores .cmd shims on PATH", async () => {
    const apps = await detectApps(
      environment(
        "win32",
        [
          "C:\\Users\\me\\AppData\\Local\\Programs\\cursor\\Cursor.exe",
          "C:\\Program Files\\JetBrains\\WebStorm 2024.3\\bin\\webstorm64.exe",
          "C:\\Program Files\\JetBrains\\WebStorm 2025.2\\bin\\webstorm64.exe",
          "C:\\Tools\\zed.exe",
          "C:\\Shims\\code.cmd",
        ],
        {
          LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
          ProgramFiles: "C:\\Program Files",
          SystemRoot: "C:\\Windows",
          Path: "C:\\Shims;C:\\Tools\\",
        },
      ),
    );
    expect(apps.map((app) => [app.id, app.executable])).toEqual([
      ["cursor", "C:\\Users\\me\\AppData\\Local\\Programs\\cursor\\Cursor.exe"],
      ["zed", "C:\\Tools\\zed.exe"],
      ["webstorm", "C:\\Program Files\\JetBrains\\WebStorm 2025.2\\bin\\webstorm64.exe"],
      ["files", "C:\\Windows\\explorer.exe"],
    ]);
  });

  it("finds Linux commands on PATH", async () => {
    const apps = await detectApps(
      environment("linux", ["/usr/bin/code", "/snap/bin/zed", "/usr/bin/gnome-terminal"], {
        PATH: "/usr/local/bin:/usr/bin:/snap/bin",
      }),
    );
    expect(apps.map((app) => app.id)).toEqual(["vscode", "zed", "gnome-terminal", "files"]);
  });
});

describe("launchCommand", () => {
  it("opens macOS apps with open -a and other platforms with the app's own arguments", async () => {
    const [mac] = await detectApps(environment("darwin", ["/Applications/Cursor.app"]));
    expect(mac && launchCommand(mac, "/work/app", "darwin")).toEqual({
      command: "open",
      args: ["-a", "/Applications/Cursor.app", "/work/app"],
    });

    const linux = await detectApps(environment("linux", ["/usr/bin/konsole"], { PATH: "/usr/bin" }));
    const konsole = linux.find((app) => app.id === "konsole");
    expect(konsole && launchCommand(konsole, "/work/app", "linux")).toEqual({
      command: "/usr/bin/konsole",
      args: ["--workdir", "/work/app"],
    });

    const files = linux.find((app) => app.kind === "files");
    expect(files && launchCommand(files, "/work/app", "linux")).toBeUndefined();
  });
});
