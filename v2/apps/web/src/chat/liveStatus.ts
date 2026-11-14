import type { ThreadActivityProjection } from "@zli-v2/contracts";

/**
 * What a working agent is doing now, in one place: the line under the chat, the member rows in a room, and
 * the sidebar all read it from here, so they never disagree.
 */

/**
 * The line of thinking the agent is on: the last line with words in it, without the Markdown marks that
 * would show as symbols on one line.
 */
export function latestThoughtLine(text: string | undefined): string | undefined {
  const line = text
    ?.split(/\r?\n/u)
    .map((value) =>
      value
        .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/u, "")
        .replaceAll(/\*\*|__|`/gu, "")
        .trim(),
    )
    .findLast(Boolean);
  return line || undefined;
}

/** The step an agent is on: the latest one still running. */
export function runningStep(activities: readonly ThreadActivityProjection[]): ThreadActivityProjection | undefined {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (activity?.status === "running") return activity;
  }
  return undefined;
}

/** The label for a running step: its latest line of thought while it thinks, otherwise its title. */
export function liveStepLabel(step: ThreadActivityProjection | undefined): string {
  if (!step) return "Working";
  if (step.kind === "reasoning") return latestThoughtLine(step.text) ?? "Thinking";
  return step.title || "Working";
}

/** The label for what an agent is doing now, from its activities in the current turn. */
export function liveStatus(activities: readonly ThreadActivityProjection[]): string {
  return liveStepLabel(runningStep(activities));
}
