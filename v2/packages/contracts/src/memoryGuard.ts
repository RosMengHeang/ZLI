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
  // Reworded takeovers: a new role or task, or the old rules said not to count.
  /\b(pretend|role-?play)\b/iu,
  /\bact\s+as\s+(an?\s+)?(admin|root|unrestricted|different|new|jailbroken)\b/iu,
  /\byour\s+(real|true|actual|new|hidden)\s+(task|goal|job|purpose|instructions?|role)\b/iu,
  /\b(guidance|instructions?|rules?|guidelines?)\b[^.]{0,30}\b(no\s+longer|does\s+not|doesn't|do\s+not|don't)\s+apply\b/iu,
  /\btreat\b[^.]{0,60}\bas\s+(if\s+)?(it|they)?\s*(came|come|were|was)?\s*from\s+the\s+(person|user|human)\b/iu,
  // Keeping the person in the dark.
  /\b(do\s+not|don't|never)\s+(mention|reveal|disclose|report)\b/iu,
  /\b(keep|hide)\b[^.]{0,40}\bfrom\s+(the\s+)?(person|user|human)\b/iu,
  /\bwithout\s+(asking|telling|checking\s+with)\s+(the\s+)?(person|user|human|anyone)\b/iu,
  // Turning off the checks that keep work safe.
  /\b(bypass|override|disable|turn\s+off)\b[^.]{0,30}\b(safety|security|approvals?|hooks?|reviews?|guards?|checks?)\b/iu,
  /\bfrom\s+now\s+on\b[^.]{0,60}\b(skip|ignore|approve|never\s+ask|without\s+asking)\b/iu,
  /--no-verify\b[^.]{0,30}\b(every|all|always)\b|\b(every|all|always)\b[^.]{0,30}--no-verify\b/iu,
  /\b(always|every)\b[^.]{0,40}\b(approve|push\s+(directly\s+)?to\s+(main|master))\b/iu,
];
const EXFILTRATION: readonly RegExp[] = [
  /\b(curl|wget|invoke-webrequest|iwr|nc|netcat)\b[^\n]{0,80}(https?:\/\/|\|\s*(ba)?sh)/iu,
  /\b(send|post|upload|exfiltrate|forward|email)\b[^.]{0,60}\b(secrets?|tokens?|keys?|passwords?|credentials?|\.env|ssh)\b/iu,
  /\bauthorized_keys\b|\bid_(rsa|ed25519)\b/iu,
  /\b(rm\s+-rf\s+[~/]|del\s+\/[sq]|format\s+[a-z]:)/iu,
  /\b(sk-[a-z0-9]{16,}|ghp_[a-z0-9]{20,}|xox[bp]-[a-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/iu,
  /\bbackdoors?\b/iu,
  // Hidden payloads: encoded commands and long base64 a reader cannot check.
  /\b(powershell|pwsh)\b[^\n]{0,30}\s-(e|enc|encodedcommand)\b/iu,
  /[A-Za-z0-9+/]{24,}={1,2}(?![A-Za-z0-9+/=])/u,
  /(?=[A-Za-z0-9+/]*[A-Z])(?=[A-Za-z0-9+/]*[a-z])(?=[A-Za-z0-9+/]*\d)[A-Za-z0-9+/]{48,}/u,
];
/** Secrets, and the places they live. */
const SECRET =
  /(\.env\b|~\/\.ssh|\.ssh\b|\b[A-Z0-9_]*(TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*\b|\bsecrets?\b|\bcredentials?\b|\bprivate\s+keys?\b)/u;
/** Ways to move text. */
const MOVE = /\b(store|paste|copy|put|include|write|add|commit|print|echo|share|leak|log|upload)\b/iu;
/** Places others can read. */
const SHARED =
  /\b(in|into|to|onto)\s+(the\s+|a\s+|your\s+)?(pr|pull\s+request|summary|description|commit\s+message|repo|repository|chat|message|logs?|issue|comment|readme|code|output|reply|answer|url|gist|clipboard|public)\b/iu;
const AGAINST = /\b(never|don't|do\s+not|avoid|must\s+not|shouldn't|should\s+not|not)\b/iu;

/**
 * A sentence that moves a secret where others can read it, such as "paste the GITHUB_TOKEN into the summary".
 * Setting one up ("copy .env.example to .env") or a rule against leaking it ("never commit .env") is a fact
 * worth keeping.
 */
function movesSecret(text: string): boolean {
  return text.split(/(?<=[.;!?])\s+/u).some((sentence) => {
    const move = MOVE.exec(sentence);
    const shared = SHARED.exec(sentence);
    if (!move || !shared || !SECRET.test(sentence)) return false;
    if (AGAINST.test(sentence.slice(0, move.index))) return false;
    // "Add the key to .env, never to the code": the rule is about where it must not go.
    return !/\b(never|not)\s*,?\s*$/iu.test(sentence.slice(0, shared.index));
  });
}

export type NoteCheck = { ok: true; text: string } | { ok: false; reason: string };

/** Cleans a note and says whether a buddy may keep it. */
export function screenNote(raw: string): NoteCheck {
  const text = raw.replace(INVISIBLE, "").replace(/\s+/gu, " ").trim();
  if (!text) return { ok: false, reason: "The note is empty." };
  if (ORDERS.some((pattern) => pattern.test(text)))
    return { ok: false, reason: "It reads like an instruction to the agent, not a fact worth keeping." };
  if (EXFILTRATION.some((pattern) => pattern.test(text)) || movesSecret(text))
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
