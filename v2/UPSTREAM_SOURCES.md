# Upstream source ledger

ZLI V2 is informed by two MIT-licensed projects pinned to immutable revisions. Add a row before copying or translating any source unit.

| Repository | Commit | Source path | Local path | Reuse type | Modifications | License |
|---|---|---|---|---|---|---|
| `pingdotgg/t3code` | `584450a1f198c8592d28947a0a7a060d28013298` | `docs/internals/overview.md` | Architecture only | Architecture reference | Environment ownership and durable intent inform V2 boundaries | MIT |
| `stablyai/orca` | `5b8ac36f41a5619a7a60a80df8ada20965fb260f` | `docs/site/content/docs/model/session-restore.mdx` | Architecture only | Architecture reference | Detached session restoration informs V2 lifecycle | MIT |
| `stablyai/orca` | `5b8ac36f41a5619a7a60a80df8ada20965fb260f` | `docs/site/content/docs/model/worktrees.mdx` | Architecture only | Architecture reference | Worktree-first lifecycle informs V2 orchestration | MIT |
| `stablyai/orca` | `5b8ac36f41a5619a7a60a80df8ada20965fb260f` | `docs/site/content/docs/browser/overview.mdx` | Architecture only | Architecture reference | Per-worktree Chromium behavior informs V2 browser scope | MIT |
