import { useSyncExternalStore } from "react";

/** A file, or lines of it, waiting in a chat's composer to go out with the next message. */
export type CodeReference = {
  id: string;
  path: string;
  startLine?: number | undefined;
  endLine?: number | undefined;
  /** The selected text; left out when it is too long to send inline. */
  snippet?: string | undefined;
};

const MAX_REFERENCES = 8;
const EMPTY: readonly CodeReference[] = [];
const byThread = new Map<string, readonly CodeReference[]>();
const listeners = new Set<() => void>();

function update(threadId: string, next: readonly CodeReference[]): void {
  if (next.length === 0) byThread.delete(threadId);
  else byThread.set(threadId, next);
  for (const listener of listeners) listener();
}

/** Adds a reference to a chat's composer. The same file and lines replace the earlier one. */
export function addCodeReference(threadId: string, reference: Omit<CodeReference, "id">): void {
  const id = `${reference.path}:${reference.startLine ?? ""}-${reference.endLine ?? ""}`;
  const current = (byThread.get(threadId) ?? EMPTY).filter((entry) => entry.id !== id);
  update(threadId, [...current, { ...reference, id }].slice(-MAX_REFERENCES));
}

export function removeCodeReference(threadId: string, id: string): void {
  update(
    threadId,
    (byThread.get(threadId) ?? EMPTY).filter((entry) => entry.id !== id),
  );
}

export function clearCodeReferences(threadId: string): void {
  if (byThread.has(threadId)) update(threadId, EMPTY);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function codeReferencesFor(threadId: string): readonly CodeReference[] {
  return byThread.get(threadId) ?? EMPTY;
}

export function useCodeReferences(threadId: string): readonly CodeReference[] {
  return useSyncExternalStore(subscribe, () => codeReferencesFor(threadId));
}

/** `app.ts:12-18`, `app.ts:12`, or `app.ts`. */
export function referenceLabel(reference: CodeReference): string {
  const name = reference.path.slice(reference.path.lastIndexOf("/") + 1);
  if (!reference.startLine) return name;
  return reference.endLine && reference.endLine !== reference.startLine
    ? `${name}:${reference.startLine}-${reference.endLine}`
    : `${name}:${reference.startLine}`;
}

/** The references written out ahead of the message, with each snippet in a code fence. */
export function withReferences(references: readonly CodeReference[], message: string): string {
  if (references.length === 0) return message;
  const blocks = references.map((reference) => {
    const lines = !reference.startLine
      ? ""
      : reference.endLine && reference.endLine !== reference.startLine
        ? ` lines ${reference.startLine}-${reference.endLine}`
        : ` line ${reference.startLine}`;
    const heading = `\`${reference.path}\`${lines}`;
    if (!reference.snippet) return heading;
    const longestRun = Math.max(0, ...(reference.snippet.match(/`+/gu) ?? []).map((run) => run.length));
    const fence = "`".repeat(Math.max(3, longestRun + 1));
    const dot = reference.path.lastIndexOf(".");
    const language = dot > reference.path.lastIndexOf("/") ? reference.path.slice(dot + 1) : "";
    return `${heading}:\n${fence}${language}\n${reference.snippet}\n${fence}`;
  });
  return message ? `${blocks.join("\n\n")}\n\n${message}` : blocks.join("\n\n");
}
