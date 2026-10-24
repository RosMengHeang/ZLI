import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type BrowserToolPaths = {
  /** The endpoint file BrowserControlServer writes. */
  readonly controlFile: string;
  /** The Electron executable, run with ELECTRON_RUN_AS_NODE=1. */
  readonly command: string;
  /** The bundled zli-browser.js script. */
  readonly script: string;
  /** The bundled zli.js agent tool script. */
  readonly agentScript: string;
  /** The bundled zli-connect.js MCP sign-in bridge script. */
  readonly connectScript: string;
  readonly shimDir: string;
};

/** Environment for the runtime server, which hands it to agent processes. */
export function browserToolEnvironment(paths: BrowserToolPaths): Record<string, string> {
  return {
    ZLI_BROWSER_CONTROL_FILE: paths.controlFile,
    ZLI_BROWSER_TOOL_COMMAND: paths.command,
    ZLI_BROWSER_TOOL_SCRIPT: paths.script,
    ZLI_AGENT_TOOL_SCRIPT: paths.agentScript,
    ZLI_CONNECT_TOOL_SCRIPT: paths.connectScript,
    ZLI_BROWSER_SHIM_DIR: paths.shimDir,
  };
}

export function browserToolShims(
  paths: Pick<BrowserToolPaths, "command" | "script" | "agentScript">,
  platform: NodeJS.Platform = process.platform,
): Array<{ name: string; content: string; executable: boolean }> {
  return [
    ...toolShims("zli-browser", paths.command, paths.script, platform),
    ...toolShims("zli", paths.command, paths.agentScript, platform),
  ];
}

function toolShims(
  name: string,
  command: string,
  script: string,
  platform: NodeJS.Platform,
): Array<{ name: string; content: string; executable: boolean }> {
  const posixPath = (value: string) => (platform === "win32" ? value.replaceAll("\\", "/") : value);
  const shell = [
    "#!/bin/sh",
    `ELECTRON_RUN_AS_NODE=1 exec ${shellQuote(posixPath(command))} ${shellQuote(posixPath(script))} "$@"`,
    "",
  ].join("\n");
  const shims = [{ name, content: shell, executable: true }];
  if (platform === "win32") {
    shims.push({
      name: `${name}.cmd`,
      content: [
        "@echo off",
        "setlocal",
        "set ELECTRON_RUN_AS_NODE=1",
        `"${command}" "${script}" %*`,
        "exit /b %ERRORLEVEL%",
        "",
      ].join("\r\n"),
      executable: false,
    });
  }
  return shims;
}

/** Writes the shims, touching only files whose content changed. Returns the paths written. */
export async function writeBrowserToolShims(
  paths: BrowserToolPaths,
  platform: NodeJS.Platform = process.platform,
): Promise<string[]> {
  await mkdir(paths.shimDir, { recursive: true });
  const written: string[] = [];
  for (const shim of browserToolShims(paths, platform)) {
    const target = join(paths.shimDir, shim.name);
    const existing = await readFile(target, "utf8").catch(() => undefined);
    if (existing === shim.content) continue;
    await writeFile(target, shim.content, { encoding: "utf8", mode: shim.executable ? 0o755 : 0o644 });
    if (shim.executable && platform !== "win32") await chmod(target, 0o755);
    written.push(target);
  }
  return written;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
