import type { TerminalProjection, ThreadProjection } from "@zli-v2/contracts";
import { AgentName, MAX_AGENT_NAME_LENGTH } from "@zli-v2/contracts";
import { type ReactNode, useState } from "react";
import { Alert, Platform, StyleSheet, View } from "react-native";

import { useLink } from "../LinkContext.js";
import { sendCommand } from "../lib/launch.js";
import { space } from "../theme.js";
import { Button, Field, Sheet, SheetOption, type SwipeAction } from "../ui/components.js";

type Target =
  | { kind: "agent"; thread: ThreadProjection; name: string; providerName: string }
  | { kind: "shell"; terminal: TerminalProjection };

function shellName(terminal: TerminalProjection): string {
  return terminal.title || "Shell";
}

/**
 * Rename, Stop, and Remove for agents and Stop for shells, shared by the swipe actions and the
 * long-press sheet so both always offer the same things.
 */
export function useListActions(onError: (message: string | undefined) => void) {
  const link = useLink();
  const [menu, setMenu] = useState<Target>();
  const [renaming, setRenaming] = useState<Extract<Target, { kind: "agent" }>>();
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [renameError, setRenameError] = useState<string>();

  const run = async (command: Record<string, unknown> & { type: string }, fallback: string) => {
    onError(undefined);
    const outcome = await sendCommand(link, command, fallback);
    if (!outcome.ok) onError(outcome.error);
    return outcome.ok;
  };

  const startRename = (target: Extract<Target, { kind: "agent" }>) => {
    setMenu(undefined);
    setDraft(target.thread.name ?? "");
    setRenameError(undefined);
    setRenaming(target);
  };

  const saveName = async () => {
    if (!renaming) return;
    const trimmed = draft.trim();
    const parsed = trimmed ? AgentName.safeParse(trimmed) : undefined;
    if (parsed && !parsed.success) {
      setRenameError(parsed.error.issues[0]?.message ?? "Choose another name.");
      return;
    }
    setSaving(true);
    setRenameError(undefined);
    const outcome = await sendCommand(
      link,
      { type: "thread.rename", threadId: renaming.thread.threadId, name: trimmed || null },
      "The name could not be saved.",
    );
    setSaving(false);
    if (outcome.ok) setRenaming(undefined);
    else setRenameError(outcome.error);
  };

  const stopAgent = (target: Extract<Target, { kind: "agent" }>) => {
    setMenu(undefined);
    Alert.alert(`Stop ${target.name}?`, "The agent's process ends on the desktop. The conversation stays.", [
      { text: "Keep running", style: "cancel" },
      {
        text: "Stop agent",
        style: "destructive",
        onPress: () =>
          void run({ type: "thread.stop", threadId: target.thread.threadId }, "The agent could not be stopped."),
      },
    ]);
  };

  const removeAgent = (target: Extract<Target, { kind: "agent" }>) => {
    setMenu(undefined);
    const sessionId = target.thread.sessionId;
    if (!sessionId) {
      onError("This agent can only be removed on the desktop.");
      return;
    }
    Alert.alert(
      `Remove ${target.name}?`,
      "This stops the agent and deletes its conversation for good. The worktree and its files stay.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove agent",
          style: "destructive",
          onPress: () => void run({ type: "session.delete", sessionId }, "The agent could not be removed."),
        },
      ],
    );
  };

  const stopShell = (terminal: TerminalProjection) => {
    setMenu(undefined);
    Alert.alert(`Stop ${shellName(terminal)}?`, "The shell and whatever runs in it end on the desktop.", [
      { text: "Keep running", style: "cancel" },
      {
        text: "Stop shell",
        style: "destructive",
        onPress: () =>
          void run({ type: "terminal.stop", terminalId: terminal.terminalId }, "The shell could not be stopped."),
      },
    ]);
  };

  const agentActions = (thread: ThreadProjection, name: string, providerName: string): SwipeAction[] => {
    const target = { kind: "agent", thread, name, providerName } as const;
    const live = thread.status !== "stopped" && thread.status !== "failed";
    return [
      { label: "Rename", icon: "pencil", onPress: () => startRename(target) },
      ...(live ? [{ label: "Stop", icon: "square" as const, onPress: () => stopAgent(target) }] : []),
      { label: "Remove", icon: "trash", tone: "danger", onPress: () => removeAgent(target) },
    ];
  };

  const shellActions = (terminal: TerminalProjection): SwipeAction[] => [
    { label: "Stop", icon: "square", tone: "danger", onPress: () => stopShell(terminal) },
  ];

  const menuActions =
    menu?.kind === "agent"
      ? agentActions(menu.thread, menu.name, menu.providerName)
      : menu?.kind === "shell"
        ? shellActions(menu.terminal)
        : [];

  const sheets: ReactNode = (
    <>
      <Sheet
        visible={menu !== undefined}
        title={menu?.kind === "agent" ? menu.name : menu ? shellName(menu.terminal) : undefined}
        onClose={() => setMenu(undefined)}
      >
        {menuActions.map((action) => (
          <SheetOption
            key={action.label}
            icon={action.icon}
            label={
              action.label === "Rename" ? "Rename" : `${action.label} ${menu?.kind === "shell" ? "shell" : "agent"}`
            }
            tone={action.tone ?? "default"}
            onPress={() => {
              setMenu(undefined);
              // iOS drops an alert or a second sheet shown while this sheet is still closing.
              setTimeout(action.onPress, Platform.OS === "ios" ? 350 : 0);
            }}
          />
        ))}
      </Sheet>
      <Sheet
        visible={renaming !== undefined}
        title="Rename agent"
        subtitle={
          renaming
            ? `Agents and the desktop use this name. Leave it empty to call it ${renaming.providerName}.`
            : undefined
        }
        onClose={() => setRenaming(undefined)}
      >
        <View style={local.form}>
          <Field
            accessibilityLabel="Agent name"
            value={draft}
            onChangeText={(value) => {
              setDraft(value);
              setRenameError(undefined);
            }}
            placeholder={renaming?.providerName}
            maxLength={MAX_AGENT_NAME_LENGTH}
            autoFocus
            autoCorrect={false}
            returnKeyType="done"
            onSubmitEditing={() => void saveName()}
            error={renameError}
          />
          <View style={local.buttons}>
            <Button label="Cancel" variant="quiet" grow onPress={() => setRenaming(undefined)} />
            <Button
              label="Save"
              variant="primary"
              grow
              busy={saving}
              busyLabel="Saving…"
              onPress={() => void saveName()}
            />
          </View>
        </View>
      </Sheet>
    </>
  );

  return {
    agentActions,
    shellActions,
    openAgentMenu: (thread: ThreadProjection, name: string, providerName: string) =>
      setMenu({ kind: "agent", thread, name, providerName }),
    openShellMenu: (terminal: TerminalProjection) => setMenu({ kind: "shell", terminal }),
    stopShell,
    sheets,
  };
}

const local = StyleSheet.create({
  form: { gap: space.md, paddingHorizontal: space.md, paddingBottom: space.xs },
  buttons: { flexDirection: "row", gap: space.sm },
});
