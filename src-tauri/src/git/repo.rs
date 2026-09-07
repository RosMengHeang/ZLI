//! Repository validation and base-branch detection.

use super::error::GitError;
use super::paths::{canonical_dir, to_display_string};
use super::process::{run_git, run_git_probe};
use serde::Serialize;
use std::path::Path;

/// Structured repository info returned to the frontend. Corresponds to the
/// shared `ProjectInfo` concept (path/name/repositoryRoot/currentBranch/
/// baseBranch), plus a `clean` flag other subsystems can use without a
/// second round trip.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryInfo {
    pub path: String,
    pub repository_root: String,
    /// `None` when HEAD is detached.
    pub current_branch: Option<String>,
    pub detached_head: bool,
    /// Best-effort default/base branch (`origin/HEAD`, then `main`/`master`/
    /// `develop`, then the current branch itself). `None` only for a brand
    /// new repo with zero commits and no candidate refs.
    pub base_branch: Option<String>,
    pub clean: bool,
}

pub fn validate_repository(path: &str) -> Result<RepositoryInfo, GitError> {
    let dir = canonical_dir(path)?;

    let (ok, probe) = run_git_probe(&dir, &["rev-parse", "--is-inside-work-tree"]);
    if !ok || probe.stdout.trim() != "true" {
        return Err(GitError::NotGitRepository {
            path: path.to_string(),
        });
    }

    let root = run_git(&dir, &["rev-parse", "--show-toplevel"])?
        .stdout_trimmed()
        .to_string();
    // `rev-parse --show-toplevel` always returns forward slashes; normalize
    // through canonical_dir so downstream consumers get native separators.
    let root_display = canonical_dir(&root)
        .map(|p| to_display_string(&p))
        .unwrap_or(root);

    let (current_branch, detached_head) = current_branch(&dir);
    let base_branch = determine_base_branch(&dir, current_branch.as_deref());
    let clean = is_clean(&dir)?;

    Ok(RepositoryInfo {
        path: path.to_string(),
        repository_root: root_display,
        current_branch,
        detached_head,
        base_branch,
        clean,
    })
}

/// Returns `(branch_name, is_detached)`.
pub fn current_branch(dir: &Path) -> (Option<String>, bool) {
    let (ok, out) = run_git_probe(dir, &["symbolic-ref", "--short", "-q", "HEAD"]);
    if ok {
        let name = out.stdout.trim();
        if !name.is_empty() {
            return (Some(name.to_string()), false);
        }
    }
    (None, true)
}

/// Best-effort base branch detection: prefer the remote's advertised default
/// branch, then common convention names, then fall back to whatever is
/// currently checked out.
pub fn determine_base_branch(dir: &Path, current: Option<&str>) -> Option<String> {
    if let (true, out) = run_git_probe(dir, &["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]) {
        if let Some(name) = out.stdout.trim().strip_prefix("refs/remotes/origin/") {
            if !name.is_empty() {
                return Some(name.to_string());
            }
        }
    }

    for candidate in ["main", "master", "develop"] {
        let local = format!("refs/heads/{candidate}");
        if run_git_probe(dir, &["show-ref", "--verify", "--quiet", &local]).0 {
            return Some(candidate.to_string());
        }
        let remote = format!("refs/remotes/origin/{candidate}");
        if run_git_probe(dir, &["show-ref", "--verify", "--quiet", &remote]).0 {
            return Some(candidate.to_string());
        }
    }

    current.map(|s| s.to_string())
}

pub fn is_clean(dir: &Path) -> Result<bool, GitError> {
    let out = run_git(dir, &["status", "--porcelain"])?;
    Ok(out.stdout.trim().is_empty())
}
