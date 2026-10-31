import { constants } from "node:fs";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { posix, win32 } from "node:path";

/** The read-only file access SDK detection needs, injectable for tests. */
export type MobileFileSystem = {
  exists(path: string): Promise<boolean>;
  isDirectory(path: string): Promise<boolean>;
  readdir(path: string): Promise<string[]>;
  readFile(path: string): Promise<string>;
};

export const nodeMobileFileSystem: MobileFileSystem = {
  exists: async (path) => {
    try {
      await access(path, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  },
  isDirectory: async (path) => {
    try {
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  },
  readdir: async (path) => {
    try {
      return await readdir(path);
    } catch {
      return [];
    }
  },
  readFile: (path) => readFile(path, "utf8"),
};

export type HostOs = "linux" | "macos" | "windows";
export type HostArch = "x64" | "arm64";

export function hostOs(platform: NodeJS.Platform = process.platform): HostOs {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  return "linux";
}

export function hostArch(arch: string = process.arch): HostArch {
  return arch === "arm64" ? "arm64" : "x64";
}

export function executableName(name: string, os: HostOs, windowsExtension = ".exe"): string {
  return os === "windows" ? `${name}${windowsExtension}` : name;
}

/** The first match for `name` on PATH, trying Windows executable extensions. */
export async function findOnPath(
  name: string,
  env: NodeJS.ProcessEnv,
  os: HostOs,
  fs: MobileFileSystem,
): Promise<string | undefined> {
  const pathValue = Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
  const separator = os === "windows" ? ";" : ":";
  const extensions = os === "windows" ? [".exe", ".bat", ".cmd"] : [""];
  for (const dir of pathValue.split(separator)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = pathFor(os).join(dir, `${name}${extension}`);
      if (await fs.exists(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Path rules for the host being described, which in tests is not always the one running them. */
export function pathFor(os: HostOs): typeof posix {
  return os === "windows" ? win32 : posix;
}
