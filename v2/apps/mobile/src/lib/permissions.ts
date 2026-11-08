import type { PermissionMode } from "@zli-v2/contracts";

import type { Palette } from "../theme.js";
import type { IconName } from "../ui/Icon.js";

export type PermissionOption = { mode: PermissionMode; label: string; description: string; icon: IconName };

/** The desktop's names, icons, and hints, ordered from the least to the most an agent may do alone. */
export const PERMISSIONS: readonly PermissionOption[] = [
  { mode: "read-only", label: "Read only", description: "Reads and plans, never changes files.", icon: "lock" },
  {
    mode: "supervised",
    label: "Auto",
    description: "Edits files without asking, asks before commands.",
    icon: "shieldCheck",
  },
  {
    mode: "full-access",
    label: "Full access",
    description: "Edits files and runs commands without asking.",
    icon: "lockOpen",
  },
];

export function permissionOption(mode: PermissionMode | undefined): PermissionOption | undefined {
  return PERMISSIONS.find((option) => option.mode === mode);
}

/** Only Full access takes a muted amber, because the agent then acts without asking. */
export function permissionColor(mode: PermissionMode | undefined, palette: Palette): string {
  return mode === "full-access" ? palette.tones.amber.ink : palette.text;
}
