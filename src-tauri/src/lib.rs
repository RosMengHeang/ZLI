pub mod agents;
pub mod commands;
pub mod control;
pub mod error;
pub mod pty;
pub mod system;

#[path = "control/event_hub.rs"]
mod event_hub;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod git;

use commands::{
    attention_ack, attention_mark_all_read, control_events_after, control_session_reconnect,
    control_session_restore, control_session_resume, control_session_snapshot, create_terminal,
    detect_agent_providers, detect_providers, kill_terminal, launch_agent, list_agent_providers,
    list_agents, pty_close, pty_create, pty_resize, pty_write, resize_terminal, stop_agent,
    write_terminal,
};
use git::commands::{
    git_abort_merge, git_commit, git_create_worktree, git_delete_branch, git_diff,
    git_list_worktrees, git_merge, git_prune_worktrees, git_remove_worktree, git_status,
    git_validate_repository,
};
use std::sync::Arc;
use tauri::{webview::PageLoadEvent, Emitter, Manager};

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
        .on_page_load(|webview, payload| {
            if !webview.label().starts_with("browser-panel-") {
                return;
            }
            let phase = match payload.event() {
                PageLoadEvent::Started => "started",
                PageLoadEvent::Finished => "finished",
            };
            let _ = webview.window().emit(
                "browser-navigation",
                serde_json::json!({
                    "label": webview.label(),
                    "url": payload.url().as_str(),
                    "phase": phase,
                }),
            );
        })
        .manage(pty::PtyManager::default())
        .manage(agents::AgentManager::default())
        .manage(event_hub::EventHub::default())
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            let pty = app.state::<pty::PtyManager>().inner().clone();
            let events = app.state::<event_hub::EventHub>().inner().clone();
            let supervisor = control::Supervisor::new(app_data_dir, pty, events);
            let _ = supervisor.start_or_connect();
            app.manage(Arc::new(supervisor));
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
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
            detect_providers,
            launch_agent,
            stop_agent,
            list_agents,
            control_events_after,
            attention_ack,
            attention_mark_all_read,
            control_session_reconnect,
            control_session_snapshot,
            control_session_restore,
            control_session_resume,
            git_validate_repository,
            git_create_worktree,
            git_list_worktrees,
            git_prune_worktrees,
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
