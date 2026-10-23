import type { PermissionMode } from "@zli-v2/contracts";

import type { IconName } from "../ui/Icon.js";

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
