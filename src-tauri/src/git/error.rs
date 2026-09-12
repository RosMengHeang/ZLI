//! Structured, frontend-safe errors for the git subsystem.
//!
//! Every variant is serializable so it can cross the Tauri IPC boundary as
//! JSON. Raw git/OS output is never forwarded verbatim to the UI: it is
//! summarized and truncated by [`sanitize_output`] before being attached to
//! [`GitError::CommandFailed`].

use serde::Serialize;
use std::fmt;

/// Maximum number of characters of git/OS output surfaced to the frontend.
const MAX_ERROR_MESSAGE_CHARS: usize = 800;
/// Maximum number of lines of git/OS output surfaced to the frontend.
const MAX_ERROR_MESSAGE_LINES: usize = 8;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", content = "details", rename_all = "camelCase")]
pub enum GitError {
    /// The given path is not inside a Git repository.
    NotGitRepository { path: String },
    /// The operation requires a clean worktree but uncommitted changes exist.
    DirtyWorktree { path: String, message: String },
    /// A branch with this name already exists.
    BranchExists { branch: String },
    /// A worktree already exists at this path.
    WorktreeExists { path: String },
    /// No worktree could be found at the given path.
    WorktreeNotFound { path: String },
    /// A ZLI-owned terminal is still running from this worktree.
    WorktreeInUse { path: String, terminal_id: String },
    /// Git reports the worktree as locked; unlock explicitly before remove.
    WorktreeLocked { path: String, message: String },
    /// The filesystem path is locked by another process (Windows share violation).
    FileLocked { path: String, message: String },
    /// No branch with this name could be found.
    BranchNotFound { branch: String },
    /// A path failed validation (missing, not a directory, escapes allowed roots, etc).
    InvalidPath { path: String, reason: String },
    /// A request field failed validation (empty message, mismatched ids, etc).
    InvalidInput { message: String },
    /// There is nothing staged/changed to commit.
    NothingToCommit { path: String },
    /// The underlying `git` process could not be spawned or exited non-zero.
    GitCommandFailed { command: String, message: String },
    /// A filesystem operation failed (create dir, canonicalize, etc).
    Io { message: String },
}

impl fmt::Display for GitError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            GitError::NotGitRepository { path } => {
                write!(f, "'{path}' is not a Git repository")
            }
            GitError::DirtyWorktree { path, message } => {
                write!(f, "worktree at '{path}' has uncommitted changes: {message}")
            }
            GitError::BranchExists { branch } => write!(f, "branch '{branch}' already exists"),
            GitError::WorktreeExists { path } => {
                write!(f, "a worktree already exists at '{path}'")
            }
            GitError::WorktreeNotFound { path } => {
                write!(f, "no worktree found at '{path}'")
            }
            GitError::WorktreeInUse { path, terminal_id } => write!(
                f,
                "worktree at '{path}' is still in use by terminal '{terminal_id}'; stop it before removing the worktree"
            ),
            GitError::WorktreeLocked { path, message } => {
                write!(f, "worktree at '{path}' is locked: {message}")
            }
            GitError::FileLocked { path, message } => {
                write!(f, "path '{path}' is locked by another process: {message}")
            }
            GitError::BranchNotFound { branch } => write!(f, "branch '{branch}' was not found"),
            GitError::InvalidPath { path, reason } => {
                write!(f, "invalid path '{path}': {reason}")
            }
            GitError::InvalidInput { message } => write!(f, "invalid input: {message}"),
            GitError::NothingToCommit { path } => {
                write!(f, "nothing to commit at '{path}'")
            }
            GitError::GitCommandFailed { command, message } => {
                write!(f, "'{command}' failed: {message}")
            }
            GitError::Io { message } => write!(f, "filesystem error: {message}"),
        }
    }
}

impl std::error::Error for GitError {}

/// Truncate raw process output before it is allowed into a user-facing error.
pub fn sanitize_output(raw: &str) -> String {
    let collapsed: String = raw
        .lines()
        .filter(|l| !l.trim().is_empty())
        .take(MAX_ERROR_MESSAGE_LINES)
        .collect::<Vec<_>>()
        .join(" | ");
    if collapsed.chars().count() > MAX_ERROR_MESSAGE_CHARS {
        let truncated: String = collapsed.chars().take(MAX_ERROR_MESSAGE_CHARS).collect();
        format!("{truncated}…")
    } else if collapsed.is_empty() {
        "git exited with a non-zero status and produced no output".to_string()
    } else {
        collapsed
    }
}
