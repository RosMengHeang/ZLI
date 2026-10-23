import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { browserToolEnvironment, browserToolShims, writeBrowserToolShims } from "./BrowserToolShim.js";

describe("zli-browser shims", () => {
  const paths = {
    controlFile: "C:\\Users\\me\\AppData\\Roaming\\ZLI\\browser-control.json",
    command: "C:\\Program Files\\ZLI\\ZLI.exe",
    script: "C:\\Program Files\\ZLI\\resources\\app.asar\\dist\\zli-browser.js",
    agentScript: "C:\\Program Files\\ZLI\\resources\\app.asar\\dist\\zli.js",
    shimDir: "C:\\Users\\me\\AppData\\Roaming\\ZLI\\bin",
  };

  it("hands the server every path agents need", () => {
    expect(browserToolEnvironment(paths)).toEqual({
      ZLI_BROWSER_CONTROL_FILE: paths.controlFile,
      ZLI_BROWSER_TOOL_COMMAND: paths.command,
      ZLI_BROWSER_TOOL_SCRIPT: paths.script,
      ZLI_AGENT_TOOL_SCRIPT: paths.agentScript,
      ZLI_BROWSER_SHIM_DIR: paths.shimDir,
    });
  });

  it("runs Electron as Node from cmd and from Git Bash on Windows", () => {
    const shims = browserToolShims(paths, "win32");
    expect(shims.map((shim) => shim.name)).toEqual(["zli-browser", "zli-browser.cmd", "zli", "zli.cmd"]);
    expect(shims[0]?.content).toBe(
      "#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec 'C:/Program Files/ZLI/ZLI.exe' 'C:/Program Files/ZLI/resources/app.asar/dist/zli-browser.js' \"$@\"\n",
    );
    expect(shims[1]?.content).toContain("set ELECTRON_RUN_AS_NODE=1\r\n");
    expect(shims[1]?.content).toContain(`"${paths.command}" "${paths.script}" %*`);
    expect(shims[3]?.content).toContain(`"${paths.command}" "${paths.agentScript}" %*`);
  });

  it("quotes POSIX paths and writes only files whose content changed", async () => {
    const shimDir = await mkdtemp(join(tmpdir(), "zli-shim-"));
    try {
      const posixPaths = {
        ...paths,
        command: "/opt/ZLI's/zli",
        script: "/opt/zli/zli-browser.js",
        agentScript: "/opt/zli/zli.js",
        shimDir,
      };
      expect(browserToolShims(posixPaths, "linux").map((shim) => shim.name)).toEqual(["zli-browser", "zli"]);
      expect(browserToolShims(posixPaths, "linux")[0]?.content).toContain("'/opt/ZLI'\\''s/zli'");
      const first = await writeBrowserToolShims(posixPaths, "linux");
      expect(first).toEqual([join(shimDir, "zli-browser"), join(shimDir, "zli")]);
      expect(await readFile(join(shimDir, "zli-browser"), "utf8")).toContain("ELECTRON_RUN_AS_NODE=1 exec");
      expect(await writeBrowserToolShims(posixPaths, "linux")).toEqual([]);
    } finally {
      await rm(shimDir, { recursive: true, force: true });
    }
  });
});
