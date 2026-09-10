use crate::agents::{self, Agent, AgentManager, AgentProvider, LaunchAgentRequest};
use crate::control::{AgentEventEnvelope, AgentEventKind, AgentEventPayload, AgentEventSource};
use crate::error::BackendError;
use crate::event_hub::EventHub;
use crate::pty::{
    EventSink, PtyManager, TerminalOutputEvent, TerminalSession, TerminalStatus,
    TerminalStatusEvent,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

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
    event_hub: EventHub,
    waits_for_agent_binding: bool,
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

    fn emit_control(&self, event: AgentEventEnvelope) {
        forward_control_event(&self.event_hub, event, |event| {
            let _ = self.app.emit("control-event", event);
        });
    }

    fn waits_for_agent_binding(&self) -> bool {
        self.waits_for_agent_binding
    }
}

pub(crate) fn forward_control_event(
    event_hub: &EventHub,
    event: AgentEventEnvelope,
    emit: impl FnOnce(AgentEventEnvelope),
) {
    if let Some(event) = event_hub.publish(event) {
        emit(event);
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

async fn run_blocking<T, F>(work: F) -> Result<T, BackendError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, BackendError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|err| BackendError::Internal(format!("background task failed: {err}")))?
}

fn create_terminal_impl(
    app: AppHandle,
    manager: PtyManager,
    event_hub: EventHub,
    request: CreatePtyRequest,
) -> Result<TerminalSession, BackendError> {
    validate_create_request(&request)?;
    manager.create_shell_with_size(
        Some(&request.cwd),
        request.cols,
        request.rows,
        Arc::new(AppEventSink {
            app,
            event_hub,
            waits_for_agent_binding: false,
        }),
    )
}

#[tauri::command]
pub async fn pty_create(
    app: AppHandle,
    manager: State<'_, PtyManager>,
    event_hub: State<'_, EventHub>,
    request: CreatePtyRequest,
) -> Result<TerminalSession, BackendError> {
    let manager = manager.inner().clone();
    let event_hub = event_hub.inner().clone();
    run_blocking(move || create_terminal_impl(app, manager, event_hub, request)).await
}

#[tauri::command]
pub async fn create_terminal(
    app: AppHandle,
    manager: State<'_, PtyManager>,
    event_hub: State<'_, EventHub>,
    request: CreatePtyRequest,
) -> Result<TerminalSession, BackendError> {
    let manager = manager.inner().clone();
    let event_hub = event_hub.inner().clone();
    run_blocking(move || create_terminal_impl(app, manager, event_hub, request)).await
}

#[tauri::command]
pub async fn pty_write(
    manager: State<'_, PtyManager>,
    id: String,
    data: String,
) -> Result<(), BackendError> {
    let manager = manager.inner().clone();
    manager.write(&id, &data)
}

#[tauri::command]
pub async fn write_terminal(
    manager: State<'_, PtyManager>,
    id: String,
    data: String,
) -> Result<(), BackendError> {
    let manager = manager.inner().clone();
    manager.write(&id, &data)
}

#[tauri::command]
pub async fn pty_resize(
    manager: State<'_, PtyManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), BackendError> {
    let manager = manager.inner().clone();
    validate_dimensions_request(cols, rows)?;
    manager.resize(&id, cols, rows)
}

#[tauri::command]
pub async fn resize_terminal(
    manager: State<'_, PtyManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), BackendError> {
    let manager = manager.inner().clone();
    validate_dimensions_request(cols, rows)?;
    manager.resize(&id, cols, rows)
}

#[tauri::command]
pub async fn pty_close(manager: State<'_, PtyManager>, id: String) -> Result<(), BackendError> {
    let manager = manager.inner().clone();
    run_blocking(move || manager.kill(&id)).await
}

#[tauri::command]
pub async fn kill_terminal(manager: State<'_, PtyManager>, id: String) -> Result<(), BackendError> {
    let manager = manager.inner().clone();
    run_blocking(move || manager.kill(&id)).await
}

async fn detect_providers_impl(force: bool) -> Result<Vec<AgentProvider>, BackendError> {
    run_blocking(move || Ok(agents::detect_providers_cached(force))).await
}

#[tauri::command]
pub async fn list_agent_providers() -> Result<Vec<AgentProvider>, BackendError> {
    detect_providers_impl(false).await
}

#[tauri::command]
pub async fn detect_agent_providers() -> Result<Vec<AgentProvider>, BackendError> {
    detect_providers_impl(true).await
}

