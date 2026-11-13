import { agentNameKey, type ListedProviderKind, type PermissionMode } from "@zli-v2/contracts";

import { BUDDY_BODIES, type Buddy, buddyBody, parseBuddy } from "./buddies.js";

/**
 * A saved teammate: an agent and model with a name, a buddy, and standing instructions. The person sets
 * one up once in Settings and brings it into any chat, or calls it with @Name.
 */
export type Teammate = {
  id: string;
  name: string;
  buddy: Buddy;
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
      // Settings saved before buddies hold an animal; it maps to the matching buddy.
      buddy: parseBuddy(entry.buddy) ?? parseBuddy(entry.animal) ?? "gumdrop",
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

/** The buddy an agent wears when nobody picked one: each agent CLI has its own, so it reads the same everywhere. */
const providerBuddy: Partial<Record<string, Buddy>> = {
  "claude-code": "gumdrop",
  codex: "squircle",
  droid: "jelly",
  "cursor-agent": "cloud",
  gemini: "mushroom",
  opencode: "bean",
  copilot: "peanut",
  kimi: "plus",
  qwen: "bean",
};

export function defaultBuddy(provider: string): Buddy {
  return providerBuddy[provider] ?? "gumdrop";
}

/** The agent's own buddy, or the first body nobody in `taken` wears yet. Bodies count, not colors. */
export function freeBuddy(provider: string, taken: Iterable<Buddy>): Buddy {
  const bodies = new Set([...taken].map(buddyBody));
  const preferred = defaultBuddy(provider);
  if (!bodies.has(buddyBody(preferred))) return preferred;
  return BUDDY_BODIES.find((body) => !bodies.has(body)) ?? preferred;
}

/** The saved teammate an agent was started as, found by its name. */
export function teammateNamed(teammates: readonly Teammate[], name: string | undefined): Teammate | undefined {
  if (!name) return undefined;
  const key = agentNameKey(name);
  return teammates.find((teammate) => agentNameKey(teammate.name) === key);
}

/**
 * The buddy each member of a chat wears. A saved teammate keeps its own; anyone else wears their agent's
 * buddy, or the next free body when someone in the chat already has it.
 */
export function roomBuddies(
  members: readonly { id: string; provider: string; name?: string | undefined; buddy?: Buddy | undefined }[],
  teammates: readonly Teammate[],
): Map<string, Buddy> {
  const buddies = new Map<string, Buddy>();
  for (const member of members) {
    const own = teammateNamed(teammates, member.name)?.buddy ?? member.buddy;
    if (own) buddies.set(member.id, own);
  }
  for (const member of members) {
    if (buddies.has(member.id)) continue;
    buddies.set(member.id, freeBuddy(member.provider, buddies.values()));
  }
  return buddies;
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
