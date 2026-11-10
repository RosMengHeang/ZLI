import type { RuntimeProjection, ThreadMessageProjection, ThreadProjection } from "@zli-v2/contracts";

import { providerDisplayName } from "../agent/providers.js";
import { modelOptions } from "../ui/ModelMark.js";

const PREFIX = "switch:";

function modelName(thread: ThreadProjection, providers: RuntimeProjection["providers"]): string | undefined {
  if (!thread.model) return undefined;
  const models = providers?.find((entry) => entry.provider === thread.provider);
  const listed = models?.status === "found" ? models.models : undefined;
  return modelOptions(listed, thread.model, thread.provider).find((option) => option.value === thread.model)?.label;
}

/**
 * The line in a chat where it moved from one agent or model to the next: "Switched from Droid to Claude
 * Code · Opus". It reads as part of the conversation, built from the two threads, and is never sent.
 */
export function switchNotice(
  from: ThreadProjection,
  to: ThreadProjection,
  providers: RuntimeProjection["providers"],
): ThreadMessageProjection {
  const fromName = from.name ?? providerDisplayName(from.provider, providers);
  const toName = to.name ?? providerDisplayName(to.provider, providers);
  const model = modelName(to, providers) ?? to.model;
  const text =
    from.provider === to.provider
      ? `Switched to ${model ?? `${toName}'s default model`}`
      : `Switched from ${fromName} to ${toName}${model ? ` · ${model}` : ""}`;
  return { messageId: `${PREFIX}${to.threadId}`, threadId: to.threadId, role: "system", text };
}

export function isSwitchNotice(message: ThreadMessageProjection): boolean {
  return message.role === "system" && message.messageId.startsWith(PREFIX);
}
