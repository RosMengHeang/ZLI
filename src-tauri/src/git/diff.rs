//! Unified diffs for the frontend diff viewer, per-file or repo-wide.

use super::error::GitError;
use super::paths::canonical_dir;
use super::process::{run_git, run_git_probe};
use super::status::{get_status, ChangedFile, FileStatus};
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub original_path: Option<String>,
    pub status: FileStatus,
    /// Unified diff text (`git diff` format), ready for a diff viewer.
    pub diff: String,
    pub binary: bool,
}

/// `file_path` selects a single file (relative to the worktree root);
/// `None` returns a diff entry per changed file.
pub fn get_diff(worktree_path: &str, file_path: Option<&str>) -> Result<Vec<FileDiff>, GitError> {
    let dir = canonical_dir(worktree_path)?;
    let status = get_status(worktree_path)?;
    let has_head = run_git_probe(&dir, &["rev-parse", "--verify", "-q", "HEAD"]).0;

    let files: Vec<&ChangedFile> = status
        .changed_files
        .iter()
        .filter(|f| match file_path {
            Some(target) => f.path == target || f.original_path.as_deref() == Some(target),
            None => true,
        })
        .collect();

    if let Some(target) = file_path {
        if files.is_empty() {
            return Err(GitError::InvalidPath {
                path: target.to_string(),
                reason: "not a changed file in this worktree".to_string(),
            });
        }
    }

    let mut result = Vec::with_capacity(files.len());
    for file in files {
        let diff_text = match file.status {
            FileStatus::Untracked => untracked_diff(&dir, &file.path),
            _ => tracked_diff(&dir, file, has_head),
        };
        let binary = diff_text.contains("Binary files") || diff_text.contains("GIT binary patch");
        result.push(FileDiff {
            path: file.path.clone(),
            original_path: file.original_path.clone(),
            status: file.status,
            diff: diff_text,
            binary,
        });
    }

    Ok(result)
}

fn tracked_diff(dir: &Path, file: &ChangedFile, has_head: bool) -> String {
    let path = file.path.as_str();
    let args: Vec<&str> = if has_head {
        vec!["diff", "HEAD", "-M", "--", path]
    } else {
        vec!["diff", "--cached", "-M", "--", path]
    };
    run_git(dir, &args).map(|o| o.stdout).unwrap_or_default()
}

fn untracked_diff(dir: &Path, rel_path: &str) -> String {
    let null_device = if cfg!(windows) { "NUL" } else { "/dev/null" };
    // --no-index exits 1 when there's a diff (the expected case here), so use
    // the non-erroring probe helper rather than run_git.
    let (_, out) = run_git_probe(dir, &["diff", "--no-index", "--", null_device, rel_path]);
    out.stdout
}
