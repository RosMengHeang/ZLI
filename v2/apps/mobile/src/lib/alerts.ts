import type { AgentAlert } from "@zli-v2/client-runtime";

export {
  type AgentAlert,
  type AgentAlertKind,
  agentAlerts,
  answeredAlertKeys,
  branchLine,
  describeRequest,
  isUrgentAlert,
  lastReply,
  requestAlertKey,
  threadAlertKey,
} from "@zli-v2/client-runtime";

export type AlertContext = {
  /** Whether the app is on screen. */
  active: boolean;
  /** The agent whose conversation is open, if any. */
  openThreadId: string | undefined;
};

export function shouldShowAlert(alert: AgentAlert, context: AlertContext): boolean {
  if (!context.active) return true;
  if (alert.threadId === context.openThreadId) return false;
  // On screen, a stop is most often the person's own tap, and the list already shows it.
  return alert.kind !== "stopped";
}
