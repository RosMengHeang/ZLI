use crate::agents::{self, Agent, AgentManager, AgentProvider, LaunchAgentRequest};
use crate::error::BackendError;
use crate::pty::{
    EventSink, PtyManager, TerminalOutputEvent, TerminalSession, TerminalStatus,
    TerminalStatusEvent,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

const MAX_COLS: u16 = 10_000;
const MAX_ROWS: u16 = 10_000;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePtyRequest {
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub argv: Option<Vec<String>>,
}

#[derive(Clone)]
struct AppEventSink {
    app: AppHandle,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyOutputPayload {
    id: String,
    data: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyExitPayload {
    id: String,
    exit_code: Option<i32>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyErrorPayload {
    id: String,
    message: String,
}

impl EventSink for AppEventSink {
    fn emit_output(&self, event: TerminalOutputEvent) {
        let _ = self.app.emit(
            "pty-output",
            PtyOutputPayload {
                id: event.terminal_id,
                data: event.data,
            },
        );
    }

    fn emit_status(&self, event: TerminalStatusEvent) {
        match event.status {
            TerminalStatus::Exited | TerminalStatus::Killed => {
                let _ = self.app.emit(
                    "pty-exit",
                    PtyExitPayload {
                        id: event.terminal_id,
                        exit_code: None,
                    },
                );
            }
            TerminalStatus::Failed => {
                let _ = self.app.emit(
                    "pty-error",
                    PtyErrorPayload {
                        id: event.terminal_id,
                        message: "PTY reader stopped unexpectedly".to_owned(),
                    },
                );
            }
            TerminalStatus::Running => {}
        }
    }
}

pub(crate) fn validate_dimensions_request(cols: u16, rows: u16) -> Result<(), BackendError> {
    if cols == 0 || rows == 0 || cols > MAX_COLS || rows > MAX_ROWS {
        return Err(BackendError::InvalidInput(format!(
            "terminal dimensions must be between 1 and {MAX_COLS} columns and 1 and {MAX_ROWS} rows"
        )));
    }
    Ok(())
}

pub(crate) fn validate_create_request(request: &CreatePtyRequest) -> Result<(), BackendError> {
    validate_dimensions_request(request.cols, request.rows)?;
    if request.argv.as_ref().is_some_and(|argv| !argv.is_empty()) {
        return Err(BackendError::InvalidInput(
            "arbitrary terminal commands are not supported; use an agent provider or the detected shell"
                .to_owned(),
        ));
    }
    Ok(())
}

fn create_terminal_impl(
    app: AppHandle,
    manager: State<'_, PtyManager>,
    request: CreatePtyRequest,
) -> Result<TerminalSession, BackendError> {
    validate_create_request(&request)?;
    manager.create_shell_with_size(
        Some(&request.cwd),
        request.cols,
        request.rows,
        Arc::new(AppEventSink { app }),
    )
}

#[tauri::command]
pub fn pty_create(
    app: AppHandle,
    manager: State<'_, PtyManager>,
    request: CreatePtyRequest,
) -> Result<TerminalSession, BackendError> {
    create_terminal_impl(app, manager, request)
}

#[tauri::command]
pub fn create_terminal(
    app: AppHandle,
    manager: State<'_, PtyManager>,
    request: CreatePtyRequest,
) -> Result<TerminalSession, BackendError> {
    create_terminal_impl(app, manager, request)
}

fn write_terminal_impl(
    manager: State<'_, PtyManager>,
    id: String,
    data: String,
) -> Result<(), BackendError> {
    manager.write(&id, &data)
}

#[tauri::command]
pub fn pty_write(
    manager: State<'_, PtyManager>,
    id: String,
    data: String,
) -> Result<(), BackendError> {
    write_terminal_impl(manager, id, data)
}

#[tauri::command]
pub fn write_terminal(
    manager: State<'_, PtyManager>,
    id: String,
    data: String,
) -> Result<(), BackendError> {
    write_terminal_impl(manager, id, data)
}

fn resize_terminal_impl(
    manager: State<'_, PtyManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), BackendError> {
    validate_dimensions_request(cols, rows)?;
    manager.resize(&id, cols, rows)
}

#[tauri::command]
pub fn pty_resize(
    manager: State<'_, PtyManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), BackendError> {
    resize_terminal_impl(manager, id, cols, rows)
}

#[tauri::command]
pub fn resize_terminal(
    manager: State<'_, PtyManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), BackendError> {
    resize_terminal_impl(manager, id, cols, rows)
}

fn kill_terminal_impl(manager: State<'_, PtyManager>, id: String) -> Result<(), BackendError> {
    manager.kill(&id)
}

#[tauri::command]
pub fn pty_close(manager: State<'_, PtyManager>, id: String) -> Result<(), BackendError> {
    kill_terminal_impl(manager, id)
}

#[tauri::command]
pub fn kill_terminal(manager: State<'_, PtyManager>, id: String) -> Result<(), BackendError> {
    kill_terminal_impl(manager, id)
}

#[tauri::command]
pub fn list_agent_providers() -> Result<Vec<AgentProvider>, BackendError> {
    Ok(agents::detect_providers())
}

#[tauri::command]
pub fn detect_agent_providers() -> Result<Vec<AgentProvider>, BackendError> {
    list_agent_providers()
}

#[tauri::command]
pub fn launch_agent(
    app: AppHandle,
    manager: State<'_, PtyManager>,
    agents: State<'_, AgentManager>,
    request: LaunchAgentRequest,
) -> Result<Agent, BackendError> {
    agents.launch(request, &manager, Arc::new(AppEventSink { app }))
}

#[tauri::command]
pub fn stop_agent(
    manager: State<'_, PtyManager>,
    agents: State<'_, AgentManager>,
    id: String,
) -> Result<(), BackendError> {
    agents.stop(&id, &manager)
}

#[tauri::command]
pub fn list_agents(
    manager: State<'_, PtyManager>,
    agents: State<'_, AgentManager>,
) -> Result<Vec<Agent>, BackendError> {
    agents.list(&manager)
}

#[cfg(test)]
mod tests {
    use super::{validate_create_request, validate_dimensions_request, CreatePtyRequest};

    #[test]
    fn terminal_request_rejects_frontend_command_arguments() {
        let request = CreatePtyRequest {
            cwd: ".".to_owned(),
            cols: 80,
            rows: 24,
            title: None,
            argv: Some(vec!["git".to_owned(), "status".to_owned()]),
        };
        assert!(validate_create_request(&request).is_err());
    }

    #[test]
    fn terminal_request_rejects_invalid_dimensions() {
        assert!(validate_dimensions_request(0, 24).is_err());
        assert!(validate_dimensions_request(80, 0).is_err());
    }
}
