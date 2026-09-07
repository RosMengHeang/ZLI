# Handoff: Git / Worktree / Review Subsystem (Engineer C)

Owner: Engineer C (Claude Code). Scope: `src-tauri/src/git/` and the `git_*`
Tauri command registrations in `src-tauri/src/lib.rs`. Covers roadmap
milestones **v0.3** (worktree isolation) and **v0.4** (status/diff/review/
commit/merge/discard).

## Architecture

```
React/UI  ->  src/tauri/git.ts, src/tauri/project.ts  ->  git_* Tauri commands
                                                        ->  src-tauri/src/git/commands.rs (thin wrappers)
                                                        ->  src-tauri/src/git/{repo,worktree,status,diff,commit,merge}.rs
                                                        ->  src-tauri/src/git/process.rs (Command::new("git"), argv only)
                                                        ->  git CLI
```

Every module:
- `error.rs` — `GitError`, a `#[serde(tag = "kind", content = "details")]`
  enum. Frontend already has a matching parser in `src/lib/errors.ts`
  (`messageFromGitError` switches on `err.kind`).
- `process.rs` — the *only* place that spawns `git`. Always `Command::new("git").args([...])`
  (never a shell string), always `current_dir(cwd)`, always
  `CREATE_NO_WINDOW` on Windows so no console flashes. `run_git` errors on
  non-zero exit with a sanitized (truncated, stripped) message; `run_git_probe`
  never errors, for "does this ref/condition exist" checks.
