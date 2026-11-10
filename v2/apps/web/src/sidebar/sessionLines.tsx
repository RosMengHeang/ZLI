import { describeApproval, describeQuestions } from "@zli-v2/client-runtime";
import type { RuntimeProjection } from "@zli-v2/contracts";
import { useCallback } from "react";

import { useRuntimeSelector } from "../runtime/RuntimeProvider.js";
import { entriesForThread } from "../runtime/runtimeStore.js";

/** The first line of a reply that says something, without the Markdown marks around it. */
export function previewLine(text: string): string {
  const line =
    text
      // A code block opens no reply worth previewing; the sentence after it does.
      .replace(/```[\s\S]*?(```|$)/gu, "")
      .split(/\r?\n/u)
      .map((entry) => entry.trim())
      .find((entry) => entry && !/^(-{3,}|\|[\s:|-]+\|)$/u.test(entry)) ?? "";
  return line
    .replace(/^(#{1,6}|[-*+]|\d+\.|>)\s+/u, "")
    .replace(/\*\*|~~|`/gu, "")
    .slice(0, 160);
}

/**
 * What a working agent is doing right now: the step it is on, or the last one it finished this turn.
 * The sidebar's own projection skips chat updates, so each line reads its thread from the store.
 */
export function LiveStep({ threadId, turnId }: { threadId: string; turnId: string | undefined }) {
  const step = useRuntimeSelector(
    useCallback(
      (value: RuntimeProjection | undefined) => {
        const steps = entriesForThread(value?.activities, threadId).filter(
          (activity) => turnId !== undefined && activity.turnId === turnId,
        );
        return (steps.findLast((activity) => activity.status === "running") ?? steps.at(-1))?.title;
      },
      [threadId, turnId],
    ),
  );
  return <>{step ?? "Thinking"}</>;
}

/** What a waiting agent asked for: the action it wants approved, or its question. */
export function AskLine({ threadId, provider }: { threadId: string; provider: string }) {
  const request = useRuntimeSelector(
    useCallback(
      (value: RuntimeProjection | undefined) => value?.requests?.find((entry) => entry.threadId === threadId),
      [threadId],
    ),
  );
  if (!request) return <>Waiting for your answer</>;
  if (request.kind === "user-input") {
    return <>{describeQuestions(request.payload)[0]?.question ?? "Asked you a question"}</>;
  }
  const view = describeApproval(provider, request.payload);
  const detail = view.fields.find((field) => field.mono)?.value.split(/\r?\n/u)[0];
  return <>{detail ? `${view.title}: ${detail}` : view.title}</>;
}

/** The opening of the agent's last reply, for a chat that finished while the person was elsewhere. */
export function ReplyPreview({ threadId }: { threadId: string }) {
  const reply = useRuntimeSelector(
    useCallback(
      (value: RuntimeProjection | undefined) => {
        const last = entriesForThread(value?.messages, threadId).findLast((message) => message.role === "assistant");
        return last ? previewLine(last.text) : undefined;
      },
      [threadId],
    ),
  );
  return <>{reply || "Finished"}</>;
}
