import { z } from "zod";

function id<T extends string>() {
  return z.string().uuid().brand<T>();
}

export const EnvironmentId = id<"EnvironmentId">();
export type EnvironmentId = z.infer<typeof EnvironmentId>;

export const ProjectId = id<"ProjectId">();
export type ProjectId = z.infer<typeof ProjectId>;

export const WorkspaceId = id<"WorkspaceId">();
export type WorkspaceId = z.infer<typeof WorkspaceId>;

export const WorktreeId = id<"WorktreeId">();
export type WorktreeId = z.infer<typeof WorktreeId>;

/** Groups an agent's terminal, chat thread, and drawer shells into one session in the workbench. */
export const SessionId = id<"SessionId">();
export type SessionId = z.infer<typeof SessionId>;

export const ThreadId = id<"ThreadId">();
export type ThreadId = z.infer<typeof ThreadId>;

export const TurnId = id<"TurnId">();
export type TurnId = z.infer<typeof TurnId>;

export const TerminalId = id<"TerminalId">();
export type TerminalId = z.infer<typeof TerminalId>;

export const BrowserProfileId = id<"BrowserProfileId">();
export type BrowserProfileId = z.infer<typeof BrowserProfileId>;

export const BrowserTabId = id<"BrowserTabId">();
export type BrowserTabId = z.infer<typeof BrowserTabId>;

export const CommandId = id<"CommandId">();
export type CommandId = z.infer<typeof CommandId>;

export const EventId = id<"EventId">();
export type EventId = z.infer<typeof EventId>;

export const ApprovalRequestId = id<"ApprovalRequestId">();
export type ApprovalRequestId = z.infer<typeof ApprovalRequestId>;
