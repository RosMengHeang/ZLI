//! End-to-end tests against disposable temporary Git repositories. Nothing
//! here ever touches a real project — every test creates its own `tempfile`
//! repo and Git cleans it up when the `TempDir` drops.

use super::commit::{commit, CommitRequest};
use super::diff::get_diff;
use super::error::GitError;
use super::merge::{abort_merge, merge_branch, MergeOutcome, MergeRequest};
use super::repo::validate_repository;
use super::status::{get_status, FileStatus};
use super::worktree::{
    audit_worktrees, create_worktree, list_worktrees, remove_worktree, CreateWorktreeRequest,
    RemoveWorktreeRequest, WorktreeAuditState,
};
use std::fs;
use std::path::Path;
use std::process::Command;
use tempfile::TempDir;

fn git(dir: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args(args)
        .current_dir(dir)
        .status()
        .expect("failed to spawn git");
    assert!(status.success(), "git {args:?} failed in {dir:?}");
}

fn init_repo() -> TempDir {
    let tmp = tempfile::tempdir().expect("create temp dir");
    git(tmp.path(), &["init", "-b", "main"]);
    git(tmp.path(), &["config", "user.email", "test@example.com"]);
    git(tmp.path(), &["config", "user.name", "Swarmterm Test"]);
    fs::write(tmp.path().join("README.md"), "hello\n").expect("write readme");
    git(tmp.path(), &["add", "-A"]);
    git(tmp.path(), &["commit", "-m", "initial commit"]);
    tmp
}

#[test]
fn full_worktree_review_workflow() {
    let repo = init_repo();
    let repo_path = repo.path().to_string_lossy().into_owned();

    let info = validate_repository(&repo_path).expect("validate_repository");
    assert_eq!(info.current_branch.as_deref(), Some("main"));
    assert_eq!(info.base_branch.as_deref(), Some("main"));
    assert!(info.clean);

    let created = create_worktree(CreateWorktreeRequest {
        repository_root: repo_path.clone(),
        provider: "test-agent".to_string(),
        base_branch: None,
    })
    .expect("create_worktree");
    assert!(created.branch.starts_with("swarm/test-agent-"));
    assert!(Path::new(&created.worktree_path).exists());
    // Storage location must be a sibling of the repo, never nested inside it.
    assert!(!Path::new(&created.worktree_path).starts_with(&repo_path));

    let worktrees = list_worktrees(&repo_path).expect("list_worktrees");
    assert_eq!(worktrees.len(), 2, "expected main + agent worktree");
    assert!(worktrees.iter().any(|w| w.is_main));
    assert!(worktrees
        .iter()
        .any(|w| w.branch.as_deref() == Some(created.branch.as_str())));

    fs::write(
        Path::new(&created.worktree_path).join("README.md"),
        "hello\nchanged by agent\n",
    )
    .expect("modify file");

    let status = get_status(&created.worktree_path).expect("get_status");
    assert!(!status.clean);
    assert_eq!(status.changed_files.len(), 1);
    assert_eq!(status.changed_files[0].path, "README.md");
    assert_eq!(status.changed_files[0].status, FileStatus::Modified);

    let diffs = get_diff(&created.worktree_path, None).expect("get_diff (overall)");
    assert_eq!(diffs.len(), 1);
    assert!(diffs[0].diff.contains("changed by agent"));

    let scoped_diffs =
        get_diff(&created.worktree_path, Some("README.md")).expect("get_diff (per-file)");
    assert_eq!(scoped_diffs.len(), 1);
    assert_eq!(scoped_diffs[0].path, "README.md");

    let commit_result = commit(CommitRequest {
        worktree_path: created.worktree_path.clone(),
        message: "agent: update readme".to_string(),
        stage_all: true,
    })
    .expect("commit");
    assert_eq!(commit_result.files_changed, 1);
    assert_eq!(commit_result.additions, 1);

    let post_commit_status = get_status(&created.worktree_path).expect("status after commit");
    assert!(post_commit_status.clean);

    let outcome = merge_branch(MergeRequest {
        repository_root: repo_path.clone(),
        source_branch: created.branch.clone(),
        target_branch: None,
    })
    .expect("merge_branch");
    match outcome {
        MergeOutcome::Success { target_branch, .. } => assert_eq!(target_branch, "main"),
        MergeOutcome::Conflict { .. } => panic!("expected a clean merge, got a conflict"),
    }

    let merged_content = fs::read_to_string(repo.path().join("README.md")).unwrap();
    assert!(merged_content.contains("changed by agent"));

    let removed = remove_worktree(RemoveWorktreeRequest {
        repository_root: repo_path.clone(),
        worktree_path: created.worktree_path.clone(),
        force: false,
    })
    .expect("remove clean worktree");
    assert!(!removed.forced);
    assert!(!Path::new(&created.worktree_path).exists());
}

#[test]
fn refuses_to_remove_dirty_worktree_without_explicit_force() {
    let repo = init_repo();
    let repo_path = repo.path().to_string_lossy().into_owned();

    let created = create_worktree(CreateWorktreeRequest {
        repository_root: repo_path.clone(),
        provider: "dirty-agent".to_string(),
        base_branch: None,
    })
    .expect("create_worktree");

    fs::write(
        Path::new(&created.worktree_path).join("scratch.txt"),
        "work in progress",
    )
    .expect("write scratch file");

    let err = remove_worktree(RemoveWorktreeRequest {
        repository_root: repo_path.clone(),
        worktree_path: created.worktree_path.clone(),
        force: false,
    })
    .expect_err("removal without force must be refused");
    assert!(matches!(err, GitError::DirtyWorktree { .. }));
    assert!(
        Path::new(&created.worktree_path).exists(),
        "nothing should have been deleted"
    );

    let removed = remove_worktree(RemoveWorktreeRequest {
        repository_root: repo_path,
        worktree_path: created.worktree_path.clone(),
        force: true,
    })
    .expect("explicit force removal should succeed");
    assert!(removed.forced);
    assert!(!Path::new(&created.worktree_path).exists());
}

