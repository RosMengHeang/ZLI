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
import { mono, space, type, usePalette } from "../theme.js";
import { Button, ChoiceRow, EmptyState, Field, Header, Notice, Row, Section, Segmented } from "../ui/components.js";
import { Icon, type IconName } from "../ui/Icon.js";
import { ModelMark, ProviderMark } from "../ui/ProviderMark.js";
import { ConnectionBanner } from "./ConnectionBanner.js";

/** The desktop's names and hints, ordered from the least to the most an agent may do alone. */
const PERMISSIONS: { mode: PermissionMode; label: string; description: string; icon: IconName }[] = [
  { mode: "read-only", label: "Read only", description: "Reads and plans, never changes files.", icon: "eye" },
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
    icon: "shieldAlert",
  },
];

const MODELS_SHOWN = 6;

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
        <Header title="New agent" onBack={navigation.back} />
        <EmptyState busy title="Loading projects and agents" />
      </View>
    );
  }

  const project = projects.find((candidate) => candidate.projectId === chosenProject);
  const providerEntry = providers.find((candidate) => candidate.provider === provider);
  const models = providerEntry?.models ?? [];
  const pickedIndex = models.findIndex((candidate) => candidate.id === model);
  const shownModels = allModels || pickedIndex >= MODELS_SHOWN ? models : models.slice(0, MODELS_SHOWN);
  const worktrees = project ? readyWorktrees(projection, project.projectId) : [];
  const online = snapshot.state.kind === "online";
  const safeBranch = safeBranchName(branch);
  const placed =
    placement === "new" ? safeBranch.length > 0 : worktrees.some((worktree) => worktree.worktreeId === existing);
  const ready = online && project !== undefined && providerEntry !== undefined && placed;
  const missing = !project
    ? "Pick a project"
    : !providerEntry
      ? "Pick an agent"
      : !placed
        ? placement === "new"
          ? "Name the branch"
          : "Pick a worktree"
        : !online
          ? "Waiting for the desktop"
          : undefined;

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
      <Header
        title="New agent"
        subtitle={project && projects.length === 1 ? project.name : undefined}
        onBack={navigation.back}
      />
      <ConnectionBanner />
      <ScrollView
        contentContainerStyle={[local.content, { paddingBottom: space.xl }]}
        keyboardShouldPersistTaps="handled"
      >
        {projects.length === 0 ? (
          <Notice tone="warning" message="Add a project in ZLI on the desktop first." />
        ) : projects.length > 1 ? (
          <Section title="Project">
            {projects.map((candidate) => (
              <ChoiceRow
                key={candidate.projectId}
                leading={<Icon name="folder" size={20} color={palette.text} />}
                label={candidate.name}
                description={candidate.path}
                checked={candidate.projectId === chosenProject}
                onPress={() => {
                  setChosenProject(candidate.projectId);
                  setExisting(undefined);
                }}
              />
            ))}
          </Section>
        ) : null}

        {providers.length === 0 ? (
          <Notice
            tone="warning"
            title="No agents installed"
            message="The desktop has no agent CLIs installed. Install one there, and it shows up here."
          />
        ) : (
          <Section title="Agent">
            {providers.map((candidate) => (
              <ChoiceRow
                key={candidate.provider}
                leading={<ProviderMark provider={candidate.provider} size={22} color={palette.text} />}
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
          </Section>
        )}

        {models.length > 0 ? (
          <Section title="Model">
            <ChoiceRow
              leading={<ModelMark id={undefined} size={20} color={palette.muted} />}
              label="Default model"
              description={`Whatever ${providerEntry?.displayName ?? "the agent"} uses unless told otherwise.`}
              checked={model === undefined}
              onPress={() => setModel(undefined)}
            />
            {shownModels.map((candidate) => (
              <ChoiceRow
                key={candidate.id}
                leading={<ModelMark id={candidate.id} label={candidate.label} size={20} color={palette.text} />}
                label={candidate.label}
                checked={candidate.id === model}
                onPress={() => setModel(candidate.id)}
              />
            ))}
            {shownModels.length < models.length ? (
              <Row
                leading={<Icon name="chevronDown" size={20} color={palette.muted} />}
                title={`Show all ${models.length} models`}
                tone="muted"
                onPress={() => setAllModels(true)}
              />
            ) : null}
          </Section>
        ) : null}

        <View style={local.group}>
          <Text accessibilityRole="header" style={[local.title, { color: palette.muted }]}>
            Where it works
          </Text>
          {worktrees.length > 0 ? (
            <Segmented
              label="Where it works"
              value={placement}
              onChange={setPlacement}
              options={[
                { value: "new", label: "New worktree" },
                { value: "existing", label: "Existing" },
              ]}
            />
          ) : null}
          {placement === "new" || worktrees.length === 0 ? (
            <Field
              accessibilityLabel="Branch name"
              hint={
                project && safeBranch
                  ? `Creates ${newWorktreePath(project.path, branch)} on the desktop.`
                  : "A fresh branch keeps its changes apart from yours."
              }
              value={branch}
              onChangeText={setBranch}
              placeholder="Branch name, such as fix/login-form"
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              monospace
            />
          ) : (
            <Section>
              {worktrees.map((worktree) => (
                <ChoiceRow
                  key={worktree.worktreeId}
                  leading={<Icon name="branch" size={20} color={palette.text} />}
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
              ))}
            </Section>
          )}
          {worktrees.length === 0 ? (
            <Text style={[local.note, { color: palette.muted }]}>
              No worktree in this project is ready, so the agent gets a new one.
            </Text>
          ) : null}
        </View>

        <Section title="Permissions">
          {PERMISSIONS.map((option) => (
            <ChoiceRow
              key={option.mode}
              leading={<Icon name={option.icon} size={20} color={palette.text} />}
              label={option.label}
              description={option.description}
              checked={option.mode === permissionMode}
              onPress={() => setPermissionMode(option.mode)}
            />
          ))}
        </Section>

        {error ? <Notice tone="error" message={error} /> : null}
        {step === "creating-worktree" ? (
          <Notice
            tone="info"
            message="If the project runs setup commands, approve them on the desktop. The agent starts once the worktree is ready."
            action={{ label: "Stop waiting", onPress: stopWaiting }}
          />
        ) : null}
      </ScrollView>
      <View style={[local.footer, { borderTopColor: palette.separator, paddingBottom: insets.bottom + space.md }]}>
        {missing && step === undefined ? (
          <Text style={[local.missing, { color: palette.muted }]}>{missing}</Text>
        ) : null}
        <Button
          label={providerEntry ? `Start ${providerEntry.displayName}` : "Start"}
          variant="primary"
          size="lg"
          disabled={!ready}
          busy={step !== undefined}
          {...(step ? { busyLabel: stepLabels[step] } : {})}
          {...(missing ? { accessibilityHint: missing } : {})}
          onPress={() => void start()}
        />
      </View>
    </KeyboardAvoidingView>
  );
}

const local = StyleSheet.create({
  screen: { flex: 1 },
  content: { paddingHorizontal: space.lg, paddingTop: space.sm, gap: space.xl },
  group: { gap: space.sm },
  title: { ...type.footnote, fontWeight: "600", paddingHorizontal: space.xs },
  note: { ...type.meta, paddingHorizontal: space.xs },
  mono: { fontFamily: mono },
  footer: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    gap: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  missing: { ...type.meta, textAlign: "center" },
});
