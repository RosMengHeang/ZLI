/**
 * Unsent text by message box, kept across switching chats and restarting the app. It lives in this browser's
 * storage only; when that is blocked, as in a private window, drafts last until the app closes.
 */
const STORAGE_KEY = "zli.drafts";
/** The most drafts kept: the oldest go first. */
const LIMIT = 50;
/** The longest draft kept, so storage never fills with a pasted log. */
const MAX_CHARS = 20_000;

let drafts: Map<string, string> | undefined;

function load(): Map<string, string> {
  if (drafts) return drafts;
  drafts = new Map();
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) ?? "[]") as unknown;
    if (Array.isArray(saved))
      for (const entry of saved)
        if (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string")
          drafts.set(entry[0], entry[1]);
  } catch {
    // Unreadable or blocked storage: start empty.
  }
  return drafts;
}

function save(map: Map<string, string>): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify([...map]));
  } catch {
    // Full or blocked storage: the draft still lives in memory.
  }
}

export function readDraft(key: string): string {
  return load().get(key) ?? "";
}

export function writeDraft(key: string, text: string): void {
  const map = load();
  if (map.get(key) === (text || undefined)) return;
  map.delete(key);
  if (text) map.set(key, text.slice(0, MAX_CHARS));
  while (map.size > LIMIT) map.delete(map.keys().next().value as string);
  save(map);
}

/**
 * Moves a draft to a new key, as when a chat's session id arrives after its first message. The text in the
 * box wins; the old key is dropped only when it still holds that same text, so another chat's draft is safe.
 */
export function moveDraft(from: string, to: string, text: string): void {
  if (from === to) return;
  if (readDraft(from) === text) writeDraft(from, "");
  writeDraft(to, text);
}

/** Forgets every draft in memory, so tests start clean. */
export function resetDraftsForTests(): void {
  drafts = undefined;
}
