import { useEffect, useSyncExternalStore } from "react";

import { type Dispatch, listFiles, readFileData } from "../files/fileClient.js";

/**
 * A project's own icon: the favicon or app icon in its files, found once and remembered, so the sidebar can show
 * a web app's or a mobile app's real mark instead of a folder.
 */

/** Names an app's icon goes by. */
const ICON_NAME =
  /^(favicon|icon|app-icon|appicon|apple-touch-icon|logo|logo-icon|logo-mark|mark)\.(svg|png|ico|webp)$/iu;
/** Folders where those icons live in web, desktop and mobile projects, at the top or in a monorepo's app. */
const ICON_DIR =
  /^([^/]+\/[^/]+\/)?(public|static|app|src\/app|assets|assets\/images|src\/assets|resources|build|icons|src-tauri\/icons|res\/mipmap-[a-z]+|images)$/iu;
/** Copies that are not the app's own: dependencies, tests, docs and generated output. */
const NOT_THE_APP =
  /(^|\/)(node_modules|vendor|test|tests|__tests__|fixtures|examples?|docs?|dist|out|coverage|\.next|\.git)(\/|$)/iu;
/** Larger files are pictures, not icons. */
const MAX_ICON_BYTES = 256 * 1024;

const nameRank: Record<string, number> = {
  favicon: 0,
  icon: 1,
  "app-icon": 1,
  appicon: 1,
  "apple-touch-icon": 2,
  "logo-mark": 3,
  "logo-icon": 3,
  mark: 4,
  logo: 5,
};
const typeRank: Record<string, number> = { svg: 0, png: 1, webp: 2, ico: 3 };

/** The best icon among a project's files, or undefined when it has none. */
export function pickProjectIcon(files: readonly { path: string; size?: number | undefined }[]): string | undefined {
  let best: { path: string; score: number } | undefined;
  for (const file of files) {
    if (file.size !== undefined && (file.size === 0 || file.size > MAX_ICON_BYTES)) continue;
    if (NOT_THE_APP.test(file.path)) continue;
    const slash = file.path.lastIndexOf("/");
    const name = file.path.slice(slash + 1);
    const match = ICON_NAME.exec(name);
    if (!match) continue;
    const dir = slash < 0 ? "" : file.path.slice(0, slash);
    const depth = dir === "" ? 0 : dir.split("/").length;
    // A root file or one in a known icon folder; anything else must sit near the top.
    const known = dir === "" || ICON_DIR.test(dir);
    if (!known && depth > 2) continue;
    const stem = (match[1] ?? "").toLowerCase();
    const type = (match[2] ?? "").toLowerCase();
    const score = (nameRank[stem] ?? 6) * 10 + (typeRank[type] ?? 4) + depth * 3 + (known ? 0 : 20);
    if (!best || score < best.score || (score === best.score && file.path < best.path))
      best = { path: file.path, score };
  }
  return best?.path;
}

type Entry = { icon: string | undefined; checked: boolean };

const STORAGE_KEY = "zli.projectIcons";
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
const looking = new Set<string>();

function loadStored(): void {
  if (entries.size > 0) return;
  try {
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, string | null>;
    for (const [projectId, icon] of Object.entries(stored))
      entries.set(projectId, {
        icon: typeof icon === "string" && icon.startsWith("data:image/") ? icon : undefined,
        checked: false,
      });
  } catch {
    // Nothing stored, or storage is blocked: look again.
  }
}

function store(): void {
  try {
    const stored: Record<string, string | null> = {};
    for (const [projectId, entry] of entries) stored[projectId] = entry.icon ?? null;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // Full or blocked storage: the icons last until the window closes.
  }
}

function set(projectId: string, entry: Entry): void {
  entries.set(projectId, entry);
  store();
  for (const listener of listeners) listener();
}

/** Looks through the project's files once per session, keeping what it found last time until then. */
async function lookUp(dispatch: Dispatch, projectId: string, worktreeId: string): Promise<void> {
  if (looking.has(projectId) || entries.get(projectId)?.checked) return;
  looking.add(projectId);
  try {
    const { files } = await listFiles(dispatch, worktreeId);
    const path = pickProjectIcon(files);
    if (!path) {
      set(projectId, { icon: undefined, checked: true });
      return;
    }
    const data = await readFileData(dispatch, worktreeId, path);
    set(projectId, { icon: `data:${data.mimeType};base64,${data.dataBase64}`, checked: true });
  } catch {
    // The runtime could not list or read the files; keep what was there and try again next session.
    const previous = entries.get(projectId);
    entries.set(projectId, { icon: previous?.icon, checked: true });
  } finally {
    looking.delete(projectId);
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The project's icon as a data URL, or undefined while none is known. */
export function useProjectIcon(
  dispatch: Dispatch,
  projectId: string,
  worktreeId: string | undefined,
): string | undefined {
  loadStored();
  const icon = useSyncExternalStore(subscribe, () => entries.get(projectId)?.icon);
  useEffect(() => {
    if (worktreeId) void lookUp(dispatch, projectId, worktreeId);
  }, [dispatch, projectId, worktreeId]);
  return icon;
}

/** Forgets every icon, for tests. */
export function resetProjectIcons(): void {
  entries.clear();
  looking.clear();
}
