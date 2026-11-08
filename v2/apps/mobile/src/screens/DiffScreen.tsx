import type { FileDiffResult } from "@zli-v2/contracts";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useLink, useLinkSnapshot } from "../LinkContext.js";
import {
  DIFF_LINE_CHARS,
  type DiffLine,
  fileKind,
  parseDiff,
  readFileDiff,
  reviewFor,
  splitPath,
} from "../lib/changes.js";
import { useNavigation } from "../navigation.js";
import { mono, type Palette, radius, space, usePalette } from "../theme.js";
import { EmptyState, Header, Notice } from "../ui/components.js";
import { KindBadge } from "./ChangesScreen.js";
import { ConnectionBanner } from "./ConnectionBanner.js";

type DiffState = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; diff: FileDiffResult };

/** One file's uncommitted diff, read-only. Long lines scroll sideways instead of wrapping, as in a terminal. */
export function DiffScreen({ worktreeId, path }: { worktreeId: string; path: string }) {
  const navigation = useNavigation();
  const link = useLink();
  const snapshot = useLinkSnapshot();
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const online = snapshot.state.kind === "online";
  const [state, setState] = useState<DiffState>({ kind: "loading" });
  const loaded = state.kind === "ready";

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    const outcome = await readFileDiff(link, worktreeId, path);
    setState(outcome.ok ? { kind: "ready", diff: outcome.diff } : { kind: "error", message: outcome.error });
  }, [link, worktreeId, path]);

  useEffect(() => {
    if (online && !loaded) void load();
  }, [online, loaded, load]);

  const file = reviewFor(snapshot.projection, worktreeId)?.files.find((candidate) => candidate.path === path);
  const { name } = splitPath(path);
  const parsed = useMemo(() => (state.kind === "ready" ? parseDiff(state.diff.patch) : undefined), [state]);

  const notes = [
    parsed?.truncated
      ? `Showing the first ${parsed.lines.length.toLocaleString("en-US")} of ${parsed.total.toLocaleString("en-US")} lines.`
      : "",
    state.kind === "ready" && state.diff.truncated
      ? "The desktop sent only the start of this diff because it is very large."
      : "",
    parsed?.clipped ? `Lines longer than ${DIFF_LINE_CHARS} characters are cut short.` : "",
  ].filter(Boolean);

  let body: ReactNode;
  if (state.kind === "loading") {
    body = <EmptyState busy title="Reading the diff" />;
  } else if (state.kind === "error") {
    body = (
      <EmptyState
        icon="alert"
        title="The diff could not be read"
        message={state.message}
        action={{ label: "Try again", onPress: () => void load() }}
      />
    );
  } else if (state.diff.binary) {
    body = <EmptyState icon="file" title="Binary file" message="ZLI shows line changes for text files only." />;
  } else if (!parsed || parsed.lines.length === 0) {
    body = (
      <EmptyState
        icon="check"
        title="No uncommitted changes"
        message="This file matches its last commit now. Go back and read the changes again."
      />
    );
  } else {
    const width = String(Math.max(1, ...parsed.lines.map((line) => line.number ?? 0))).length;
    body = (
      <>
        {notes.length > 0 ? (
          <View style={local.note}>
            <Notice tone="info" message={`${notes.join(" ")} The full diff is in Changes on the desktop.`} />
          </View>
        ) : null}
        <ScrollView
          style={[local.diff, { backgroundColor: palette.surface }]}
          contentContainerStyle={[local.diffContent, { paddingBottom: space.sm }]}
        >
          <ScrollView horizontal contentContainerStyle={local.wide}>
            <View style={local.lines}>
              {parsed.lines.map((line, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: lines repeat, and a diff's order never changes.
                <Line key={index} line={line} width={width} palette={palette} first={index === 0} />
              ))}
            </View>
          </ScrollView>
        </ScrollView>
        <View style={{ height: insets.bottom + space.sm }} />
      </>
    );
  }

  return (
    <View style={[local.screen, { backgroundColor: palette.canvas }]}>
      <Header
        title={name}
        subtitle={path}
        subtitleMono
        {...(file ? { leading: <KindBadge kind={fileKind(file)} /> } : {})}
        onBack={navigation.back}
      />
      <ConnectionBanner />
      {body}
    </View>
  );
}

function Line({ line, width, palette, first }: { line: DiffLine; width: number; palette: Palette; first: boolean }) {
  const colors =
    line.kind === "add"
      ? { backgroundColor: palette.tones.green.soft, color: palette.tones.green.ink }
      : line.kind === "del"
        ? { backgroundColor: palette.tones.red.soft, color: palette.tones.red.ink }
        : line.kind === "hunk"
          ? { backgroundColor: palette.tones.blue.soft, color: palette.tones.blue.ink }
          : { backgroundColor: "transparent", color: line.kind === "note" ? palette.dim : palette.muted };
  const gutter = line.number === undefined ? " ".repeat(width) : String(line.number).padStart(width);
  return (
    <Text selectable style={[local.line, colors, line.kind === "hunk" && !first ? local.hunkGap : null]}>
      <Text style={{ color: palette.dim }}>{`${gutter}  `}</Text>
      {line.text || " "}
    </Text>
  );
}

const local = StyleSheet.create({
  screen: { flex: 1 },
  note: { paddingHorizontal: space.md, paddingBottom: space.sm },
  diff: { flex: 1, marginHorizontal: space.md, borderRadius: radius.island },
  diffContent: { paddingTop: space.sm },
  wide: { flexGrow: 1 },
  lines: { flexGrow: 1 },
  line: { fontFamily: mono, fontSize: 12, lineHeight: 18, paddingHorizontal: space.md, fontVariant: ["tabular-nums"] },
  hunkGap: { marginTop: space.sm },
});
