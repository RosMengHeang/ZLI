//! Explicit, non-silent commit workflow. This module never runs unless the
//! frontend calls it with a message the user (or agent, on the user's
//! behalf) explicitly provided — there is no autosave/auto-commit path.

use super::error::GitError;
use super::paths::canonical_dir;
use super::process::{run_git, run_git_probe};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitRequest {
    pub worktree_path: String,
    pub message: String,
    /// Stage all working-tree changes (`git add -A`) before committing.
    /// When false, only what is already staged is committed.
    #[serde(default)]
    pub stage_all: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitResult {
    pub hash: String,
    pub short_hash: String,
    pub message: String,
    pub author: String,
    pub files_changed: u32,
    pub additions: u32,
    pub deletions: u32,
}

pub fn commit(req: CommitRequest) -> Result<CommitResult, GitError> {
    let message = req.message.trim();
    if message.is_empty() {
        return Err(GitError::InvalidInput {
            message: "commit message must not be empty".to_string(),
        });
    }

    let dir = canonical_dir(&req.worktree_path)?;
    if !run_git_probe(&dir, &["rev-parse", "--is-inside-work-tree"]).0 {
        return Err(GitError::NotGitRepository {
            path: req.worktree_path.clone(),
        });
    }

    if req.stage_all {
        run_git(&dir, &["add", "-A"])?;
    }

    let has_staged_changes = !run_git_probe(&dir, &["diff", "--cached", "--quiet"]).0;
    if !has_staged_changes {
        return Err(GitError::NothingToCommit {
            path: req.worktree_path.clone(),
        });
    }

    run_git(&dir, &["commit", "-m", message])?;

    let hash = run_git(&dir, &["rev-parse", "HEAD"])?
        .stdout_trimmed()
        .to_string();
    let short_hash = run_git(&dir, &["rev-parse", "--short", "HEAD"])?
        .stdout_trimmed()
        .to_string();
    let author = run_git(&dir, &["show", "-s", "--format=%an <%ae>", "HEAD"])?
        .stdout_trimmed()
        .to_string();
    let (files_changed, additions, deletions) = shortstat(&dir);

    Ok(CommitResult {
        hash,
        short_hash,
        message: message.to_string(),
        author,
        files_changed,
        additions,
        deletions,
    })
}

fn shortstat(dir: &Path) -> (u32, u32, u32) {
    let raw = run_git(dir, &["show", "--shortstat", "--format=", "HEAD"])
        .map(|o| o.stdout)
        .unwrap_or_default();
    parse_shortstat(&raw)
}

/// Parse a line like " 3 files changed, 10 insertions(+), 2 deletions(-)".
fn parse_shortstat(raw: &str) -> (u32, u32, u32) {
    let mut files = 0u32;
    let mut additions = 0u32;
    let mut deletions = 0u32;
    for part in raw.split(',') {
        let part = part.trim();
        let Some((num_str, _)) = part.split_once(' ') else {
            continue;
        };
        let Ok(num) = num_str.parse::<u32>() else {
            continue;
        };
        if part.contains("file") {
            files = num;
        } else if part.contains("insertion") {
            additions = num;
        } else if part.contains("deletion") {
            deletions = num;
        }
    }
    (files, additions, deletions)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_full_shortstat() {
        let (f, a, d) = parse_shortstat(" 3 files changed, 10 insertions(+), 2 deletions(-)");
        assert_eq!((f, a, d), (3, 10, 2));
    }

    #[test]
    fn parses_insertions_only() {
        let (f, a, d) = parse_shortstat(" 1 file changed, 5 insertions(+)");
        assert_eq!((f, a, d), (1, 5, 0));
    }
}
