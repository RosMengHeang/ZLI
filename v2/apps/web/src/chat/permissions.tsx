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
  "read-only": "eye",
  supervised: "shieldCheck",
  "full-access": "shieldAlert",
};

export const permissionHint: Record<PermissionMode, string> = {
  "read-only": "Reads and plans without changing files, where the agent supports it.",
  supervised: "Edits files and asks before risky commands, where the agent supports it.",
  "full-access": "Edits files and runs commands without asking.",
};

export const permissionOptions: readonly PickerOption<PermissionMode>[] = permissionModes.map((mode) => ({
  value: mode,
  label: permissionLabel[mode],
  description: permissionHint[mode],
  icon: <Icon name={permissionIcon[mode]} size={15} />,
}));
