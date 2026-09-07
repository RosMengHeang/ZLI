pub mod agents;
pub mod commands;
pub mod error;
pub mod pty;
pub mod system;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod git;

use git::commands::{
    git_abort_merge, git_commit, git_create_worktree, git_delete_branch, git_diff,
    git_list_worktrees, git_merge, git_remove_worktree, git_status, git_validate_repository,
};

// Placeholder demo command from the create-tauri-app template; left in place
// so the scaffolded frontend's demo button keeps working until the real UI
// (owned by the frontend engineer) replaces it.
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            git_validate_repository,
            git_create_worktree,
            git_list_worktrees,
            git_remove_worktree,
            git_delete_branch,
            git_status,
            git_diff,
            git_commit,
            git_merge,
            git_abort_merge,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
