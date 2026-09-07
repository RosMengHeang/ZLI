//! Safe merge of an agent's branch back into the repository's base branch.
//!
//! Guardrails: the destination worktree must already be clean before we
//! touch it, we only ever run a plain (non-force) `checkout` and `merge`,
//! and on conflict we leave the mid-merge state exactly as Git left it for
//! the human/agent to resolve or abort — never `reset --hard`, force
//! checkout, force push, or silent file overwrites.

use super::error::GitError;
use super::paths::canonical_dir;
use super::process::{run_git, run_git_probe};
use super::repo::{current_branch, determine_base_branch, is_clean};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeRequest {
    /// The main worktree (repository root) the merge is applied in.
    pub repository_root: String,
    pub source_branch: String,
    /// Defaults to the repository's detected base branch when omitted.
    pub target_branch: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "outcome", rename_all = "camelCase")]
pub enum MergeOutcome {
    // NB: the enum-level `rename_all` above only renames the `outcome` tag
    // value itself ("Success" -> "success"); it does NOT cascade into a
    // struct variant's own fields, so each variant repeats it or the JSON
    // sent to the frontend comes out snake_case.
    #[serde(rename_all = "camelCase")]
    Success {
        commit_hash: String,
        target_branch: String,
        source_branch: String,
        fast_forward: bool,
    },
    #[serde(rename_all = "camelCase")]
    Conflict {
        target_branch: String,
        source_branch: String,
        conflicted_files: Vec<String>,
    },
}

pub fn merge_branch(req: MergeRequest) -> Result<MergeOutcome, GitError> {
    let dir = canonical_dir(&req.repository_root)?;
    if !run_git_probe(&dir, &["rev-parse", "--is-inside-work-tree"]).0 {
        return Err(GitError::NotGitRepository {
            path: req.repository_root.clone(),
        });
    }

    let target_branch = match req.target_branch {
        Some(b) if !b.trim().is_empty() => b,
        _ => {
            let (current, _) = current_branch(&dir);
            determine_base_branch(&dir, current.as_deref()).ok_or_else(|| {
                GitError::InvalidInput {
                    message: "could not determine a target/base branch; specify one explicitly"
                        .to_string(),
                }
            })?
        }
    };

    if target_branch == req.source_branch {
        return Err(GitError::InvalidInput {
            message: "source and target branch are the same".to_string(),
        });
    }
    require_branch_exists(&dir, &target_branch)?;
    require_branch_exists(&dir, &req.source_branch)?;

    // Dangerous condition: destination worktree must be clean before we
    // touch it at all — we never overwrite uncommitted work to make a merge
    // proceed.
    if !is_clean(&dir)? {
        return Err(GitError::DirtyWorktree {
            path: req.repository_root.clone(),
            message: "repository root has uncommitted changes; commit, stash, or discard them before merging"
                .to_string(),
        });
    }

    let (on_target, _) = current_branch(&dir);
    if on_target.as_deref() != Some(target_branch.as_str()) {
        // Safe because the worktree is verified clean above: a plain
        // checkout cannot lose work here, Git refuses if it would.
        run_git(&dir, &["checkout", &target_branch])?;
    }

    let merge_message = format!(
        "Merge branch '{}' into {}",
        req.source_branch, target_branch
    );
    let merge_result = run_git(
        &dir,
        &["merge", "--no-ff", "-m", &merge_message, &req.source_branch],
    );

    match merge_result {
        Ok(out) => {
            let hash = run_git(&dir, &["rev-parse", "HEAD"])?
                .stdout_trimmed()
                .to_string();
            let fast_forward = out.stdout.contains("Fast-forward");
            Ok(MergeOutcome::Success {
                commit_hash: hash,
                target_branch,
                source_branch: req.source_branch,
                fast_forward,
            })
        }
        Err(err) => {
            let conflicted = conflicted_files(&dir);
            if !conflicted.is_empty() {
                // Deliberately left mid-merge (MERGE_HEAD present) so the
                // caller can resolve manually, or call `abort_merge`.
                Ok(MergeOutcome::Conflict {
                    target_branch,
                    source_branch: req.source_branch,
                    conflicted_files: conflicted,
                })
            } else {
                // Non-conflict failure (e.g. merge refused for another
                // reason). Nothing is rolled back here — surface the error
                // rather than guessing at recovery.
                Err(err)
            }
        }
    }
}

/// Explicitly abort an in-progress conflicted merge, restoring the target
/// branch to its pre-merge state. Only ever called on the caller's direct
/// request — never automatically.
pub fn abort_merge(repository_root: &str) -> Result<(), GitError> {
    let dir = canonical_dir(repository_root)?;
    if !run_git_probe(&dir, &["rev-parse", "--is-inside-work-tree"]).0 {
        return Err(GitError::NotGitRepository {
            path: repository_root.to_string(),
        });
    }
    if !Path::new(&dir).join(".git").join("MERGE_HEAD").exists()
        && !run_git_probe(&dir, &["rev-parse", "-q", "--verify", "MERGE_HEAD"]).0
    {
        return Err(GitError::InvalidInput {
            message: "no merge is currently in progress".to_string(),
        });
    }
    run_git(&dir, &["merge", "--abort"])?;
    Ok(())
}

fn require_branch_exists(dir: &Path, branch: &str) -> Result<(), GitError> {
    let local = run_git_probe(
        dir,
        &[
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ],
    )
    .0;
    let remote = run_git_probe(
        dir,
        &[
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/remotes/origin/{branch}"),
        ],
    )
    .0;
    if local || remote {
        Ok(())
    } else {
        Err(GitError::BranchNotFound {
            branch: branch.to_string(),
        })
    }
}

fn conflicted_files(dir: &Path) -> Vec<String> {
    run_git_probe(dir, &["diff", "--name-only", "--diff-filter=U"])
        .1
        .stdout
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| l.to_string())
        .collect()
}