- `paths.rs` — `canonical_dir` validates existence/directory-ness and
  resolves via `dunce::canonicalize` (not `std::Path::canonicalize`, which
  prepends the Windows `\\?\` UNC prefix that breaks tools downstream, e.g.
  a launched agent process using the path as `cwd`).
- `repo.rs` — `validate_repository`, base-branch detection.
- `worktree.rs` — `create_worktree` / `list_worktrees` / `remove_worktree` / `delete_branch`.
- `status.rs` / `diff.rs` — structured status + unified diffs.
- `commit.rs` / `merge.rs` — explicit commit workflow, safe merge workflow.
- `commands.rs` — `#[tauri::command]` wrappers, registered in `lib.rs`.
- `workflow_tests.rs` — `#[cfg(test)]`, exercises the full lifecycle against
  disposable `tempfile` repos (see **Tests performed**).

## Tauri commands (registered in `lib.rs`'s `invoke_handler!`)

| Command | Params (camelCase over IPC) | Returns |
|---|---|---|
| `git_validate_repository` | `path` | `RepositoryInfo` |
| `git_create_worktree` | `request: CreateWorktreeRequest` | `CreateWorktreeResult` |
| `git_list_worktrees` | `repositoryRoot` | `WorktreeInfo[]` |
| `git_remove_worktree` | `request: RemoveWorktreeRequest` | `RemovedWorktreeResult` |
| `git_delete_branch` | `request: DeleteBranchRequest` | `void` |
| `git_status` | `worktreePath` | `GitStatus` |
| `git_diff` | `worktreePath`, `filePath?` | `FileDiff[]` |
| `git_commit` | `request: CommitRequest` | `CommitResult` |
| `git_merge` | `request: MergeRequest` | `MergeOutcome` |
| `git_abort_merge` | `repositoryRoot` | `void` |

Tauri's command macro auto-converts snake_case Rust arg/field names to
camelCase over IPC, so `#[serde(rename_all = "camelCase")]` on every
request/response struct keeps Rust and TypeScript in lockstep without manual
renaming. **Gotcha found and fixed**: that `rename_all` does *not* cascade
from an enum container into a struct variant's own fields — `MergeOutcome`
needed `#[serde(rename_all = "camelCase")]` on each variant individually, or
`commitHash`/`targetBranch`/etc. would have serialized as snake_case.

Frontend side (already built against this exact contract, independently
converging on the same shapes): `src/tauri/git.ts`, `src/tauri/project.ts`,
`src/types/models.ts`, `src/types/commands.ts` (`GIT_COMMANDS` map).

## Request/response structures

See `src/types/models.ts` for the canonical TS shapes (they match the Rust
structs field-for-field). Highlights:

- `RepositoryInfo { path, repositoryRoot, currentBranch, detachedHead, baseBranch, clean }`
- `CreateWorktreeRequest { repositoryRoot, provider, baseBranch? }` ->
  `CreateWorktreeResult { branch, worktreePath, baseBranch }` — `worktreePath`
  is an absolute, canonical path with no Git knowledge required downstream;
  it's meant to be handed directly to the agent-launcher as `cwd`.
- `GitStatus { branch, clean, changedFiles, additions, deletions }`,
  `ChangedFile { path, originalPath?, status, staged, additions, deletions }`
  — `additions`/`deletions` are `number | null`: `null` means "not practical
  to compute" (binary files), not "zero".
- `FileDiff { path, originalPath?, status, diff, binary }` — `diff` is raw
  unified-diff text from `git diff`, ready for a diff viewer component.
- `MergeOutcome` is a **result**, not an error — `{ outcome: "success", ... }`
  or `{ outcome: "conflict", ... }`. A conflict is an expected, structured
  return value the UI branches on; it is never thrown as a `GitError`.

## Worktree storage strategy

`<repo-parent>/<repo-dir-name>.worktrees/<provider-slug>-<shortid>/`, e.g.
`D:\Taxzy_CLI.worktrees\codex-a1b2c3d4\`. Always a **sibling** of the
repository root, never nested inside it — this matches the convention
Swarmterm's own `worktree.spawn` MCP tool uses, and structurally rules out a
worktree ever landing somewhere Git is already tracking. The directory is
created on demand (`create_dir_all`) the first time a worktree is requested.

## Branch strategy

`swarm/<provider-slug>-<shortid>` (e.g. `swarm/claude-code-9f3a1b2c`).
`provider-slug` is the lowercased, alphanumeric-collapsed provider id
(`claude-code`, `codex`, `cursor-agent`, `shell`, ...). The 8-char id is
random (`rand`), retried up to 10x against both branch and directory name
collisions. `delete_branch` refuses anything outside the `swarm/` prefix —
this app will never delete a human's own branch.

## Status / diff behavior

- Status: `git status --porcelain=v1 -z` (null-separated — filenames with
  spaces/unicode need no escaping-fu), classified into
  `added/modified/deleted/renamed/copied/untracked/typeChanged/unmerged`.
  Per-file additions/deletions come from `git diff --numstat` (unstaged) +
  `git diff --cached --numstat` (staged), merged by path; untracked files
  get a best-effort count via `git diff --no-index NUL <file>` (Windows) /
  `/dev/null` (elsewhere) and fall back to `null` for binaries.
- Diff: per file, `git diff HEAD -M -- <path>` (both staged + unstaged vs
  HEAD in one pass) once a HEAD exists, else `git diff --cached`; untracked
  files use the same `--no-index` trick as above. "Overall diff" is just
  "diff with no `filePath` filter" — one `FileDiff` per changed file, so the
  frontend can render a file list + per-file panes from one call.

## Commit behavior

Never runs unless explicitly invoked with a non-empty message
(`CommitRequest.message`, trimmed and validated). `stageAll: true` runs
`git add -A` first (scoped to that worktree's own index — each linked
worktree has an independent index); otherwise only what's already staged is
committed. Refuses with `NothingToCommit` if nothing is staged. Returns
hash/shortHash/author/`filesChanged`/`additions`/`deletions` parsed from
`git show --shortstat`.

## Merge behavior

`git_merge` pre-flight, in order: resolve target branch (explicit or
detected base branch) -> reject `source == target` -> verify both branches
exist -> **require the repository-root worktree to be clean** (refuses with
`DirtyWorktree` otherwise — a merge is never allowed to touch a dirty
tree) -> checkout target branch if not already on it (safe: Git itself
refuses a checkout that would clobber anything, and we already know the tree
is clean) -> `git merge --no-ff -m "..." <source>`.

- Success -> `MergeOutcome::Success { commitHash, targetBranch, sourceBranch, fastForward }`.
- Conflict -> the merge is **left exactly as Git left it** (`MERGE_HEAD`
  present, conflict markers in files) and `MergeOutcome::Conflict {
  targetBranch, sourceBranch, conflictedFiles }` is returned so the UI can
  show what needs resolving. Nothing is auto-aborted or auto-resolved.
- A separate `git_abort_merge` command runs `git merge --abort` — only ever
  on the caller's explicit request, to bail out of a conflict the user
  doesn't want to resolve by hand.
- No `reset --hard`, force checkout, or force push anywhere in this module.

## Discard safeguards (worktree removal + branch cleanup)

- `git_remove_worktree { repositoryRoot, worktreePath, force }`: refuses
  (`DirtyWorktree`) unless the worktree is clean, **unless** `force: true` is
  explicitly passed — there is no default-true path, no inference from
  context. Also refuses to ever remove the repository's main worktree.
- `git_delete_branch { repositoryRoot, branch, force }`: refuses any branch
  outside the `swarm/` namespace (never touches a human's own branch), and
  refuses if the branch is still checked out in a worktree (remove that
  first). `force: false` uses `git branch -d` (Git's own "only if merged"
  safety net); `force: true` uses `-D`.
- These are two separate commands by design — the frontend's discard flow
  (`gitStore.discardWorktree`) calls remove-worktree first, then
  best-effort branch cleanup, so a branch-cleanup failure never blocks the
  (already-completed) worktree removal.

## Tests performed

`src-tauri/src/git/workflow_tests.rs`, run via `cargo test --lib git::`,
each test builds its own disposable repo with `tempfile::tempdir()` (never
touches a real project):

1. `full_worktree_review_workflow` — init repo -> `validate_repository` ->
   `create_worktree` -> modify a file -> `get_status` detects it
   (Modified) -> `get_diff` (overall + per-file) contains the change ->
   `commit` -> `merge_branch` (clean, no-conflict) succeeds and the change
   lands in the repo root -> `remove_worktree` (clean) succeeds.
2. `refuses_to_remove_dirty_worktree_without_explicit_force` — creates an
   untracked file in a worktree, confirms `remove_worktree(force: false)`
   returns `DirtyWorktree` and deletes nothing, then confirms
   `force: true` proceeds.
3. `detects_merge_conflicts_and_leaves_them_for_manual_resolution` —
   diverges the same line on two branches, confirms `merge_branch` returns
   `MergeOutcome::Conflict` (not an `Err`) with the right file list, confirms
   conflict markers are actually on disk (nothing silently resolved), then
   confirms `abort_merge` cleanly restores the pre-merge state.

`cargo fmt`, `cargo check`, and `cargo clippy` were run clean against the
`git` module (zero warnings) before the PTY/agent modules were added to the
crate by another engineer — see **Known limitations** for the current status
of a whole-crate build.

## Known limitations

- **Whole-crate build currently blocked by sibling modules, not this one.**
  This repo has no worktree isolation between engineers in practice (all
  three of us share one working directory/index — see note below); as of
  this commit, `src-tauri/src/pty/mod.rs` (owned by the PTY/agent engineer)
  references symbols (`PtyManager`, `MemoryEventSink`) that don't exist yet,
  so `cargo test`/`cargo build` for the *whole* crate fails until that
  lands. The `git` module itself was verified clean (`fmt`/`check`/`clippy`/
  `test`) in isolation before those files existed; nothing in `git/` was
  touched afterward. Re-run `cargo test --lib git::` once `pty` compiles.
- Per-file additions/deletions for untracked files rely on `git diff
  --no-index` against the OS null device; this works but is best-effort —
  binary files and any future non-Windows/non-Unix target would fall back to
  `null` counts rather than erroring.
- `determine_base_branch` is a heuristic (`origin/HEAD` -> `main`/`master`/
  `develop` -> current branch). A repo with an unconventional default branch
  name and no `origin` remote will fall back to "whatever's checked out",
  which callers should treat as a best guess, not a guarantee.
- No stash-based recovery path is implemented anywhere — this is
  intentional per the "never silently destroy work" requirement; every
  destructive-shaped operation (merge, remove-worktree) either refuses on
  dirty state or requires an explicit `force`.

## Integration instructions

- **Frontend (Cursor)**: nothing further needed for the git surface —
  `src/tauri/git.ts` + `src/types/{models,commands}.ts` already match this
  API exactly (command names, field names, the `MergeOutcome`
  discriminated union, the `GitError`-shaped rejections). If you add new
  git-adjacent UI, extend `src/types/models.ts` first and keep
  `#[serde(rename_all = "camelCase")]` in mind if you ask for a new Rust
  field.
- **Agent runtime (Codex)**: call `git_create_worktree` (or the equivalent
  Rust fn `git::worktree::create_worktree` if you're same-crate) to get an
  isolated `worktreePath` + `branch` for a new agent — treat `worktreePath`
  as an opaque `cwd` string, no Git knowledge required on your side. When an
  agent finishes, the UI's discard/merge flows call back into this module;
  you don't need to touch Git directly for lifecycle management.
- Both of you: please append to `invoke_handler![...]` in `lib.rs` rather
  than replacing the list — we're all editing that one file directly.

## Repo-sharing note (important context, not a request for action)

This environment does **not** actually give each engineer a separate Git
worktree, despite the brief describing one — all three of us have been
editing the same `D:\Taxzy_CLI` working directory and the same (until this
commit, commit-less) Git index concurrently. I `git init`'d the repo and
laid down the initial Tauri/React/Vite scaffold since nothing existed yet
and no one else had claimed it (confirmed via the War Room before
proceeding). This commit is scoped to `src-tauri/src/git/**`,
`src-tauri/src/lib.rs`/`main.rs`, `src-tauri/Cargo.toml`/`Cargo.lock`, and
this doc — it deliberately does **not** include the frontend (`src/`) or the
PTY/agent modules (`src-tauri/src/{agents,pty,system}`, `commands.rs`,
`error.rs`), or the wider scaffold config (`package.json`, `vite.config.ts`,
etc.) now substantially shaped by the frontend engineer — those remain for
their respective owners to commit.
