//! Tauri command wrappers. Thin by design: validate nothing here that the
//! inner modules already validate, just adapt `Result<T, GitError>` to the
//! IPC boundary. Register all of these in `lib.rs`'s `invoke_handler!`.
//!
//! Commands are `async` so they never run on the UI thread. Blocking git
//! process work is offloaded with `spawn_blocking`.

use super::commit::{self, CommitRequest, CommitResult};
use super::diff::{self, FileDiff};
use super::error::GitError;
use super::merge::{self, MergeOutcome, MergeRequest};
use super::repo::{self, RepositoryInfo};
use super::status::{self, GitStatus};
use super::worktree::{
    self, CreateWorktreeRequest, CreateWorktreeResult, DeleteBranchRequest, RemoveWorktreeRequest,
    RemovedWorktreeResult, WorktreeAudit, WorktreeInfo,
};

async fn run_blocking<T, F>(label: &'static str, work: F) -> Result<T, GitError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, GitError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|err| GitError::Io {
            message: format!("{label} task failed: {err}"),
        })?
}

#[tauri::command]
pub async fn git_validate_repository(path: String) -> Result<RepositoryInfo, GitError> {
    run_blocking("git_validate_repository", move || repo::validate_repository(&path)).await
}

#[tauri::command]
pub async fn git_create_worktree(
    request: CreateWorktreeRequest,
) -> Result<CreateWorktreeResult, GitError> {
    run_blocking("git_create_worktree", move || worktree::create_worktree(request)).await
}

#[tauri::command]
pub async fn git_list_worktrees(repository_root: String) -> Result<Vec<WorktreeInfo>, GitError> {
    run_blocking("git_list_worktrees", move || {
        worktree::list_worktrees(&repository_root)
    })
    .await
}

#[tauri::command]
pub async fn git_audit_worktrees(repository_root: String) -> Result<WorktreeAudit, GitError> {
    run_blocking("git_audit_worktrees", move || {
        worktree::audit_worktrees(&repository_root)
    })
    .await
}

#[tauri::command]
pub async fn git_prune_worktrees(repository_root: String) -> Result<(), GitError> {
    run_blocking("git_prune_worktrees", move || worktree::prune_worktrees(&repository_root)).await
}

#[tauri::command]
pub async fn git_remove_worktree(
    manager: tauri::State<'_, crate::pty::PtyManager>,
    request: RemoveWorktreeRequest,
) -> Result<RemovedWorktreeResult, GitError> {
    let manager = manager.inner().clone();
    run_blocking("git_remove_worktree", move || {
        let target = match super::paths::canonical_dir(&request.worktree_path) {
            Ok(target) => Some(target),
            Err(error) => {
                if !matches!(&error, GitError::InvalidPath { reason, .. } if reason == "path does not exist") {
                    return Err(error);
                }
                None
            }
        };
        if let Some(target) = target {
            let running_terminal = manager
                .running_session_at(&target)
                .map_err(|error| GitError::Io {
                    message: format!("failed to inspect runtime ownership: {error}"),
                })?;
            if let Some(terminal_id) = running_terminal {
                return Err(GitError::WorktreeInUse {
                    path: request.worktree_path.clone(),
                    terminal_id,
                });
            }
        }
        worktree::remove_worktree(request)
    })
    .await
}

#[tauri::command]
pub async fn git_delete_branch(request: DeleteBranchRequest) -> Result<(), GitError> {
    run_blocking("git_delete_branch", move || worktree::delete_branch(request)).await
}

#[tauri::command]
pub async fn git_status(worktree_path: String) -> Result<GitStatus, GitError> {
    run_blocking("git_status", move || status::get_status(&worktree_path)).await
}

#[tauri::command]
pub async fn git_diff(
    worktree_path: String,
    file_path: Option<String>,
) -> Result<Vec<FileDiff>, GitError> {
    run_blocking("git_diff", move || {
        diff::get_diff(&worktree_path, file_path.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn git_commit(request: CommitRequest) -> Result<CommitResult, GitError> {
    run_blocking("git_commit", move || commit::commit(request)).await
}

#[tauri::command]
pub async fn git_merge(request: MergeRequest) -> Result<MergeOutcome, GitError> {
    run_blocking("git_merge", move || merge::merge_branch(request)).await
}

#[tauri::command]
pub async fn git_abort_merge(repository_root: String) -> Result<(), GitError> {
    run_blocking("git_abort_merge", move || merge::abort_merge(&repository_root)).await
}
