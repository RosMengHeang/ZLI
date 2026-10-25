import type { PermissionMode } from "@zli-v2/contracts";
import { worktreeHasLiveThread } from "@zli-v2/contracts";
import { useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useLink, useLinkSnapshot } from "../LinkContext.js";
import { type LaunchStep, launchAgent } from "../lib/launch.js";
import { installedProviders, newWorktreePath, readyWorktrees, safeBranchName } from "../lib/views.js";
import { useNavigation } from "../navigation.js";
import { newId } from "../platform.js";
import { space, type, usePalette } from "../theme.js";
import { Banner, Button, Choice, EmptyState, Field, Header, SectionTitle } from "../ui/components.js";
import { ConnectionBanner } from "./ConnectionBanner.js";

const PERMISSIONS: { mode: PermissionMode; label: string; description: string }[] = [
  { mode: "full-access", label: "Full access", description: "Runs commands and edits files without asking." },
  { mode: "supervised", label: "Supervised", description: "Edits files, and asks before risky commands." },
  { mode: "read-only", label: "Read only", description: "Reads and plans without changing files." },
];

const MODELS_SHOWN = 8;

const stepLabels: Record<LaunchStep, string> = {
  "creating-worktree": "Creating the worktree…",
  "starting-agent": "Starting the agent…",
};

