//! Git worktree lifecycle: create isolated checkouts for coding agents,
//! list them, and safely remove/clean them up.
//!
//! Storage strategy: worktrees live as siblings of the repository, at
//! `<repo-parent>/<repo-dir-name>.worktrees/<branch-slug>` — never nested
//! inside the repository's own working tree. This matches the convention
//! Swarmterm's own `worktree.spawn` tool uses and sidesteps any risk of a
//! worktree recursively landing inside a path Git is already tracking.

use super::error::GitError;
use super::paths::{canonical_dir, to_display_string};
use super::process::{run_git, run_git_probe};
use super::repo::{determine_base_branch, is_clean};
use rand::Rng;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

const ACTIVE_BRANCH_PREFIX: &str = "zli/";
const LEGACY_BRANCH_PREFIX: &str = "swarm/";
const WORKTREE_CLEANUP_RETRY_DELAY: Duration = Duration::from_millis(250);
const MAX_WORKTREE_CLEANUP_RETRIES: usize = 5;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub path: String,
    pub branch: Option<String>,
    pub head: String,
    pub is_main: bool,
    pub locked: bool,
    pub prunable: bool,
    pub orphaned: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorktreeAuditState {
    Main,
    RegisteredClean,
    RegisteredDirty,
    RegisteredUnknown,
    Locked,
    PrunableMetadata,
    OrphanedEmpty,
    OrphanedNonEmpty,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeAuditEntry {
    pub path: String,
    pub branch: Option<String>,
    pub state: WorktreeAuditState,
    pub clean: Option<bool>,
    pub safe_to_remove_without_force: bool,
    pub safe_to_prune_metadata: bool,
    pub requires_force: bool,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeAudit {
    pub repository_root: String,
    pub storage_root: String,
    pub entries: Vec<WorktreeAuditEntry>,
    pub removable_without_force_count: usize,
    pub prunable_metadata_count: usize,
    pub requires_force_count: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateWorktreeRequest {
    pub repository_root: String,
    /// Short provider slug, e.g. "claude-code", "codex", "cursor-agent", "shell".
    pub provider: String,
    /// Branch point; defaults to the repository's detected base branch.
    pub base_branch: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateWorktreeResult {
    pub branch: String,
    /// Absolute path, ready to hand to an agent launcher as `cwd` — no Git
    /// knowledge required downstream.
    pub worktree_path: String,
    pub base_branch: String,
}

pub fn create_worktree(req: CreateWorktreeRequest) -> Result<CreateWorktreeResult, GitError> {
    let repo_dir = canonical_dir(&req.repository_root)?;
    ensure_is_repo(&repo_dir, &req.repository_root)?;

    let base_branch = match req.base_branch {
        Some(b) if !b.trim().is_empty() => b,
        _ => {
            let (current, _) = super::repo::current_branch(&repo_dir);
            determine_base_branch(&repo_dir, current.as_deref()).ok_or_else(|| {
                GitError::InvalidInput {
                    message: "could not determine a base branch; specify one explicitly"
                        .to_string(),
                }
            })?
        }
    };
    if !run_git_probe(&repo_dir, &["rev-parse", "--verify", "-q", &base_branch]).0
        && !run_git_probe(
            &repo_dir,
            &[
                "rev-parse",
                "--verify",
                "-q",
                &format!("origin/{base_branch}"),
            ],
        )
        .0
    {
        return Err(GitError::BranchNotFound {
            branch: base_branch,
        });
    }

    let provider_slug = slugify(&req.provider);
    let worktrees_root = sibling_worktrees_dir(&repo_dir)?;
    std::fs::create_dir_all(&worktrees_root).map_err(|e| GitError::Io {
        message: format!(
            "failed to create worktree storage directory '{}': {e}",
            worktrees_root.display()
        ),
    })?;

    let (branch, worktree_path) = allocate_unique_slot(&repo_dir, &worktrees_root, &provider_slug)?;

    run_git(
        &repo_dir,
        &[
            "worktree",
            "add",
            "-b",
            &branch,
            worktree_path.to_string_lossy().as_ref(),
            &base_branch,
        ],
    )?;

    let resolved = canonical_dir(worktree_path.to_string_lossy().as_ref())?;

    Ok(CreateWorktreeResult {
        branch,
        worktree_path: to_display_string(&resolved),
        base_branch,
    })
}

pub fn list_worktrees(repository_root: &str) -> Result<Vec<WorktreeInfo>, GitError> {
    let repo_dir = canonical_dir(repository_root)?;
    ensure_is_repo(&repo_dir, repository_root)?;

    let out = run_git(&repo_dir, &["worktree", "list", "--porcelain"])?;
    let mut worktrees = parse_worktree_list(&out.stdout);
    append_orphaned_slots(&repo_dir, &mut worktrees)?;
    Ok(worktrees)
}

/// Inspect worktree state without mutating Git metadata or deleting files.
///
/// A registered checkout is never marked safe solely because it is clean: the
/// runtime may still own its terminal or provider process. Only empty,
/// unregistered agent slots are safe for non-forced filesystem cleanup.
pub fn audit_worktrees(repository_root: &str) -> Result<WorktreeAudit, GitError> {
    let repo_dir = canonical_dir(repository_root)?;
    ensure_is_repo(&repo_dir, repository_root)?;
    let storage_root = sibling_worktrees_dir(&repo_dir)?;

    let out = run_git(&repo_dir, &["worktree", "list", "--porcelain"])?;
    let mut worktrees = parse_worktree_list(&out.stdout);
    append_orphaned_slots(&repo_dir, &mut worktrees)?;
    normalize_existing_worktree_paths(&mut worktrees);

    let mut entries = Vec::with_capacity(worktrees.len());
    for worktree in worktrees {
        let path = Path::new(&worktree.path);
        let (
            state,
            clean,
            safe_to_remove_without_force,
            safe_to_prune_metadata,
            requires_force,
            note,
        ) =
            if worktree.is_main {
                (
                    WorktreeAuditState::Main,
                    None,
                    false,
                    false,
                    false,
                    Some("The repository worktree is protected.".to_string()),
                )
            } else if worktree.locked {
                (
                    WorktreeAuditState::Locked,
                    None,
                    false,
                    false,
                    false,
                    Some("Unlock this worktree explicitly before removing it.".to_string()),
                )
            } else if worktree.prunable {
                (
                    WorktreeAuditState::PrunableMetadata,
                    None,
                    false,
                    true,
                    false,
                    Some("Only stale Git metadata can be pruned.".to_string()),
                )
            } else if worktree.orphaned {
                match directory_has_entries(path) {
                    Ok(true) => (
                        WorktreeAuditState::OrphanedNonEmpty,
                        None,
                        false,
                        false,
                        true,
                        Some(
                            "Unregistered files are protected; review them before forced cleanup."
                                .to_string(),
                        ),
                    ),
                    Ok(false) => (
                        WorktreeAuditState::OrphanedEmpty,
                        None,
                        true,
                        false,
                        false,
                        Some("Empty unregistered agent slot.".to_string()),
                    ),
                    Err(error) => (
                        WorktreeAuditState::Unknown,
                        None,
                        false,
                        false,
                        false,
                        Some(error.to_string()),
                    ),
                }
            } else {
                match is_clean(path) {
                    Ok(true) => (
                        WorktreeAuditState::RegisteredClean,
                        Some(true),
                        false,
                        false,
                        false,
                        Some("Stop runtime ownership before removing this checkout.".to_string()),
                    ),
                    Ok(false) => (
                        WorktreeAuditState::RegisteredDirty,
                        Some(false),
                        false,
                        false,
                        true,
                        Some("Uncommitted changes require explicit forced cleanup.".to_string()),
                    ),
                    Err(error) => (
                        WorktreeAuditState::RegisteredUnknown,
                        None,
                        false,
                        false,
                        false,
                        Some(format!("Git status could not be read: {error}")),
                    ),
                }
            };

        entries.push(WorktreeAuditEntry {
            path: worktree.path,
            branch: worktree.branch,
            state,
            clean,
            safe_to_remove_without_force,
            safe_to_prune_metadata,
            requires_force,
            note,
        });
    }

    let removable_without_force_count = entries
        .iter()
        .filter(|entry| entry.safe_to_remove_without_force)
        .count();
    let prunable_metadata_count = entries
        .iter()
        .filter(|entry| entry.safe_to_prune_metadata)
        .count();
    let requires_force_count = entries
        .iter()
        .filter(|entry| entry.requires_force)
        .count();

    Ok(WorktreeAudit {
        repository_root: to_display_string(&repo_dir),
        storage_root: to_display_string(&storage_root),
        entries,
        removable_without_force_count,
        prunable_metadata_count,
        requires_force_count,
    })
}

pub fn prune_worktrees(repository_root: &str) -> Result<(), GitError> {
    let repo_dir = canonical_dir(repository_root)?;
    ensure_is_repo(&repo_dir, repository_root)?;
    run_git(&repo_dir, &["worktree", "prune"])?;
    Ok(())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveWorktreeRequest {
    pub repository_root: String,
    pub worktree_path: String,
    /// Must be explicitly set by the caller to remove a worktree that has
    /// uncommitted changes. Never inferred or defaulted to true.
    #[serde(default)]
    pub force: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovedWorktreeResult {
    pub path: String,
    pub forced: bool,
}

pub fn remove_worktree(req: RemoveWorktreeRequest) -> Result<RemovedWorktreeResult, GitError> {
    let repo_dir = canonical_dir(&req.repository_root)?;
    ensure_is_repo(&repo_dir, &req.repository_root)?;
    let (target, target_exists) = resolve_worktree_target(&req.worktree_path)?;

    let mut worktrees =
        parse_worktree_list(&run_git(&repo_dir, &["worktree", "list", "--porcelain"])?.stdout);
    append_orphaned_slots(&repo_dir, &mut worktrees)?;
    let entry = worktrees
        .iter()
        .find(|w| path_key(&w.path) == path_key(&target.to_string_lossy()))
        .ok_or_else(|| GitError::WorktreeNotFound {
            path: req.worktree_path.clone(),
        })?;
    if !target_exists {
        // A registered worktree can disappear outside ZLI, for example when
        // Windows removes a locked folder after the terminal exits. The safe
        // recovery is to prune only the matching stale Git metadata. We do
        // this after matching the path against Git's own worktree list so an
        // arbitrary missing path can never be treated as successfully removed.
        run_git(&repo_dir, &["worktree", "prune", "--expire", "now"])?;
        return Ok(RemovedWorktreeResult {
            path: req.worktree_path,
            forced: req.force,
        });
    }
    if entry.orphaned {
        if !req.force && directory_has_entries(&target)? {
            return Err(GitError::DirtyWorktree {
                path: req.worktree_path.clone(),
                message: "orphaned checkout contains files; pass force=true to discard them"
                    .to_string(),
            });
        }
        retry_worktree_operation(
            || remove_directory(&target, req.force),
            WORKTREE_CLEANUP_RETRY_DELAY,
        )?;
        return Ok(RemovedWorktreeResult {
            path: req.worktree_path,
            forced: req.force,
        });
    }
    if entry.is_main {
        return Err(GitError::InvalidInput {
            message: "refusing to remove the repository's main worktree".to_string(),
        });
    }
    if entry.locked {
        return Err(GitError::WorktreeLocked {
            path: req.worktree_path.clone(),
            message: "Unlock this worktree explicitly before removing it.".to_string(),
        });
    }

    if !req.force && !is_clean(&target)? {
        return Err(GitError::DirtyWorktree {
            path: req.worktree_path.clone(),
            message: "worktree has uncommitted changes; pass force=true to discard them"
                .to_string(),
        });
    }

    let mut args = vec!["worktree", "remove"];
    if req.force {
        args.push("--force");
    }
    let path_str = target.to_string_lossy().into_owned();
    args.push(&path_str);
    if let Err(error) = run_git(&repo_dir, &args) {
        if req.force && is_permission_error(&error) {
            retry_worktree_operation(
                || remove_directory(&target, true),
                WORKTREE_CLEANUP_RETRY_DELAY,
            )?;
            let _ = run_git(&repo_dir, &["worktree", "prune"]);
        } else {
            return Err(error);
        }
    }

    Ok(RemovedWorktreeResult {
        path: req.worktree_path,
        forced: req.force,
    })
}

fn resolve_worktree_target(path: &str) -> Result<(PathBuf, bool), GitError> {
    match canonical_dir(path) {
        Ok(target) => Ok((target, true)),
        Err(error) => {
            if !matches!(&error, GitError::InvalidPath { reason, .. } if reason == "path does not exist") {
                return Err(error);
            }
            let raw = PathBuf::from(path);
            if !raw.is_absolute() {
                return Err(error);
            }
            let Some(parent) = raw.parent() else {
                return Err(error);
            };
            let Some(name) = raw.file_name() else {
                return Err(error);
            };
            let parent = canonical_dir(parent.to_string_lossy().as_ref())?;
            Ok((parent.join(name), false))
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteBranchRequest {
    pub repository_root: String,
    pub branch: String,
    /// Explicit confirmation required, mirrors `RemoveWorktreeRequest::force`.
    #[serde(default)]
    pub force: bool,
}

fn is_managed_branch(branch: &str) -> bool {
    branch.starts_with(ACTIVE_BRANCH_PREFIX) || branch.starts_with(LEGACY_BRANCH_PREFIX)
}

/// Delete a branch this app created for an agent. Accepts current `zli/` and
/// legacy `swarm/` prefixes so cleanup can still reach older worktrees.
pub fn delete_branch(req: DeleteBranchRequest) -> Result<(), GitError> {
    let repo_dir = canonical_dir(&req.repository_root)?;
    ensure_is_repo(&repo_dir, &req.repository_root)?;

    if !is_managed_branch(&req.branch) {
        return Err(GitError::InvalidInput {
            message: format!(
                "refusing to delete '{}': not a ZLI-managed branch (expected '{ACTIVE_BRANCH_PREFIX}' or '{LEGACY_BRANCH_PREFIX}' prefix)",
                req.branch
            ),
        });
    }
    if !run_git_probe(
        &repo_dir,
        &[
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/heads/{}", req.branch),
        ],
    )
    .0
    {
        return Err(GitError::BranchNotFound { branch: req.branch });
    }

    let worktrees =
        parse_worktree_list(&run_git(&repo_dir, &["worktree", "list", "--porcelain"])?.stdout);
    if worktrees
        .iter()
        .any(|w| w.branch.as_deref() == Some(req.branch.as_str()))
    {
        return Err(GitError::InvalidInput {
            message: format!(
                "branch '{}' is still checked out in a worktree; remove that worktree first",
                req.branch
            ),
        });
    }

    let flag = if req.force { "-D" } else { "-d" };
    run_git(&repo_dir, &["branch", flag, &req.branch])?;
    Ok(())
}

fn ensure_is_repo(dir: &Path, original: &str) -> Result<(), GitError> {
    if !run_git_probe(dir, &["rev-parse", "--is-inside-work-tree"]).0 {
        return Err(GitError::NotGitRepository {
            path: original.to_string(),
        });
    }
    Ok(())
}

fn append_orphaned_slots(
    repo_dir: &Path,
    worktrees: &mut Vec<WorktreeInfo>,
) -> Result<(), GitError> {
    let root = sibling_worktrees_dir(repo_dir)?;
    if !root.is_dir() {
        return Ok(());
    }
    let registered: HashSet<String> = worktrees
        .iter()
        .map(|worktree| path_key(&worktree.path))
        .collect();
    for entry in std::fs::read_dir(&root).map_err(|error| GitError::Io {
        message: format!(
            "failed to inspect worktree storage '{}': {error}",
            root.display()
        ),
    })? {
        let entry = entry.map_err(|error| GitError::Io {
            message: format!(
                "failed to inspect worktree storage '{}': {error}",
                root.display()
            ),
        })?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !is_agent_slot_name(name) {
            continue;
        }
        let resolved = canonical_dir(path.to_string_lossy().as_ref())?;
        if registered.contains(&path_key(&resolved.to_string_lossy())) {
            continue;
        }
        worktrees.push(WorktreeInfo {
            path: to_display_string(&resolved),
            branch: None,
            head: String::new(),
            is_main: false,
            locked: false,
            prunable: false,
            orphaned: true,
        });
    }
    Ok(())
}

fn normalize_existing_worktree_paths(worktrees: &mut [WorktreeInfo]) {
    for worktree in worktrees {
        if worktree.orphaned || !Path::new(&worktree.path).exists() {
            continue;
        }
        if let Ok(resolved) = canonical_dir(&worktree.path) {
            worktree.path = to_display_string(&resolved);
        }
    }
}

fn path_key(path: &str) -> String {
    path.replace('\\', "/")
        .trim_end_matches('/')
        .to_ascii_lowercase()
}

fn is_agent_slot_name(name: &str) -> bool {
    let Some((_, suffix)) = name.rsplit_once('-') else {
        return false;
    };
    suffix.len() == 8
        && suffix
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
}

fn directory_has_entries(path: &Path) -> Result<bool, GitError> {
    let mut entries = std::fs::read_dir(path).map_err(|error| GitError::Io {
        message: format!(
            "failed to inspect worktree directory '{}': {error}",
            path.display()
        ),
    })?;
    Ok(entries
        .next()
        .transpose()
        .map_err(|error| GitError::Io {
            message: format!(
                "failed to inspect worktree directory '{}': {error}",
                path.display()
            ),
        })?
        .is_some())
}

fn remove_directory(path: &Path, force: bool) -> Result<(), GitError> {
    let map_remove_error = |error: std::io::Error| -> GitError {
        let detail = error.to_string();
        if is_share_violation_message(&detail) {
            GitError::FileLocked {
                path: path.display().to_string(),
                message: format!(
                    "{detail}; close programs using this folder and retry"
                ),
            }
        } else {
            GitError::Io {
                message: format!(
                    "failed to delete worktree directory '{}': {detail}; close programs using this folder and retry",
                    path.display()
                ),
            }
        }
    };
    if force {
        clear_readonly(path)?;
        std::fs::remove_dir_all(path).map_err(map_remove_error)
    } else {
        std::fs::remove_dir(path).map_err(map_remove_error)
    }
}

fn is_share_violation_message(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    message.contains("being used by another process")
        || message.contains("os error 32")
        || message.contains("(os error 32)")
}

fn is_permission_error(error: &GitError) -> bool {
    match error {
        GitError::FileLocked { .. } => true,
        GitError::GitCommandFailed { message, .. } | GitError::Io { message } => {
            let message = message.to_ascii_lowercase();
            message.contains("permission denied")
                || message.contains("access is denied")
                || is_share_violation_message(&message)
        }
        _ => false,
    }
}

fn retry_worktree_operation<T, F>(mut operation: F, delay: Duration) -> Result<T, GitError>
where
    F: FnMut() -> Result<T, GitError>,
{
    let mut last_error = None;
    for attempt in 0..=MAX_WORKTREE_CLEANUP_RETRIES {
        match operation() {
            Ok(result) => return Ok(result),
            Err(error) if is_permission_error(&error) && attempt < MAX_WORKTREE_CLEANUP_RETRIES => {
                last_error = Some(error);
                if !delay.is_zero() {
                    std::thread::sleep(delay);
                }
            }
            Err(error) => return Err(error),
        }
    }
    Err(last_error.expect("cleanup retry loop must retain its last error"))
}

#[cfg(windows)]
fn clear_readonly(path: &Path) -> Result<(), GitError> {
    let metadata = std::fs::metadata(path).map_err(|error| GitError::Io {
        message: format!(
            "failed to inspect worktree directory '{}': {error}",
            path.display()
        ),
    })?;
    let mut permissions = metadata.permissions();
    permissions.set_readonly(false);
    std::fs::set_permissions(path, permissions).map_err(|error| GitError::Io {
        message: format!(
            "failed to clear read-only state from '{}': {error}",
            path.display()
        ),
    })?;
    if metadata.is_dir() {
        for entry in std::fs::read_dir(path).map_err(|error| GitError::Io {
            message: format!(
                "failed to inspect worktree directory '{}': {error}",
                path.display()
            ),
        })? {
            clear_readonly(
                &entry
                    .map_err(|error| GitError::Io {
                        message: format!(
                            "failed to inspect worktree directory '{}': {error}",
                            path.display()
                        ),
                    })?
                    .path(),
            )?;
        }
    }
    Ok(())
}

#[cfg(not(windows))]
fn clear_readonly(_path: &Path) -> Result<(), GitError> {
    Ok(())
}

fn sibling_worktrees_dir(repo_dir: &Path) -> Result<PathBuf, GitError> {
    let parent = repo_dir.parent().ok_or_else(|| GitError::InvalidPath {
        path: to_display_string(repo_dir),
        reason: "repository has no parent directory to store worktrees next to".to_string(),
    })?;
    let repo_name = repo_dir
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "repo".to_string());
    Ok(parent.join(format!("{repo_name}.worktrees")))
}

fn allocate_unique_slot(
    repo_dir: &Path,
    worktrees_root: &Path,
    provider_slug: &str,
) -> Result<(String, PathBuf), GitError> {
    let mut last_path_collision: Option<PathBuf> = None;
    for _ in 0..10 {
        let short_id = random_short_id();
        let branch = format!("{ACTIVE_BRANCH_PREFIX}{provider_slug}-{short_id}");
        let path = worktrees_root.join(format!("{provider_slug}-{short_id}"));

        let branch_taken = run_git_probe(
            repo_dir,
            &[
                "show-ref",
                "--verify",
                "--quiet",
                &format!("refs/heads/{branch}"),
            ],
        )
        .0;
        if path.exists() {
            last_path_collision = Some(path);
            continue;
        }
        if branch_taken {
            continue;
        }
        return Ok((branch, path));
    }
    if let Some(path) = last_path_collision {
        return Err(GitError::WorktreeExists {
            path: to_display_string(&path),
        });
    }
    Err(GitError::BranchExists {
        branch: format!("{ACTIVE_BRANCH_PREFIX}{provider_slug}-*"),
    })
}

fn random_short_id() -> String {
    const CHARS: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let mut rng = rand::thread_rng();
    (0..8)
        .map(|_| CHARS[rng.gen_range(0..CHARS.len())] as char)
        .collect()
}

fn slugify(input: &str) -> String {
    let cleaned: String = input
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let collapsed: Vec<&str> = cleaned.split('-').filter(|s| !s.is_empty()).collect();
    let slug = collapsed.join("-");
    if slug.is_empty() {
        "agent".to_string()
    } else {
        slug
    }
}

/// `git worktree list --porcelain` emits one blank-line-separated block per
/// worktree, always starting with a `worktree <path>` line; the very first
/// block in the output is always the repository's main worktree.
fn parse_worktree_list(porcelain: &str) -> Vec<WorktreeInfo> {
    let mut result = Vec::new();
    let mut path: Option<String> = None;
    let mut head = String::new();
    let mut branch: Option<String> = None;
    let mut locked = false;
    let mut prunable = false;

    for line in porcelain.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            if let Some(prev_path) = path.take() {
                result.push(WorktreeInfo {
                    path: prev_path,
                    branch: branch.take(),
                    head: std::mem::take(&mut head),
                    is_main: result.is_empty(),
                    locked,
                    prunable,
                    orphaned: false,
                });
                locked = false;
                prunable = false;
            }
            path = Some(p.to_string());
        } else if let Some(h) = line.strip_prefix("HEAD ") {
            head = h.to_string();
        } else if let Some(b) = line.strip_prefix("branch ") {
            branch = b
                .strip_prefix("refs/heads/")
                .map(|s| s.to_string())
                .or_else(|| Some(b.to_string()));
        } else if line.starts_with("locked") {
            locked = true;
        } else if line.starts_with("prunable") {
            prunable = true;
        } else if line == "detached" {
            branch = None;
        }
    }
    if let Some(p) = path.take() {
        result.push(WorktreeInfo {
            path: p,
            branch: branch.take(),
            head,
            is_main: result.is_empty(),
            locked,
            prunable,
            orphaned: false,
        });
    }

    result
}

#[cfg(test)]
mod tests {
    use super::{
        is_permission_error, is_share_violation_message, retry_worktree_operation, GitError,
    };
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    #[test]
    fn retries_permission_failures_before_returning_success() {
        let attempts = AtomicUsize::new(0);
        let result = retry_worktree_operation(
            || {
                let attempt = attempts.fetch_add(1, Ordering::SeqCst);
                if attempt < 2 {
                    Err(GitError::Io {
                        message: "permission denied".into(),
                    })
                } else {
                    Ok("removed")
                }
            },
            Duration::ZERO,
        )
        .expect("a released file handle should eventually be removable");

        assert_eq!(result, "removed");
        assert_eq!(attempts.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn share_violation_messages_count_as_permission_errors() {
        assert!(is_share_violation_message(
            "The process cannot access the file because it is being used by another process. (os error 32)"
        ));
        assert!(is_permission_error(&GitError::Io {
            message: "failed: being used by another process".into(),
        }));
        assert!(is_permission_error(&GitError::FileLocked {
            path: "C:/tmp/wt".into(),
            message: "os error 32".into(),
        }));
    }
}