#[tauri::command]
pub async fn detect_providers() -> Result<Vec<AgentProvider>, BackendError> {
    detect_providers_impl(true).await
}

#[tauri::command]
pub async fn launch_agent(
    app: AppHandle,
    manager: State<'_, PtyManager>,
    agents: State<'_, AgentManager>,
    event_hub: State<'_, EventHub>,
    request: LaunchAgentRequest,
) -> Result<Agent, BackendError> {
    let pty = manager.inner().clone();
    let agents = agents.inner().clone();
    let event_hub = event_hub.inner().clone();
    run_blocking(move || {
        let project_id = request.cwd.clone();
        let sink = Arc::new(AppEventSink {
            app,
            event_hub,
            waits_for_agent_binding: true,
        });
        let agent = agents.launch(request, &pty, sink)?;
        pty.bind_agent(
            &agent.terminal_id,
            project_id,
            agent.id.clone(),
            agent.provider.clone(),
        )?;
        Ok(agent)
    })
    .await
}

pub(crate) fn control_events_after_from_hub(
    event_hub: &EventHub,
    sequence: u64,
) -> Vec<AgentEventEnvelope> {
    event_hub.subscribe_after(sequence)
}

#[tauri::command]
pub fn control_events_after(
    event_hub: State<'_, EventHub>,
    sequence: u64,
) -> Vec<AgentEventEnvelope> {
    control_events_after_from_hub(event_hub.inner(), sequence)
}

fn validate_attention_scope(project_id: &str, agent_id: Option<&str>) -> Result<(), BackendError> {
    if project_id.trim().is_empty() || agent_id.is_some_and(|id| id.trim().is_empty()) {
        return Err(BackendError::InvalidInput(
            "attention acknowledgement requires a project and a non-empty agent when supplied"
                .to_owned(),
        ));
    }
    Ok(())
}

fn publish_attention_event(
    event_hub: &EventHub,
    project_id: &str,
    agent_id: Option<&str>,
    kind: AgentEventKind,
) -> Result<AgentEventEnvelope, BackendError> {
    validate_attention_scope(project_id, agent_id)?;
    let mut event = AgentEventEnvelope::new(
        Uuid::new_v4().to_string(),
        project_id.to_owned(),
        agent_id.map(str::to_owned),
        kind,
        AgentEventPayload::Empty,
    );
    event.source = AgentEventSource::User;
    event_hub
        .publish(event)
        .ok_or_else(|| BackendError::Internal("could not publish attention event".to_owned()))
}

pub(crate) fn publish_attention_ack(
    event_hub: &EventHub,
    project_id: &str,
    agent_id: &str,
) -> Result<AgentEventEnvelope, BackendError> {
    publish_attention_event(
        event_hub,
        project_id,
        Some(agent_id),
        AgentEventKind::AttentionAck,
    )
}

pub(crate) fn publish_attention_mark_all_read(
    event_hub: &EventHub,
    project_id: &str,
) -> Result<AgentEventEnvelope, BackendError> {
    publish_attention_event(
        event_hub,
        project_id,
        None,
        AgentEventKind::AttentionMarkAllRead,
    )
}

#[tauri::command]
pub fn attention_ack(
    app: AppHandle,
    event_hub: State<'_, EventHub>,
    project_id: String,
    agent_id: String,
) -> Result<AgentEventEnvelope, BackendError> {
    let event = publish_attention_ack(event_hub.inner(), &project_id, &agent_id)?;
    let _ = app.emit("control-event", event.clone());
    Ok(event)
}

#[tauri::command]
pub fn attention_mark_all_read(
    app: AppHandle,
    event_hub: State<'_, EventHub>,
    project_id: String,
) -> Result<AgentEventEnvelope, BackendError> {
    let event = publish_attention_mark_all_read(event_hub.inner(), &project_id)?;
    let _ = app.emit("control-event", event.clone());
    Ok(event)
}

#[tauri::command]
pub async fn stop_agent(
    manager: State<'_, PtyManager>,
    agents: State<'_, AgentManager>,
    id: String,
) -> Result<(), BackendError> {
    let pty = manager.inner().clone();
    let agents = agents.inner().clone();
    run_blocking(move || agents.stop(&id, &pty)).await
}

#[tauri::command]
pub async fn list_agents(
    manager: State<'_, PtyManager>,
    agents: State<'_, AgentManager>,
) -> Result<Vec<Agent>, BackendError> {
    let pty = manager.inner().clone();
    let agents = agents.inner().clone();
    run_blocking(move || agents.list(&pty)).await
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
