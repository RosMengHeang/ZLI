import type { GitBranchesResult, ReviewFileProjection, ReviewProjection } from "@zli-v2/contracts";
import { useCallback, useEffect, useState } from "react";
import { Alert, KeyboardAvoidingView, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useLink, useLinkSnapshot } from "../LinkContext.js";
import {
  type ChangeTotals,
  type CommitPlan,
  changeTotals,
  commitChanges,
  commitHint,
  commitPlan,
  diffUnavailable,
  type FileKindView,
  fileKind,
  filesToCommit,
  type GitOutcome,
  pushBranch,
  readBranches,
  refreshChanges,
  reviewFor,
  splitPath,
  spokenTotals,
} from "../lib/changes.js";
import { useNavigation } from "../navigation.js";
import { mono, radius, space, TAP, type, usePalette } from "../theme.js";
import { Button, EmptyState, Field, Header, IconButton, Notice, Row, Section, Tappable } from "../ui/components.js";
import { Icon } from "../ui/Icon.js";
import { ConnectionBanner } from "./ConnectionBanner.js";

/** The agent screen's way in: the line totals of the worktree's changes, as the desktop's Environment popover shows them. */
export function ChangesEntry({ worktreeId }: { worktreeId: string }) {
  const navigation = useNavigation();
  const snapshot = useLinkSnapshot();
  const palette = usePalette();
  const review = reviewFor(snapshot.projection, worktreeId);
  const totals = review ? changeTotals(review.files) : undefined;
  return (
    <View style={local.entryWrap}>
      <Tappable
        accessibilityRole="button"
        accessibilityLabel={totals ? `Changes, ${spokenTotals(totals)}` : "Changes"}
        accessibilityHint="Shows the changed files and their diffs, and lets you commit"
        onPress={() => navigation.push({ name: "changes", worktreeId })}
        focusRadius={radius.md}
        style={({ pressed }) => [local.entry, { backgroundColor: pressed ? palette.raised : palette.surface }]}
      >
        <Icon name="diff" size={18} color={palette.muted} />
        <Text style={[local.entryLabel, { color: palette.text }]}>Changes</Text>
        <View style={local.grow} />
        {totals ? <Totals totals={totals} /> : null}
        <Icon name="chevronRight" size={18} color={palette.dim} />
      </Tappable>
    </View>
  );
}

function Totals({ totals }: { totals: ChangeTotals }) {
  const palette = usePalette();
  if (totals.files === 0) {
    return (
      <Text style={[local.totals, { color: palette.muted }]} accessibilityElementsHidden>
        No changes
      </Text>
    );
  }
  return (
    <Text style={[local.totals, { color: palette.muted }]} numberOfLines={1} accessibilityElementsHidden>
      <Text style={{ color: palette.tones.green.ink }}>{`+${totals.additions.toLocaleString("en-US")}`}</Text>
      <Text style={{ color: palette.tones.red.ink }}>{` −${totals.deletions.toLocaleString("en-US")}`}</Text>
      {` in ${totals.files.toLocaleString("en-US")} ${totals.files === 1 ? "file" : "files"}`}
    </Text>
  );
}

