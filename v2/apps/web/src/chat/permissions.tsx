import type { PermissionMode } from "@zli-v2/contracts";

import { Icon, type IconName } from "../ui/Icon.js";
import type { PickerOption } from "../ui/Picker.js";

/** Ordered from the least to the most an agent may do on its own. */
export const permissionModes: readonly PermissionMode[] = ["read-only", "supervised", "full-access"];

/** The names used where no single agent is meant, such as the default in Settings. */
export const permissionLabel: Record<PermissionMode, string> = {
  "read-only": "Read only",
  supervised: "Edit files",
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

type PermissionText = { label: string; hint: string };

/**
 * Each agent's own name for the three levels, so the chip reads the way that agent's CLI does. ZLI starts
 * Claude Code in plan, acceptEdits, or bypassPermissions mode, and Codex with its Read only, Auto, or
 * Full access preset.
 */
const AGENT_PERMISSIONS: Partial<Record<string, Record<PermissionMode, PermissionText>>> = {
  "claude-code": {
    "read-only": { label: "Plan mode", hint: "Explores and writes a plan. Never edits or runs anything." },
    supervised: { label: "Accept edits", hint: "Edits files on its own. Asks before it runs a command." },
    "full-access": { label: "Bypass permissions", hint: "Edits files and runs commands without asking." },
  },
  codex: {
    "read-only": { label: "Read only", hint: "Reads files. Asks before it edits or runs anything." },
    supervised: { label: "Auto", hint: "Works inside this folder on its own. Asks to go outside it or online." },
    "full-access": { label: "Full access", hint: "Edits, runs commands, and goes online without asking." },
  },
};

export function permissionText(provider: string | undefined, mode: PermissionMode): PermissionText {
  return (
    (provider ? AGENT_PERMISSIONS[provider]?.[mode] : undefined) ?? {
      label: permissionLabel[mode],
      hint: permissionHint[mode],
    }
  );
}

/** The level's icon. Full access tints its open lock amber because the agent then acts without asking. */
export function PermissionIcon({ mode, size = 14 }: { mode: PermissionMode; size?: number }) {
  return <Icon name={permissionIcon[mode]} size={size} className={`permission-icon is-${mode}`} />;
}

export function permissionOptionsFor(provider: string | undefined): PickerOption<PermissionMode>[] {
  return permissionModes.map((mode) => {
    const text = permissionText(provider, mode);
    return {
      value: mode,
      label: text.label,
      description: text.hint,
      icon: <PermissionIcon mode={mode} size={15} />,
    };
  });
}

export const permissionOptions: readonly PickerOption<PermissionMode>[] = permissionOptionsFor(undefined);
