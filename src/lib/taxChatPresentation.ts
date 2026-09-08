import type { TaxChatMessage, TaxChatRoomStatus } from "../types";

export type TaxChatTone = "accent" | "success" | "warning" | "danger" | "muted";

export function taxChatStatusLabel(status: TaxChatRoomStatus): string {
  switch (status) {
    case "running":
      return "Running";
    case "idle":
      return "Idle";
    case "paused":
      return "Paused";
    case "stopped":
      return "Stopped";
    default:
      return "Ready";
  }
}

export function taxChatStatusTone(status: TaxChatRoomStatus): TaxChatTone {
  switch (status) {
    case "running":
      return "success";
    case "paused":
      return "warning";
    case "stopped":
      return "danger";
    case "idle":
      return "accent";
    default:
      return "muted";
  }
}

export function taxChatRecipientLabel(
  recipientIds: string[],
  agents: Array<{ id: string; name: string }>,
): string {
  if (recipientIds.length === 0) return "No recipients";
  if (recipientIds.length > 1) return `${recipientIds.length} agents`;
  return agents.find((agent) => agent.id === recipientIds[0])?.name ?? "Unavailable agent";
}

export function taxChatMessageTone(message: TaxChatMessage): TaxChatTone {
  if (message.kind === "error" || message.status === "failed") return "danger";
  if (message.kind === "system" || message.kind === "delivery") return "muted";
  if (message.kind === "user") return "accent";
  return "success";
}

export function taxChatTimeLabel(createdAt: string): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.valueOf())) return "Now";
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
}