/** The worktree's changed files, each opening its diff, and the one Git action the desktop offers for them. */
export function ChangesScreen({ worktreeId }: { worktreeId: string }) {
  const navigation = useNavigation();
  const link = useLink();
  const snapshot = useLinkSnapshot();
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const projection = snapshot.projection;
  const worktree = projection?.worktrees.find((candidate) => candidate.worktreeId === worktreeId);
  const noGit =
    projection?.projects.some((project) => project.projectId === worktree?.projectId && project.git === false) ?? false;
  const review = reviewFor(projection, worktreeId);
  const online = snapshot.state.kind === "online";
  const ready = worktree?.status === "ready";
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string>();
  const [branches, setBranches] = useState<GitBranchesResult>();
  const [message, setMessage] = useState("");
  const [running, setRunning] = useState<{ plan: CommitPlan; phase: "committing" | "pushing" }>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const read = useCallback(async () => {
    setReading(true);
    setReadError(undefined);
    const [outcome, listed] = await Promise.all([refreshChanges(link, worktreeId), readBranches(link, worktreeId)]);
    if (listed) setBranches(listed);
    if (!outcome.ok) setReadError(outcome.error);
    setReading(false);
  }, [link, worktreeId]);

  useEffect(() => {
    if (online && ready && !noGit) void read();
  }, [online, ready, noGit, read]);

  // While Git works the plan stays as it was confirmed, so the button does not change under the person.
  const plan = running?.plan ?? commitPlan(review, branches);
  const branchName = branches?.current ?? review?.branch ?? worktree?.branch ?? "";
  const actionLabel =
    plan.kind === "push" ? "Push" : plan.kind === "commit" && plan.push ? "Commit and push" : "Commit";

  const finish = (outcome: GitOutcome) => {
    setRunning(undefined);
    if (!outcome.ok) {
      setError(outcome.error);
      return;
    }
    setNotice(outcome.notice);
    setMessage("");
    void readBranches(link, worktreeId).then((listed) => listed && setBranches(listed));
  };

  const run = async (confirmed: CommitPlan) => {
    setError(undefined);
    setNotice(undefined);
    if (confirmed.kind === "push") {
      setRunning({ plan: confirmed, phase: "pushing" });
      finish(await pushBranch(link, worktreeId));
      return;
    }
    if (confirmed.kind !== "commit") return;
    setRunning({ plan: confirmed, phase: "committing" });
    finish(
      await commitChanges(link, {
        worktreeId,
        message,
        push: confirmed.push,
        onPushing: () => setRunning({ plan: confirmed, phase: "pushing" }),
      }),
    );
  };

  // Committing changes the person's repository, so it is asked once before it happens.
  const confirm = () => {
    if (running) return;
    const confirmed = plan;
    if (confirmed.kind === "push") {
      Alert.alert(`Push ${branchName} to origin?`, confirmed.reason, [
        { text: "Cancel", style: "cancel" },
        { text: "Push", onPress: () => void run(confirmed) },
      ]);
      return;
    }
    if (confirmed.kind !== "commit" || !review || !message.trim()) return;
    const count = filesToCommit(review, confirmed);
    Alert.alert(
      `${actionLabel} ${count.toLocaleString("en-US")} ${count === 1 ? "file" : "files"}?`,
      `${branchName ? `On ${branchName}. ` : ""}${commitHint(confirmed)}`,
      [
        { text: "Cancel", style: "cancel" },
        { text: actionLabel, onPress: () => void run(confirmed) },
      ],
    );
  };

  const header = (
    <Header
      title="Changes"
      {...(branchName ? { subtitle: branchName, subtitleMono: true } : {})}
      onBack={navigation.back}
      actions={
        worktree && !noGit ? (
          <IconButton
            icon="reload"
            label="Read the changes again"
            variant="plain"
            busy={reading}
            disabled={!online}
            onPress={() => void read()}
          />
        ) : undefined
      }
    />
  );

  if (!projection || !worktree || noGit || !review) {
    return (
      <View style={[local.screen, { backgroundColor: palette.canvas }]}>
        {header}
        <ConnectionBanner />
        {!projection ? (
          <EmptyState busy title="Loading the changes" />
        ) : !worktree ? (
          <EmptyState
            icon="diff"
            title="This worktree is gone"
            message="It was removed on the desktop."
            action={{ label: "Back", onPress: navigation.back }}
          />
        ) : noGit ? (
          <EmptyState
            icon="folder"
            title="Not a Git repository"
            message="This folder has no changes or branches to show."
          />
        ) : readError && !reading ? (
          <EmptyState
            icon="alert"
            title="The changes could not be read"
            message={readError}
            action={{ label: "Try again", onPress: () => void read() }}
          />
        ) : (
          <EmptyState busy title="Reading the changes" />
        )}
      </View>
    );
  }

  const files = review.files;
  const totals = changeTotals(files);
  const hint = plan.kind === "commit" ? commitHint(plan) : plan.kind === "push" ? plan.reason : undefined;
  const phase = running?.phase;

  return (
    <KeyboardAvoidingView behavior="padding" style={[local.screen, { backgroundColor: palette.canvas }]}>
      {header}
      <ConnectionBanner />
      <ScrollView
        contentContainerStyle={[local.content, { paddingBottom: insets.bottom + space.xl }]}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={reading}
            onRefresh={() => void read()}
            tintColor={palette.muted}
            colors={[palette.accent]}
            progressBackgroundColor={palette.raised}
          />
        }
      >
        {readError ? (
          <Notice
            tone="warning"
            title="These may be out of date"
            message={readError}
            action={{ label: "Try again", onPress: () => void read() }}
          />
        ) : null}
        {review.errorMessage && !error ? (
          <Notice tone="error" title="Git reported an error" message={review.errorMessage} />
        ) : null}
        {review.state === "conflicted" ? (
          <Notice
            tone="warning"
            title="A merge is in progress"
            message="Finish or abort it in Changes on the desktop, then commit here."
          />
        ) : null}
        {files.length === 0 ? (
          <EmptyState
            icon="check"
            title="No changes"
            message={
              review.baseRef === "HEAD"
                ? `${branchName || "This worktree"} matches its last commit.`
                : `Nothing differs from ${review.baseRef}.`
            }
          />
        ) : (
          <Section
            title={review.baseRef === "HEAD" ? "Uncommitted changes" : `Changes against ${review.baseRef}`}
            aside={<Totals totals={totals} />}
          >
            {files.map((file) => (
              <FileRow
                key={file.path}
                file={file}
                review={review}
                onOpen={() => navigation.push({ name: "diff", worktreeId, path: file.path })}
              />
            ))}
          </Section>
        )}
        {plan.kind === "commit" || plan.kind === "push" ? (
          <Section title={plan.kind === "push" ? "Push" : "Commit"} footer={hint}>
            <View style={local.commit}>
              {plan.kind === "commit" ? (
                <Field
                  accessibilityLabel="Commit message"
                  placeholder="Commit message"
                  value={message}
                  onChangeText={setMessage}
                  editable={!running}
                  returnKeyType="done"
                  submitBehavior="blurAndSubmit"
                  onSubmitEditing={confirm}
                  maxLength={10_000}
                />
              ) : null}
              <Button
                label={actionLabel}
                icon={plan.kind === "push" ? "upload" : "commit"}
                variant="primary"
                busy={!!phase}
                busyLabel={phase === "pushing" ? "Pushing…" : "Committing…"}
                disabled={!online || (plan.kind === "commit" && !message.trim())}
                {...(hint ? { accessibilityHint: hint } : {})}
                onPress={confirm}
              />
            </View>
          </Section>
        ) : null}
        {error ? <Notice tone="error" message={error} /> : null}
        {notice && !error ? (
          <View style={local.done} accessibilityRole="text" accessibilityLiveRegion="polite">
            <Icon name="check" size={16} color={palette.tones.green.ink} />
            <Text style={[local.doneText, { color: palette.text }]}>{notice}</Text>
          </View>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function FileRow({
  file,
  review,
  onOpen,
}: {
  file: ReviewFileProjection;
  review: ReviewProjection;
  onOpen: () => void;
}) {
  const palette = usePalette();
  const kind = fileKind(file);
  const { name, folder } = splitPath(file.path);
  const unavailable = diffUnavailable(file, review);
  const detail = unavailable ?? (file.oldPath ? `Renamed from ${file.oldPath}` : undefined);
  const spoken = [
    name,
    kind.label,
    folder ? `in ${folder}` : "",
    file.binary ? "" : `${file.additions} added, ${file.deletions} removed`,
    detail ?? "",
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <Row
      leading={<KindBadge kind={kind} />}
      title={name}
      titleMono
      subtitle={folder || undefined}
      subtitleMono
      detail={detail}
      trailing={
        file.binary ? undefined : (
          <Text style={[local.counts, { color: palette.muted }]} accessibilityElementsHidden>
            <Text style={{ color: palette.tones.green.ink }}>{`+${file.additions.toLocaleString("en-US")}`}</Text>
            <Text style={{ color: palette.tones.red.ink }}>{` −${file.deletions.toLocaleString("en-US")}`}</Text>
          </Text>
        )
      }
      chevron={!unavailable}
      onPress={unavailable ? undefined : onOpen}
      accessibilityLabel={spoken}
      {...(unavailable ? {} : { accessibilityHint: "Shows the diff" })}
    />
  );
}

/** The status letter Git prints, in the Git state's color. */
export function KindBadge({ kind }: { kind: FileKindView }) {
  const palette = usePalette();
  const tone = palette.tones[kind.tone];
  return (
    <View style={[local.badge, { backgroundColor: tone.soft }]} accessibilityElementsHidden>
      <Text style={[local.badgeLetter, { color: tone.ink }]}>{kind.letter}</Text>
    </View>
  );
}

const local = StyleSheet.create({
  screen: { flex: 1 },
  grow: { flex: 1 },
  entryWrap: { paddingHorizontal: space.md, paddingBottom: space.xs },
  entry: {
    minHeight: TAP,
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
  },
  entryLabel: { ...type.footnote, fontWeight: "600" },
  totals: { ...type.meta, fontVariant: ["tabular-nums"], flexShrink: 1 },
  content: { paddingHorizontal: space.md, paddingTop: space.xs, gap: space.lg, flexGrow: 1 },
  counts: { ...type.meta, fontFamily: mono, fontVariant: ["tabular-nums"] },
  badge: { width: 24, height: 24, borderRadius: radius.sm - 2, alignItems: "center", justifyContent: "center" },
  badgeLetter: { fontFamily: mono, ...type.caption, fontWeight: "700" },
  commit: { padding: space.md, gap: space.md },
  done: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.xs },
  doneText: { ...type.footnote, flex: 1 },
});
