pub mod agents;
pub mod commands;
pub mod error;
pub mod pty;
pub mod system;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod git;

use commands::{
    create_terminal, detect_agent_providers, kill_terminal, launch_agent, list_agent_providers,
    list_agents, pty_close, pty_create, pty_resize, pty_write, resize_terminal, stop_agent,
    write_terminal,
};
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
        .manage(pty::PtyManager::default())
        .manage(agents::AgentManager::default())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            pty_create,
            pty_write,
            pty_resize,
            pty_close,
            create_terminal,
            write_terminal,
            resize_terminal,
            kill_terminal,
            list_agent_providers,
            detect_agent_providers,
            launch_agent,
            stop_agent,
            list_agents,
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
