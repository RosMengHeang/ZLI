import type { PluginPrompt, SharedPrompt } from "@zli-v2/contracts";
import { useSyncExternalStore } from "react";

const STORAGE_KEY = "zli.prompts.v1";
const MAX_PERSONAL_PROMPTS = 200;
export const MAX_PROMPT_NAME = 80;
export const MAX_PROMPT_TEXT = 20_000;

/** Saved on this computer only. Shared prompts come from the project's zli.json. */
export type PersonalPrompt = { id: string; name: string; prompt: string };

export type SavedPrompt = {
  key: string;
  name: string;
  prompt: string;
  source: "shared" | "personal" | "plugin";
};

export function parsePersonalPrompts(raw: string | null): PersonalPrompt[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value
      .filter(
        (entry): entry is PersonalPrompt =>
          typeof entry === "object" &&
          entry !== null &&
          typeof entry.id === "string" &&
          typeof entry.name === "string" &&
          typeof entry.prompt === "string" &&
          entry.name.trim().length > 0 &&
          entry.prompt.length > 0,
      )
      .slice(0, MAX_PERSONAL_PROMPTS)
      .map(({ id, name, prompt }) => ({ id, name, prompt }));
  } catch {
    return [];
  }
}

let cache: PersonalPrompt[] | undefined;
const listeners = new Set<() => void>();

function read(): PersonalPrompt[] {
  if (cache) return cache;
  try {
    cache = parsePersonalPrompts(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    cache = [];
  }
  return cache;
}

function write(next: PersonalPrompt[]): void {
  cache = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage can be unavailable; the prompts still apply until the window closes.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    cache = undefined;
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function usePersonalPrompts(): PersonalPrompt[] {
  return useSyncExternalStore(subscribe, read, () => []);
}

/** Adds a prompt, or replaces the one with the same id. Names and text are trimmed to the stored limits. */
export function savePersonalPrompt(input: { id?: string; name: string; prompt: string }): PersonalPrompt {
  const saved: PersonalPrompt = {
    id: input.id ?? crypto.randomUUID(),
    name: input.name.trim().slice(0, MAX_PROMPT_NAME),
    prompt: input.prompt.slice(0, MAX_PROMPT_TEXT),
  };
  const current = read();
  const exists = current.some((entry) => entry.id === saved.id);
  write(
    exists
      ? current.map((entry) => (entry.id === saved.id ? saved : entry))
      : [...current, saved].slice(-MAX_PERSONAL_PROMPTS),
  );
  return saved;
}

export function deletePersonalPrompt(id: string): void {
  write(read().filter((entry) => entry.id !== id));
}

/**
 * Shared prompts first, in zli.json order, then personal ones in the order they were saved, then plugin
 * prompts named plugin:prompt as Claude Code shows them.
 */
export function combinePrompts(
  shared: readonly SharedPrompt[],
  personal: readonly PersonalPrompt[],
  plugin: readonly PluginPrompt[] = [],
): SavedPrompt[] {
  return [
    ...shared.map((entry, index) => ({
      key: `shared:${index}`,
      name: entry.name,
      prompt: entry.prompt,
      source: "shared" as const,
    })),
    ...personal.map((entry) => ({
      key: `personal:${entry.id}`,
      name: entry.name,
      prompt: entry.prompt,
      source: "personal" as const,
    })),
    ...plugin.map((entry) => ({
      key: `plugin:${entry.plugin}:${entry.name}`,
      name: `${entry.plugin}:${entry.name}`,
      prompt: entry.prompt,
      source: "plugin" as const,
    })),
  ];
}

/** Prompts whose name starts with the query come first, then names that contain it, then prompt text. */
export function matchPrompts(prompts: readonly SavedPrompt[], query: string): SavedPrompt[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...prompts];
  const rank = (entry: SavedPrompt) => {
    const name = entry.name.toLowerCase();
    if (name.startsWith(needle)) return 0;
    if (name.includes(needle)) return 1;
    if (entry.prompt.toLowerCase().includes(needle)) return 2;
    return -1;
  };
  return prompts
    .map((entry, index) => ({ entry, index, rank: rank(entry) }))
    .filter((item) => item.rank >= 0)
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((item) => item.entry);
}

/** The search text after a leading "/", while the draft is still a single word. */
export function slashQuery(draft: string): string | undefined {
  return /^\/\S*$/u.test(draft) ? draft.slice(1) : undefined;
}

/** Puts a picked prompt into a draft: a "/" search is replaced, other text keeps going on a new paragraph. */
export function insertPrompt(draft: string, prompt: string): string {
  if (slashQuery(draft) !== undefined || draft.trim().length === 0) return prompt;
  return `${draft.replace(/\s+$/u, "")}\n\n${prompt}`;
}

export type ManagerRequest = { projectId?: string | undefined; draft?: string | undefined };
const managerListeners = new Set<(request: ManagerRequest) => void>();

/** Opens the saved prompts manager, which the shell renders. */
export function requestPromptManager(request: ManagerRequest = {}): void {
  for (const listener of managerListeners) listener(request);
}

export function onPromptManagerRequest(listener: (request: ManagerRequest) => void): () => void {
  managerListeners.add(listener);
  return () => managerListeners.delete(listener);
}
