import { useSyncExternalStore } from "react";

import { ANIMALS, type Animal, isAnimal } from "./teammates.js";

/**
 * Which animal each chat wears, kept on this machine. A chat gets one the first time the sidebar lists it,
 * picked so the chats near it look different, and keeps it for good: switching agent or model never changes it.
 */
const STORAGE_KEY = "zli.chat.animals";
const MAX_REMEMBERED = 500;

let cache: Record<string, Animal> | undefined;
const listeners = new Set<() => void>();

function read(): Record<string, Animal> {
  if (cache) return cache;
  const parsed: Record<string, Animal> = {};
  try {
    const raw = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}") as unknown;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [id, animal] of Object.entries(raw)) if (isAnimal(animal)) parsed[id] = animal;
    }
  } catch {
    // A broken entry starts the list over; chats fall back to their hashed animal until assigned again.
  }
  cache = parsed;
  return parsed;
}

function write(next: Record<string, Animal>): void {
  const ids = Object.keys(next);
  const kept =
    ids.length > MAX_REMEMBERED ? Object.fromEntries(ids.slice(-MAX_REMEMBERED).map((id) => [id, next[id]])) : next;
  cache = kept as Record<string, Animal>;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(kept));
  } catch {
    // Storage can be unavailable; the animals still hold until the window closes.
  }
  for (const listener of listeners) listener();
}

/** The animal a chat id hashes to, used before the chat has one of its own. */
export function hashedAnimal(chatId: string): Animal {
  let hash = 0;
  for (let index = 0; index < chatId.length; index += 1) hash = (hash * 31 + chatId.charCodeAt(index)) >>> 0;
  return ANIMALS[hash % ANIMALS.length] ?? "fox";
}

export function storedChatAnimal(chatId: string): Animal | undefined {
  return read()[chatId];
}

/**
 * Gives every chat in `chatIds` (newest last) an animal if it has none. A new chat takes the animal used least
 * among the chats listed, preferring its hashed one on a tie, so neighbours rarely match.
 */
export function assignChatAnimals(chatIds: readonly string[]): void {
  const known = read();
  const missing = chatIds.filter((id) => !known[id]);
  if (missing.length === 0) return;
  const next = { ...known };
  const counts = new Map<Animal, number>(ANIMALS.map((animal) => [animal, 0]));
  for (const id of chatIds) {
    const animal = next[id];
    if (animal) counts.set(animal, (counts.get(animal) ?? 0) + 1);
  }
  for (const id of missing) {
    const fewest = Math.min(...counts.values());
    const preferred = hashedAnimal(id);
    const animal =
      (counts.get(preferred) ?? 0) === fewest
        ? preferred
        : (ANIMALS.find((candidate) => (counts.get(candidate) ?? 0) === fewest) ?? preferred);
    next[id] = animal;
    counts.set(animal, (counts.get(animal) ?? 0) + 1);
  }
  write(next);
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

/** The chat's animal: the one it was given, or its hashed one until then. */
export function useChatAnimal(chatId: string): Animal {
  const stored = useSyncExternalStore(
    subscribe,
    () => read()[chatId],
    () => undefined,
  );
  return stored ?? hashedAnimal(chatId);
}
