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
      return { label: "Running", tone: "success", animated: true };
    case "starting":
      return { label: "Starting", tone: "warning", animated: true };
    case "failed":
      return { label: "Failed", tone: "danger", animated: false };
    case "stopped":
      return { label: "Stopped", tone: "neutral", animated: false };
  }
}
