import type { SearchSettings } from "./FileSearchView.js";

/** What the Files panel remembers per worktree while it is closed or showing another worktree. */
export type FilesSession = {
  tabs: string[];
  activePath: string | undefined;
  /** Unsaved editor text by path; only dirty files have an entry. */
  drafts: Map<string, string>;
  expanded: Set<string>;
  mode: "tree" | "search";
  changedOnly: boolean;
  /** Whether the Changed group above the tree is expanded. */
  changedOpen: boolean;
  diffSource: "uncommitted" | "turn";
  search: SearchSettings;
};

export function emptyFilesSession(): FilesSession {
  return {
    tabs: [],
    activePath: undefined,
    drafts: new Map(),
    expanded: new Set(),
    mode: "tree",
    changedOnly: false,
    changedOpen: true,
    diffSource: "uncommitted",
    search: { query: "", caseSensitive: false, regex: false },
  };
}
