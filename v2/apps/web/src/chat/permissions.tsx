import type { PermissionMode } from "@zli-v2/contracts";

import { Icon, type IconName } from "../ui/Icon.js";
import type { PickerOption } from "../ui/Picker.js";

/** Ordered from the least to the most an agent may do on its own. */
export const permissionModes: readonly PermissionMode[] = ["read-only", "supervised", "full-access"];

export const permissionLabel: Record<PermissionMode, string> = {
  "read-only": "Read only",
  supervised: "Auto",
  "full-access": "Full access",
};

export const permissionIcon: Record<PermissionMode, IconName> = {
  "read-only": "lock",
  supervised: "shieldCheck",
  "full-access": "lockOpen",
};

export const permissionHint: Record<PermissionMode, string> = {
  "read-only": "Reads and plans, never changes files.",
  supervised: "Edits files without asking, asks before commands.",
  "full-access": "Edits files and runs commands without asking.",
};

/** The level's icon. Full access tints its open lock amber because the agent then acts without asking. */
export function PermissionIcon({ mode, size = 14 }: { mode: PermissionMode; size?: number }) {
  return <Icon name={permissionIcon[mode]} size={size} className={`permission-icon is-${mode}`} />;
}

export const permissionOptions: readonly PickerOption<PermissionMode>[] = permissionModes.map((mode) => ({
  value: mode,
  label: permissionLabel[mode],
  description: permissionHint[mode],
  icon: <PermissionIcon mode={mode} size={15} />,
}));
