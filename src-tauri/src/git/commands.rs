//! Tauri command wrappers. Thin by design: validate nothing here that the
//! inner modules already validate, just adapt `Result<T, GitError>` to the
//! IPC boundary. Register all of these in `lib.rs`'s `invoke_handler!`.

use super::commit::{self, CommitRequest, CommitResult};
use super::diff::{self, FileDiff};
use super::error::GitError;
use super::merge::{self, MergeOutcome, MergeRequest};
use super::repo::{self, RepositoryInfo};
use super::status::{self, GitStatus};
use super::worktree::{
    self, CreateWorktreeRequest, CreateWorktreeResult, DeleteBranchRequest, RemoveWorktreeRequest,
    RemovedWorktreeResult, WorktreeInfo,
};

#[tauri::command]
pub fn git_validate_repository(path: String) -> Result<RepositoryInfo, GitError> {
    repo::validate_repository(&path)
}

#[tauri::command]
pub fn git_create_worktree(
    request: CreateWorktreeRequest,
) -> Result<CreateWorktreeResult, GitError> {
    worktree::create_worktree(request)
}

#[tauri::command]
pub fn git_list_worktrees(repository_root: String) -> Result<Vec<WorktreeInfo>, GitError> {
    worktree::list_worktrees(&repository_root)
}

#[tauri::command]
pub fn git_remove_worktree(
    request: RemoveWorktreeRequest,
) -> Result<RemovedWorktreeResult, GitError> {
    worktree::remove_worktree(request)
}

#[tauri::command]
pub fn git_delete_branch(request: DeleteBranchRequest) -> Result<(), GitError> {
    worktree::delete_branch(request)
}

#[tauri::command]
pub fn git_status(worktree_path: String) -> Result<GitStatus, GitError> {
    status::get_status(&worktree_path)
}

#[tauri::command]
pub fn git_diff(
    worktree_path: String,
    file_path: Option<String>,
) -> Result<Vec<FileDiff>, GitError> {
    diff::get_diff(&worktree_path, file_path.as_deref())
}

#[tauri::command]
pub fn git_commit(request: CommitRequest) -> Result<CommitResult, GitError> {
    commit::commit(request)
}

#[tauri::command]
pub fn git_merge(request: MergeRequest) -> Result<MergeOutcome, GitError> {
    merge::merge_branch(request)
}

#[tauri::command]
pub fn git_abort_merge(repository_root: String) -> Result<(), GitError> {
    merge::abort_merge(&repository_root)
}