#[test]
fn lists_and_removes_an_empty_orphaned_agent_slot() {
    let repo = init_repo();
    let repo_path = repo.path().to_string_lossy().into_owned();
    let worktrees_root = repo
        .path()
        .parent()
        .unwrap()
        .join(format!("{}.worktrees", repo.path().file_name().unwrap().to_string_lossy()));
    let orphan = worktrees_root.join("claude-code-deadbeef");
    fs::create_dir_all(&orphan).expect("create orphaned agent slot");

    let listed = list_worktrees(&repo_path).expect("list worktrees");
    let orphan_entry = listed
        .iter()
        .find(|worktree| Path::new(&worktree.path) == orphan)
        .expect("orphaned slot should be listed");
    assert!(orphan_entry.orphaned);

    remove_worktree(RemoveWorktreeRequest {
        repository_root: repo_path,
        worktree_path: orphan.to_string_lossy().into_owned(),
        force: false,
    })
    .expect("remove empty orphaned slot");
    assert!(!orphan.exists());
    fs::remove_dir_all(worktrees_root).expect("remove empty worktree storage directory");
}

#[test]
fn audits_worktrees_without_treating_every_folder_as_safe_to_delete() {
    let repo = init_repo();
    let repo_path = repo.path().to_string_lossy().into_owned();
    let created = create_worktree(CreateWorktreeRequest {
        repository_root: repo_path.clone(),
        provider: "audit-agent".to_string(),
        base_branch: None,
    })
    .expect("create worktree");
    let worktrees_root = repo
        .path()
        .parent()
        .unwrap()
        .join(format!("{}.worktrees", repo.path().file_name().unwrap().to_string_lossy()));
    let empty_orphan = worktrees_root.join("claude-code-empty123");
    let dirty_orphan = worktrees_root.join("codex-dirty123");
    fs::create_dir_all(&empty_orphan).expect("create empty orphan");
    fs::create_dir_all(&dirty_orphan).expect("create dirty orphan");
    fs::write(dirty_orphan.join("notes.txt"), "keep this file").expect("write orphan file");

    let audit = audit_worktrees(&repo_path).expect("audit worktrees");
    let main = audit
        .entries
        .iter()
        .find(|entry| entry.path == repo_path)
        .expect("main worktree");
    assert_eq!(main.state, WorktreeAuditState::Main);
    assert!(!main.safe_to_remove_without_force);

    let registered = audit
        .entries
        .iter()
        .find(|entry| entry.path == created.worktree_path)
        .expect("registered worktree");
    assert_eq!(registered.state, WorktreeAuditState::RegisteredClean);
    assert!(!registered.safe_to_remove_without_force);
    assert!(registered.note.as_deref().unwrap_or_default().contains("runtime"));

    let empty = audit
        .entries
        .iter()
        .find(|entry| entry.path == empty_orphan.to_string_lossy())
        .expect("empty orphan");
    assert_eq!(empty.state, WorktreeAuditState::OrphanedEmpty);
    assert!(empty.safe_to_remove_without_force);
    assert!(!empty.requires_force);

    let dirty = audit
        .entries
        .iter()
        .find(|entry| entry.path == dirty_orphan.to_string_lossy())
        .expect("dirty orphan");
    assert_eq!(dirty.state, WorktreeAuditState::OrphanedNonEmpty);
    assert!(!dirty.safe_to_remove_without_force);
    assert!(dirty.requires_force);
}

#[test]
fn detects_merge_conflicts_and_leaves_them_for_manual_resolution() {
    let repo = init_repo();
    let repo_path = repo.path().to_string_lossy().into_owned();

    let created = create_worktree(CreateWorktreeRequest {
        repository_root: repo_path.clone(),
        provider: "conflict-agent".to_string(),
        base_branch: None,
    })
    .expect("create_worktree");

    fs::write(
        Path::new(&created.worktree_path).join("README.md"),
        "agent's version\n",
    )
    .unwrap();
    commit(CommitRequest {
        worktree_path: created.worktree_path.clone(),
        message: "agent edits readme".to_string(),
        stage_all: true,
    })
    .expect("agent commit");

    fs::write(repo.path().join("README.md"), "base's version\n").unwrap();
    commit(CommitRequest {
        worktree_path: repo_path.clone(),
        message: "base edits readme".to_string(),
        stage_all: true,
    })
    .expect("base commit");

    let outcome = merge_branch(MergeRequest {
        repository_root: repo_path.clone(),
        source_branch: created.branch,
        target_branch: None,
    })
    .expect("merge_branch should surface a conflict result, not an Err");

    match outcome {
        MergeOutcome::Conflict {
            conflicted_files, ..
        } => {
            assert_eq!(conflicted_files, vec!["README.md".to_string()]);
        }
        MergeOutcome::Success { .. } => panic!("expected a conflict"),
    }

    // The conflict must be left in place -- nothing force-reset or overwritten.
    let mid_merge = fs::read_to_string(repo.path().join("README.md")).unwrap();
    assert!(mid_merge.contains("<<<<<<<"));

    abort_merge(&repo_path).expect("abort_merge should clean up the aborted attempt");
    let status = get_status(&repo_path).expect("status after abort");
    assert!(status.clean);
    let restored = fs::read_to_string(repo.path().join("README.md")).unwrap();
    assert_eq!(restored.replace("\r\n", "\n"), "base's version\n");
}
