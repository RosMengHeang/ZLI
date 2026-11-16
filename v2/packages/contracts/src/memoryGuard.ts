import type { MemoryNote } from "./buddies.js";

/**
 * A buddy's notes go into every brief it reads, so a note is the one place a prompt injection could stay for
 * good. A note is a short fact about the person, the project, or how work goes; anything that reads like an
 * order to the agent, a way to move data out, or a hidden string is not kept.
 */
const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿­]/gu;
const ORDERS: readonly RegExp[] = [
  /\b(ignore|disregard|forget|override)\b[^.]{0,40}\b(previous|prior|above|earlier|all|your|these|the)\b[^.]{0,30}\b(instructions?|rules?|prompts?|messages?|guidelines?)\b/iu,
  /\b(system|developer)\s+(prompt|message|instructions?)\b/iu,
  /\byou\s+(are|must)\s+now\b/iu,
  /\bnew\s+(instructions?|rules?|persona)\b/iu,
  /\b(do\s+not|don't|never)\s+(tell|inform|show|let)\s+(the\s+)?(person|user|human)\b/iu,
  /\[\[\/?\s*(job|tell|remember)\b/iu,
  /<\/?\s*(system|instructions?|assistant|tool)\s*>/iu,
];
const EXFILTRATION: readonly RegExp[] = [
  /\b(curl|wget|invoke-webrequest|iwr|nc|netcat)\b[^\n]{0,80}(https?:\/\/|\|\s*(ba)?sh)/iu,
  /\b(send|post|upload|exfiltrate|forward|email)\b[^.]{0,60}\b(secrets?|tokens?|keys?|passwords?|credentials?|\.env|ssh)\b/iu,
  /\bauthorized_keys\b|\bid_(rsa|ed25519)\b/iu,
  /\b(rm\s+-rf\s+[~/]|del\s+\/[sq]|format\s+[a-z]:)/iu,
  /\b(sk-[a-z0-9]{16,}|ghp_[a-z0-9]{20,}|xox[bp]-[a-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/iu,
];

export type NoteCheck = { ok: true; text: string } | { ok: false; reason: string };

/** Cleans a note and says whether a buddy may keep it. */
export function screenNote(raw: string): NoteCheck {
  const text = raw.replace(INVISIBLE, "").replace(/\s+/gu, " ").trim();
  if (!text) return { ok: false, reason: "The note is empty." };
  if (ORDERS.some((pattern) => pattern.test(text)))
    return { ok: false, reason: "It reads like an instruction to the agent, not a fact worth keeping." };
  if (EXFILTRATION.some((pattern) => pattern.test(text)))
    return { ok: false, reason: "It looks like a secret or a way to send data out." };
  return { ok: true, text };
}

/** What a note costs to lose: what the person said outlasts what the buddy worked out for itself. */
const KEEP_FIRST: Record<MemoryNote["source"], number> = { you: 3, told: 2, lesson: 1, lookback: 0 };

/**
 * Keeps a buddy's notes within the limit. When there are too many, the notes it learned on its own go first,
 * oldest first, before anything the person told it.
 */
export function keepNotes<T extends Pick<MemoryNote, "source">>(notes: readonly T[], limit: number): T[] {
  if (notes.length <= limit) return [...notes];
  const drop = new Set<number>();
  const order = notes
    .map((note, index) => ({ index, weight: KEEP_FIRST[note.source] ?? 0 }))
    .sort((left, right) => left.weight - right.weight || left.index - right.index);
  for (const entry of order) {
    if (notes.length - drop.size <= limit) break;
    drop.add(entry.index);
  }
  return notes.filter((_note, index) => !drop.has(index));
}
