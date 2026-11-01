import { type HostOs, type MobileFileSystem, pathFor } from "../../host.js";
import { findAppDir } from "../doctor/readProject.js";

/** What the open URL needs from the app: whether it is a development build, and its link scheme. */
export type ProjectInfo = {
  readonly devClient: boolean;
  readonly scheme?: string;
  /** The app's folder, relative to the worktree root, "." for the root itself. */
  readonly appDir?: string;
};

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]{0,99}$/u;

/**
 * Reads the app the project check finds in a worktree. It reads package.json, app.json, and a static
 * app.config.json, and never runs app.config.js.
 */
export async function readProjectInfo(root: string, fs: MobileFileSystem, os: HostOs): Promise<ProjectInfo> {
  const appDir = await findAppDir(fs, root, os);
  if (appDir === undefined) return { devClient: false };
  const path = pathFor(os);
  const dir = appDir === "." ? root : path.join(root, ...appDir.split("/"));
  const pkg = await readJson(fs, path.join(dir, "package.json"));
  const deps = { ...record(pkg?.dependencies), ...record(pkg?.devDependencies) };
  const scheme = await readScheme(fs, dir, os);
  return { devClient: "expo-dev-client" in deps, ...(scheme ? { scheme } : {}), appDir };
}
async function readScheme(fs: MobileFileSystem, dir: string, os: HostOs): Promise<string | undefined> {
  for (const file of ["app.json", "app.config.json"]) {
    const json = await readJson(fs, pathFor(os).join(dir, file));
    if (!json) continue;
    const config = record(json.expo ?? json);
    const raw = Array.isArray(config.scheme) ? config.scheme[0] : config.scheme;
    if (typeof raw === "string" && SCHEME.test(raw)) return raw;
  }
  return undefined;
}

async function readJson(fs: MobileFileSystem, file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
