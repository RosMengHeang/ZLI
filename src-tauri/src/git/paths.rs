//! Path validation/canonicalization shared by the git subsystem.
//!
//! Windows paths containing spaces work fine here because we never build a
//! shell string — [`crate::git::process::run_git`] passes arguments as an
//! array straight to `CreateProcess`.

use super::error::GitError;
use std::path::PathBuf;

/// Resolve `path` to an absolute, existing directory without the `\\?\`
/// UNC-extended prefix that `Path::canonicalize` adds on Windows (which
/// trips up plenty of external tools that later receive this path, e.g. the
/// coding agent processes Codex's launcher spawns).
pub fn canonical_dir(path: &str) -> Result<PathBuf, GitError> {
    if path.trim().is_empty() {
        return Err(GitError::InvalidPath {
            path: path.to_string(),
            reason: "path is empty".to_string(),
        });
    }
    let raw = PathBuf::from(path);
    if !raw.exists() {
        return Err(GitError::InvalidPath {
            path: path.to_string(),
            reason: "path does not exist".to_string(),
        });
    }
    if !raw.is_dir() {
        return Err(GitError::InvalidPath {
            path: path.to_string(),
            reason: "path is not a directory".to_string(),
        });
    }
    dunce::canonicalize(&raw).map_err(|e| GitError::InvalidPath {
        path: path.to_string(),
        reason: format!("failed to resolve path: {e}"),
    })
}

pub fn to_display_string(path: &std::path::Path) -> String {
    path.to_string_lossy().into_owned()
}
