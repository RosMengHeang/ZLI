import type { AttentionStatus } from "./agentEvents.ts";

export type PresentedStatus = "running" | "starting" | "failed" | "stopped";

export type StatusTone = "success" | "warning" | "danger" | "neutral";

export interface StatusPresentation {
  label: string;
  tone: StatusTone;
  animated: boolean;
}

export function statusPresentation(status: PresentedStatus): StatusPresentation {
  switch (status) {
    case "running":
      return { label: "Running", tone: "success", animated: false };
    case "starting":
      return { label: "Starting", tone: "warning", animated: false };
    case "failed":
      return { label: "Failed", tone: "danger", animated: false };
    case "stopped":
      return { label: "Stopped", tone: "neutral", animated: false };
  }
}

export function attentionStatusPresentation(status: AttentionStatus): StatusPresentation {
  switch (status) {
    case "working":
      return { label: "Working", tone: "success", animated: false };
    case "waiting_for_you":
      return { label: "Waiting for you", tone: "warning", animated: false };
    case "completed":
      return { label: "Completed", tone: "success", animated: false };
    case "failed":
      return { label: "Failed", tone: "danger", animated: false };
    case "paused":
      return { label: "Paused", tone: "warning", animated: false };
    case "offline":
      return { label: "Offline", tone: "neutral", animated: false };
  }
}
