import { agentNameKey, type ListedProviderKind, type PermissionMode } from "@zli-v2/contracts";

/** The animals a teammate can wear. Each has its own colours, so two teammates side by side never look alike. */
export const ANIMALS = ["fox", "owl", "otter", "cat", "panda", "penguin", "bear", "rabbit", "frog", "chick"] as const;
export type Animal = (typeof ANIMALS)[number];

export const animalLabel: Record<Animal, string> = {
  fox: "Fox",
  owl: "Owl",
  otter: "Otter",
  cat: "Cat",
  panda: "Panda",
  penguin: "Penguin",
  bear: "Bear",
  rabbit: "Rabbit",
  frog: "Frog",
  chick: "Chick",
};

export function isAnimal(value: unknown): value is Animal {
  return typeof value === "string" && (ANIMALS as readonly string[]).includes(value);
}

/**
 * A saved teammate: an agent and model with a name, an animal, and standing instructions. The person sets
 * one up once in Settings and brings it into any chat, or calls it with @Name.
 */
export type Teammate = {
  id: string;
  name: string;
  animal: Animal;
  provider: ListedProviderKind;
  model?: string | undefined;
  /** Read by the teammate before anything else whenever it joins a chat. */
  instructions?: string | undefined;
  permissionMode?: PermissionMode | undefined;
};

export const MAX_TEAMMATES = 12;
export const MAX_TEAMMATE_INSTRUCTIONS = 4_000;
const permissions: readonly PermissionMode[] = ["read-only", "supervised", "full-access"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A teammate name works as an @mention: letters, digits, spaces, dots, dashes and underscores. */
export function cleanTeammateName(value: string): string {
  return value
    .replace(/[^\p{L}\p{N} ._-]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 40);
}

export function parseTeammates(value: unknown): Teammate[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const teammates: Teammate[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || teammates.length >= MAX_TEAMMATES) continue;
    const name = typeof entry.name === "string" ? cleanTeammateName(entry.name) : "";
    const provider = typeof entry.provider === "string" && entry.provider ? entry.provider : "";
    const id = typeof entry.id === "string" && entry.id ? entry.id : "";
    if (!name || !provider || !id || seen.has(agentNameKey(name))) continue;
    seen.add(agentNameKey(name));
    const instructions =
      typeof entry.instructions === "string" && entry.instructions.trim()
        ? entry.instructions.trim().slice(0, MAX_TEAMMATE_INSTRUCTIONS)
        : undefined;
    teammates.push({
      id,
      name,
      animal: isAnimal(entry.animal) ? entry.animal : "fox",
      provider: provider as ListedProviderKind,
      ...(typeof entry.model === "string" && entry.model ? { model: entry.model } : {}),
      ...(instructions ? { instructions } : {}),
      ...(permissions.includes(entry.permissionMode as PermissionMode)
        ? { permissionMode: entry.permissionMode as PermissionMode }
        : {}),
    });
  }
  return teammates;
}

/** The animal an agent wears when nobody picked one: each agent CLI has its own, so it reads the same everywhere. */
const providerAnimal: Partial<Record<string, Animal>> = {
  "claude-code": "fox",
  codex: "owl",
  droid: "otter",
  "cursor-agent": "cat",
  gemini: "penguin",
  opencode: "panda",
  copilot: "bear",
  kimi: "rabbit",
  qwen: "panda",
};

export function defaultAnimal(provider: string): Animal {
  return providerAnimal[provider] ?? "fox";
}

/** The saved teammate an agent was started as, found by its name. */
export function teammateNamed(teammates: readonly Teammate[], name: string | undefined): Teammate | undefined {
  if (!name) return undefined;
  const key = agentNameKey(name);
  return teammates.find((teammate) => agentNameKey(teammate.name) === key);
}

/**
 * The animal each member of a chat wears. A saved teammate keeps its own; anyone else wears their agent's
 * animal, or the next free one when someone in the chat already has it.
 */
export function roomAnimals(
  members: readonly { id: string; provider: string; name?: string | undefined; animal?: Animal | undefined }[],
  teammates: readonly Teammate[],
): Map<string, Animal> {
  const animals = new Map<string, Animal>();
  const taken = new Set<Animal>();
  for (const member of members) {
    const own = teammateNamed(teammates, member.name)?.animal ?? member.animal;
    if (own) {
      animals.set(member.id, own);
      taken.add(own);
    }
  }
  for (const member of members) {
    if (animals.has(member.id)) continue;
    const preferred = defaultAnimal(member.provider);
    const animal = taken.has(preferred) ? (ANIMALS.find((candidate) => !taken.has(candidate)) ?? preferred) : preferred;
    animals.set(member.id, animal);
    taken.add(animal);
  }
  return animals;
}

/** A name nobody in the project has yet: the wanted one, or the same with a number after it. */
export function freeAgentName(wanted: string, taken: Iterable<string | undefined>): string {
  const used = new Set<string>();
  for (const name of taken) if (name) used.add(agentNameKey(name));
  if (!used.has(agentNameKey(wanted))) return wanted;
  for (let number = 2; number < 100; number += 1) {
    const candidate = `${wanted} ${number}`;
    if (!used.has(agentNameKey(candidate))) return candidate;
  }
  return `${wanted} ${Date.now() % 1000}`;
}

/**
 * The names a message opens with, such as "@Owl @Reviewer check this". Names can hold spaces, so the
 * longest name that fits wins. Returns the names found and the message after them.
 */
export function leadingMentions(text: string, names: readonly string[]): { names: string[]; rest: string } {
  const sorted = [...names].sort((left, right) => right.length - left.length);
  const found: string[] = [];
  let rest = text.trimStart();
  for (;;) {
    if (!rest.startsWith("@")) break;
    const after = rest.slice(1);
    const match = sorted.find((name) => {
      if (after.length < name.length) return false;
      if (agentNameKey(after.slice(0, name.length)) !== agentNameKey(name)) return false;
      const next = after.charAt(name.length);
      return next === "" || /[\s,:;!?]/u.test(next);
    });
    if (!match) break;
    if (!found.some((name) => agentNameKey(name) === agentNameKey(match))) found.push(match);
    rest = after
      .slice(match.length)
      .replace(/^[,:;]?\s*/u, "")
      .trimStart();
  }
  return { names: found, rest };
}