export function StartAgentScreen({ projectId }: { projectId?: string }) {
  const navigation = useNavigation();
  const link = useLink();
  const snapshot = useLinkSnapshot();
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const projection = snapshot.projection;
  const providers = installedProviders(projection);
  const projects = projection?.projects ?? [];

  const [chosenProject, setChosenProject] = useState(
    projectId ?? (projects.length === 1 ? projects[0]?.projectId : undefined),
  );
  const [provider, setProvider] = useState(providers[0]?.provider);
  const [model, setModel] = useState<string>();
  const [allModels, setAllModels] = useState(false);
  const [placement, setPlacement] = useState<"new" | "existing">("new");
  const [branch, setBranch] = useState("");
  const [existing, setExisting] = useState<string>();
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("full-access");
  const [step, setStep] = useState<LaunchStep>();
  const [error, setError] = useState<string>();
  const waiting = useRef<AbortController | undefined>(undefined);

  useEffect(() => () => waiting.current?.abort(), []);

  if (!projection) {
    return (
      <View style={[local.screen, { backgroundColor: palette.canvas }]}>
        <Header title="Start an agent" onBack={navigation.back} />
        <EmptyState busy title="Loading" />
      </View>
    );
  }

  const project = projects.find((candidate) => candidate.projectId === chosenProject);
  const providerEntry = providers.find((candidate) => candidate.provider === provider);
  const models = providerEntry?.models ?? [];
  const shownModels = allModels ? models : models.slice(0, MODELS_SHOWN);
  const worktrees = project ? readyWorktrees(projection, project.projectId) : [];
  const online = snapshot.state.kind === "online";
  const safeBranch = safeBranchName(branch);
  const ready =
    online &&
    project !== undefined &&
    providerEntry !== undefined &&
    (placement === "new" ? safeBranch.length > 0 : worktrees.some((worktree) => worktree.worktreeId === existing));

  const start = async () => {
    if (!project || !providerEntry) return;
    const controller = new AbortController();
    waiting.current = controller;
    setError(undefined);
    const outcome = await launchAgent(
      link,
      {
        project,
        placement: placement === "new" ? { kind: "new", branch } : { kind: "existing", worktreeId: existing ?? "" },
        provider: providerEntry.provider,
        model,
        permissionMode,
      },
      newId,
      setStep,
      controller.signal,
    );
    if (controller.signal.aborted) return;
    waiting.current = undefined;
    setStep(undefined);
    if ("threadId" in outcome) navigation.replace({ name: "agent", threadId: outcome.threadId });
    else setError(outcome.error);
  };

  const stopWaiting = () => {
    waiting.current?.abort();
    waiting.current = undefined;
    setStep(undefined);
    setError("Stopped waiting. The worktree may still finish on the desktop.");
  };

  return (
    <KeyboardAvoidingView behavior="padding" style={[local.screen, { backgroundColor: palette.canvas }]}>
      <Header title="Start an agent" onBack={navigation.back} />
      <ConnectionBanner />
      <ScrollView
        contentContainerStyle={[local.content, { paddingBottom: insets.bottom + space.xl }]}
        keyboardShouldPersistTaps="handled"
      >
        {projects.length > 1 || !project ? (
          <View style={local.group} accessibilityRole="radiogroup" accessibilityLabel="Project">
            <SectionTitle>Project</SectionTitle>
            {projects.length === 0 ? (
              <Text style={[local.note, { color: palette.muted }]}>Add a project in ZLI on the desktop first.</Text>
            ) : null}
            {projects.map((candidate) => (
              <Choice
                key={candidate.projectId}
                label={candidate.name}
                description={candidate.path}
                checked={candidate.projectId === chosenProject}
                onPress={() => {
                  setChosenProject(candidate.projectId);
                  setExisting(undefined);
                }}
              />
            ))}
          </View>
        ) : (
          <Text style={[local.note, { color: palette.muted }]}>
            In <Text style={{ color: palette.text }}>{project.name}</Text>
          </Text>
        )}

        <View style={local.group} accessibilityRole="radiogroup" accessibilityLabel="Agent">
          <SectionTitle>Agent</SectionTitle>
          {providers.length === 0 ? (
            <Banner
              tone="warning"
              message="The desktop has no agents installed. Install one there, and it shows up here."
            />
          ) : null}
          {providers.map((candidate) => (
            <Choice
              key={candidate.provider}
              label={candidate.displayName}
              description={candidate.version}
              checked={candidate.provider === provider}
              onPress={() => {
                setProvider(candidate.provider);
                setModel(undefined);
                setAllModels(false);
              }}
            />
          ))}
        </View>

        {models.length > 0 ? (
          <View style={local.group} accessibilityRole="radiogroup" accessibilityLabel="Model">
            <SectionTitle>Model</SectionTitle>
            <Choice label="The agent's default" checked={model === undefined} onPress={() => setModel(undefined)} />
            {shownModels.map((candidate) => (
              <Choice
                key={candidate.id}
                label={candidate.label}
                checked={candidate.id === model}
                onPress={() => setModel(candidate.id)}
              />
            ))}
            {models.length > MODELS_SHOWN && !allModels ? (
              <Button label={`Show all ${models.length} models`} variant="quiet" onPress={() => setAllModels(true)} />
            ) : null}
          </View>
        ) : null}

        <View style={local.group} accessibilityRole="radiogroup" accessibilityLabel="Where it works">
          <SectionTitle>Where it works</SectionTitle>
          <Choice
            label="A new worktree"
            description="A fresh branch, so its changes stay apart from yours."
            checked={placement === "new"}
            onPress={() => setPlacement("new")}
          />
          <Choice
            label="An existing worktree"
            description={worktrees.length === 0 ? "None are ready in this project." : undefined}
            checked={placement === "existing"}
            disabled={worktrees.length === 0}
            onPress={() => setPlacement("existing")}
          />
          {placement === "new" ? (
            <Field
              label="Branch name"
              hint={
                project && safeBranch
                  ? `Goes in ${newWorktreePath(project.path, branch)} on the desktop.`
                  : "Letters, numbers, dots, dashes, and slashes."
              }
              value={branch}
              onChangeText={setBranch}
              placeholder="fix/login-form"
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              monospace
            />
          ) : (
            worktrees.map((worktree) => (
              <Choice
                key={worktree.worktreeId}
                label={worktree.branch}
                labelMono
                description={
                  worktreeHasLiveThread(projection.threads, worktree.worktreeId)
                    ? "An agent already works here. They will share the files."
                    : undefined
                }
                checked={worktree.worktreeId === existing}
                onPress={() => setExisting(worktree.worktreeId)}
              />
            ))
          )}
        </View>

        <View style={local.group} accessibilityRole="radiogroup" accessibilityLabel="Permissions">
          <SectionTitle>Permissions</SectionTitle>
          {PERMISSIONS.map((option) => (
            <Choice
              key={option.mode}
              label={option.label}
              description={option.description}
              checked={option.mode === permissionMode}
              onPress={() => setPermissionMode(option.mode)}
            />
          ))}
        </View>

        {error ? <Banner tone="error" message={error} /> : null}
        {step === "creating-worktree" ? (
          <Text accessibilityLiveRegion="polite" style={[local.note, { color: palette.muted }]}>
            If the project runs setup commands, approve them on the desktop. The agent starts once the worktree is
            ready.
          </Text>
        ) : null}
        <Button
          label={providerEntry ? `Start ${providerEntry.displayName}` : "Start"}
          variant="primary"
          disabled={!ready}
          busy={step !== undefined}
          {...(step ? { busyLabel: stepLabels[step] } : {})}
          onPress={() => void start()}
        />
        {step === "creating-worktree" ? <Button label="Stop waiting" onPress={stopWaiting} /> : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const local = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: space.lg, gap: space.lg },
  group: { gap: space.sm },
  note: { fontSize: type.body, lineHeight: 22 },
});
