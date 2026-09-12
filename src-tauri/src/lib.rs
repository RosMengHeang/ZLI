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
    attention_ack, attention_mark_all_read, browser_close_surface, browser_create_panel_webview,
    browser_grant_capability, browser_register_surface, browser_reject_open,
    browser_revoke_capability, browser_update_navigation, browser_control_set,
    browser_control_status, control_events_after, control_request, control_session_reconcile,
    control_session_reconnect, control_session_forget, control_session_restore,
    control_session_resume, control_session_snapshot, create_terminal, detect_agent_providers,
    detect_providers, kill_terminal, launch_agent, list_agent_providers, list_agents,
    provider_capability_report, pull_agent_inbox, pty_close, pty_create, pty_resize, pty_write,
    resize_terminal, stop_agent, write_terminal,
};
use git::commands::{
    git_abort_merge, git_audit_worktrees, git_commit, git_create_worktree, git_delete_branch,
    git_diff, git_list_worktrees, git_merge, git_prune_worktrees, git_remove_worktree, git_status,
    git_validate_repository,
};
use std::sync::Arc;
use tauri::{webview::PageLoadEvent, Emitter, Manager};

#[cfg(windows)]
struct AppControlServer {
    _server: control::NamedPipeServer,
    connection_file: std::path::PathBuf,
}

#[cfg(windows)]
impl Drop for AppControlServer {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.connection_file);
    }
}

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
            if matches!(payload.event(), PageLoadEvent::Started) {
                let _ = webview.eval(control::instrumentation_script());
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
            std::fs::create_dir_all(control::clean_profile_data_dir(&app_data_dir))?;
            let control_dir = app_data_dir.join("control");
            let pty = app.state::<pty::PtyManager>().inner().clone();
            let events = app.state::<event_hub::EventHub>().inner().clone();
            events.enable_persistence(control_dir.clone())?;
            let supervisor = Arc::new(control::Supervisor::new(
                app_data_dir.clone(),
                pty.clone(),
                events.clone(),
            ));
            let _ = supervisor.start_or_connect();
            app.manage(supervisor.clone());
            let agents = app.state::<agents::AgentManager>().inner().clone();
            let tokens = Arc::new(control::CapabilityTokenStore::default());
            #[cfg(windows)]
            let endpoint = control::NamedPipeServer::random_endpoint();
            #[cfg(not(windows))]
            let endpoint = String::new();
            let observer_slot: commands::ControlEventObserverSlot =
                Arc::new(std::sync::Mutex::new(None));
            let sink = commands::app_event_sink_with_observer(
                app.handle().clone(),
                events,
                observer_slot.clone(),
            );
            let browser_sink = sink.clone();
            let browser_settings = Arc::new(
                control::BrowserControlSettingsStore::open(&control_dir)?,
            );
            let browser = Arc::new(control::BrowserManager::with_settings(
                Arc::new(move |event| {
                    browser_sink.emit_control(event);
                }),
                browser_settings,
            ));
            let browser_executor =
                Arc::new(control::TauriBrowserExecutor::new(app.handle().clone()));
            app.manage(browser.clone());
            app.manage(browser_executor.clone());
            let team_backend = Arc::new(control::RuntimeTeamBackend::new(
                pty.clone(),
                agents.clone(),
                supervisor.clone(),
                sink.clone(),
            ));
            let context = control::ManagedAgentContext::new(
                tokens.clone(),
                control::ControlEndpoint::from_transport(endpoint.clone()),
                control::install_directory().map_err(|error| error.to_string())?,
                sink.clone(),
            );
            let team = Arc::new(
                control::TeamCoordinator::with_overlay_root(
                    team_backend,
                    context,
                    app_data_dir.join("provider-tools"),
                )
                    .with_message_store(control::SnapshotStore::new(app_data_dir.clone()))?,
            );
            app.manage(team.clone());
            let team_observer = Arc::downgrade(&team);
            if let Ok(mut observer) = observer_slot.lock() {
                *observer = Some(Arc::new(move |event| {
                    if let Some(team) = team_observer.upgrade() {
                        team.handle_event(event);
                    }
                }));
            }
            let handler = Arc::new(control::RuntimeControlHandler::new(
                pty,
                agents,
                supervisor,
                team,
                browser,
                browser_executor,
                sink,
            ));
            let router = Arc::new(control::CommandRouter::new(handler));
            app.manage(Arc::new(control::ControlService::new(router.clone())));
            #[cfg(windows)]
            {
                let issued = tokens.issue(
                    control::local_cli_identity(),
                    std::time::Duration::from_secs(12 * 60 * 60),
                );
                let server = control::NamedPipeServer::start(endpoint, router, tokens)?;
                let control_dir = app_data_dir.join("control");
                std::fs::create_dir_all(&control_dir)?;
                let connection_file = control_dir.join("endpoint.json");
                let connection = serde_json::json!({
                    "protocolVersion": control::CONTROL_PROTOCOL_VERSION,
                    "endpoint": server.endpoint(),
                    "token": issued.token,
                    "expiresAt": issued.expires_at,
                    "processId": std::process::id(),
                });
                std::fs::write(&connection_file, serde_json::to_vec(&connection)?)?;
                app.manage(AppControlServer {
                    _server: server,
                    connection_file,
                });
            }
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
            pull_agent_inbox,
            provider_capability_report,
            list_agents,
            control_events_after,
            attention_ack,
            attention_mark_all_read,
            control_session_reconnect,
            control_session_reconcile,
            control_session_snapshot,
            control_session_restore,
            control_session_forget,
            control_session_resume,
            control_request,
            browser_register_surface,
            browser_reject_open,
            browser_create_panel_webview,
            browser_update_navigation,
            browser_grant_capability,
            browser_revoke_capability,
            browser_close_surface,
            browser_control_status,
            browser_control_set,
            git_validate_repository,
            git_create_worktree,
            git_list_worktrees,
            git_audit_worktrees,
            git_prune_worktrees,
            git_remove_worktree,
            git_delete_branch,
            git_status,
            git_diff,
            git_commit,
            git_merge,
            git_abort_merge,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                // Do not leave provider CLIs alive after the desktop runtime
                // exits. The frontend checkpoint retains resumable metadata;
                // the PTY itself is an in-memory runtime resource.
                let _ = app.state::<pty::PtyManager>().shutdown();
                let _ = app.state::<Arc<control::Supervisor>>().shutdown();
            }
        });
}
