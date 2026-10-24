import type { UpdateStatus } from "@zli-v2/contracts";

import { Icon } from "../ui/Icon.js";
import { updatePill } from "./updateCopy.js";
import "./updates.css";

/** A title bar button for an update the person has to act on. Renders nothing otherwise. */
export function UpdatePill({
  status,
  onRestart,
  onOpenRelease,
  onOpenSettings,
}: {
  status: UpdateStatus | undefined;
  onRestart(): void;
  onOpenRelease(): void;
  onOpenSettings(): void;
}) {
  const pill = updatePill(status);
  if (!pill) return null;
  const onClick =
    pill.action === "restart" ? onRestart : pill.action === "open-release" ? onOpenRelease : onOpenSettings;
  const tooltip =
    pill.action === "restart"
      ? "Restarts ZLI and installs the update"
      : pill.action === "open-release"
        ? "Opens the release page to download it"
        : "Opens Settings to install it";
  return (
    <button className="update-pill" type="button" data-tooltip={tooltip} onClick={onClick}>
      <Icon name={pill.action === "restart" ? "rotate" : "download"} size={12} />
      <span>{pill.label}</span>
    </button>
  );
}
