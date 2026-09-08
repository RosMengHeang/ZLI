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
