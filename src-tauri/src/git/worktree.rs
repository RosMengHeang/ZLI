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

const BRANCH_PREFIX: &str = "swarm/";

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
    let target = canonical_dir(&req.worktree_path)?;

    let mut worktrees =
        parse_worktree_list(&run_git(&repo_dir, &["worktree", "list", "--porcelain"])?.stdout);
    append_orphaned_slots(&repo_dir, &mut worktrees)?;
    let entry = worktrees
        .iter()
        .find(|w| Path::new(&w.path) == target)
        .ok_or_else(|| GitError::WorktreeNotFound {
            path: req.worktree_path.clone(),
        })?;
    if entry.orphaned {
        if !req.force && directory_has_entries(&target)? {
            return Err(GitError::DirtyWorktree {
                path: req.worktree_path.clone(),
                message: "orphaned checkout contains files; pass force=true to discard them"
                    .to_string(),
            });
        }
        remove_directory(&target, req.force)?;
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
            remove_directory(&target, true)?;
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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteBranchRequest {
    pub repository_root: String,
    pub branch: String,
    /// Explicit confirmation required, mirrors `RemoveWorktreeRequest::force`.
    #[serde(default)]
    pub force: bool,
}

/// Delete a branch this app created for an agent. Refuses anything outside
/// the `swarm/` namespace so we never touch a human's own branch.
pub fn delete_branch(req: DeleteBranchRequest) -> Result<(), GitError> {
    let repo_dir = canonical_dir(&req.repository_root)?;
    ensure_is_repo(&repo_dir, &req.repository_root)?;

    if !req.branch.starts_with(BRANCH_PREFIX) {
        return Err(GitError::InvalidInput {
            message: format!(
                "refusing to delete '{}': not a Swarmterm-managed branch (expected '{BRANCH_PREFIX}' prefix)",
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
    if force {
        clear_readonly(path)?;
        std::fs::remove_dir_all(path).map_err(|error| GitError::Io {
            message: format!("failed to delete worktree directory '{}': {error}; close programs using this folder and retry", path.display()),
        })
    } else {
        std::fs::remove_dir(path).map_err(|error| GitError::Io {
            message: format!("failed to delete empty worktree directory '{}': {error}; close programs using this folder and retry", path.display()),
        })
    }
}

fn is_permission_error(error: &GitError) -> bool {
    matches!(error, GitError::GitCommandFailed { message, .. } if {
        let message = message.to_ascii_lowercase();
        message.contains("permission denied") || message.contains("access is denied")
    })
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
        let branch = format!("{BRANCH_PREFIX}{provider_slug}-{short_id}");
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
        branch: format!("{BRANCH_PREFIX}{provider_slug}-*"),
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
