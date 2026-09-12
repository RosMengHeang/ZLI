use crate::agents::{self, Agent, AgentManager, AgentProvider, LaunchAgentRequest};
use crate::control::browser::commands::BrowserCapability;
use crate::control::{
    AgentEventEnvelope, AgentEventKind, AgentEventPayload, AgentEventSource, BrowserControlStatus,
    BrowserManager, BrowserSurfaceRecord, ControlErrorCode, LaunchIntent, ProjectSnapshot,
    PullReceipt, ReconcileReport, ReconnectResult, RestoreResult, SessionCommandError,
    SessionDescriptor, Supervisor, TeamCoordinator, TauriBrowserExecutor,
};
use crate::agents::providers::ProviderCapabilityReport;
use crate::error::BackendError;
use crate::event_hub::EventHub;
use crate::pty::{
    EventSink, PtyManager, TerminalOutputEvent, TerminalSession, TerminalStatus,
    TerminalStatusEvent,
};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
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

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshotRequest {
    pub project_id: String,
    pub pane_tree: serde_json::Value,
    #[serde(default)]
    pub browser: Vec<serde_json::Value>,
    #[serde(default)]
    pub tax_chat_room: Option<serde_json::Value>,
    pub last_event_sequence: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterBrowserSurfaceRequest {
    pub project_id: String,
    #[serde(default)]
    pub agent_id: Option<String>,
    pub webview_label: String,
    pub url: String,
    pub profile_id: String,
}

#[derive(Clone)]
pub(crate) struct AppEventSink {
    app: AppHandle,
    event_hub: EventHub,
    waits_for_agent_binding: bool,
    observer: Option<ControlEventObserverSlot>,
}

pub(crate) type ControlEventObserver = Arc<dyn Fn(&AgentEventEnvelope) + Send + Sync>;
pub(crate) type ControlEventObserverSlot = Arc<Mutex<Option<ControlEventObserver>>>;

struct DirectAgentLaunchSlot {
    supervisor: Arc<Supervisor>,
    project_id: String,
}

impl Drop for DirectAgentLaunchSlot {
    fn drop(&mut self) {
        self.supervisor.release_agent_slot(&self.project_id);
    }
}

pub(crate) fn app_event_sink_with_observer(
    app: AppHandle,
    event_hub: EventHub,
    observer: ControlEventObserverSlot,
) -> Arc<dyn EventSink> {
    Arc::new(AppEventSink {
        app,
        event_hub,
        waits_for_agent_binding: true,
        observer: Some(observer),
    })
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
                        exit_code: event.exit_code,
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
            if let Some(observer) = self
                .observer
                .as_ref()
                .and_then(|slot| slot.lock().ok()?.clone())
            {
                observer(&event);
            }
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

async fn run_control_blocking<T, F>(work: F) -> Result<T, SessionCommandError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, SessionCommandError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| SessionCommandError::Runtime(format!("background task failed: {error}")))?
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
            observer: None,
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
    manager: State<'_, PtyManager>,
    agents: State<'_, AgentManager>,
    supervisor: State<'_, Arc<Supervisor>>,
    team: State<'_, Arc<TeamCoordinator>>,
    request: LaunchAgentRequest,
) -> Result<Agent, BackendError> {
    let (pty, agents) = (manager.inner().clone(), agents.inner().clone());
    let (supervisor, team) = (supervisor.inner().clone(), team.inner().clone());
    run_blocking(move || {
        let project_id = request.cwd.clone();
        if !supervisor.reserve_agent_slot(&project_id).map_err(|error| {
            BackendError::Internal(format!("could not reserve agent slot: {error:?}"))
        })? {
            return Err(BackendError::InvalidInput(
                "This project already has 12 agents".into(),
            ));
        }
        let _slot = DirectAgentLaunchSlot {
            supervisor: supervisor.clone(),
            project_id: project_id.clone(),
        };

        let launch = team.context().prepare(match request.restart_agent_id.as_deref() {
            Some(replaces) => LaunchIntent::Restart {
                replaces,
                project_id: &project_id,
                provider_id: &request.provider,
            },
            None => LaunchIntent::Direct {
                project_id: &project_id,
                provider_id: &request.provider,
            },
        })?;

        let runtime_sink = supervisor.runtime_sink(launch.sink());
        let agent = agents.launch_scoped(
            &request,
            &pty,
            runtime_sink.clone(),
            launch.environment(),
            launch.agent().agent_id.clone(),
            Some(&crate::control::ToolBindContext {
                tools: team.tools(),
                agent: launch.agent(),
                sidecars: launch.sidecars(),
            }),
        )?;
        pty.bind_agent(
            &agent.terminal_id,
            project_id.clone(),
            agent.id.clone(),
            agent.provider.clone(),
        )
        .inspect_err(|_| rollback_agent_launch(&agents, &pty, &agent, &project_id))?;
        supervisor
            .register_agent(&agent, project_id.clone(), runtime_sink)
            .inspect_err(|_| rollback_agent_launch(&agents, &pty, &agent, &project_id))
            .map_err(|error| {
                BackendError::Internal(format!("session registration failed: {error:?}"))
            })?;

        launch.commit();
        Ok(agent)
    })
    .await
}

fn rollback_agent_launch(
    agents: &AgentManager,
    pty: &PtyManager,
    agent: &Agent,
    repository_root: &str,
) {
    if agents.abort(&agent.id, pty).is_ok() {
        if let Some(worktree_path) = agent.worktree_path.as_deref() {
            let _ = crate::git::worktree::remove_worktree(
                crate::git::worktree::RemoveWorktreeRequest {
                    repository_root: repository_root.to_owned(),
                    worktree_path: worktree_path.to_owned(),
                    force: false,
                },
            );
        }
    }
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

#[tauri::command]
pub fn control_session_reconnect(
    supervisor: State<'_, Arc<Supervisor>>,
    protocol_version: u16,
    cursor: u64,
) -> Result<ReconnectResult, SessionCommandError> {
    supervisor.reconnect(protocol_version, cursor)
}

#[tauri::command]
pub fn control_session_reconcile(
    supervisor: State<'_, Arc<Supervisor>>,
) -> Result<ReconcileReport, SessionCommandError> {
    supervisor.reconcile()
}

#[tauri::command]
pub async fn control_session_snapshot(
    supervisor: State<'_, Arc<Supervisor>>,
    request: SessionSnapshotRequest,
) -> Result<ProjectSnapshot, SessionCommandError> {
    let supervisor = supervisor.inner().clone();
    run_control_blocking(move || {
        supervisor.checkpoint(
            &request.project_id,
            request.pane_tree,
            request.browser,
            request.tax_chat_room,
            request.last_event_sequence,
        )
    })
    .await
}

#[tauri::command]
pub async fn control_session_restore(
    supervisor: State<'_, Arc<Supervisor>>,
    project_id: String,
) -> Result<RestoreResult, SessionCommandError> {
    let supervisor = supervisor.inner().clone();
    run_control_blocking(move || supervisor.restore_project(&project_id)).await
}

#[tauri::command]
pub async fn control_session_forget(
    supervisor: State<'_, Arc<Supervisor>>,
    agents: State<'_, AgentManager>,
    project_id: String,
    session_id: String,
) -> Result<bool, SessionCommandError> {
    let supervisor = supervisor.inner().clone();
    let agents = agents.inner().clone();
    run_control_blocking(move || {
        let result = supervisor.forget_session(&project_id, &session_id);
        if result.is_ok() {
            let _ = agents.forget(&session_id);
        }
        result
    })
    .await
}

#[tauri::command]
pub async fn control_session_resume(
    supervisor: State<'_, Arc<Supervisor>>,
    team: State<'_, Arc<TeamCoordinator>>,
    session_id: String,
) -> Result<SessionDescriptor, SessionCommandError> {
    let (supervisor, team) = (supervisor.inner().clone(), team.inner().clone());
    run_control_blocking(move || {
        let (descriptor, _) = supervisor.read_session(&session_id)?;
        let launch = team
            .context()
            .prepare(LaunchIntent::Resume {
                descriptor: &descriptor,
            })?;
        supervisor.resume(&session_id, launch, team.tools())
    })
    .await
}

#[tauri::command]
pub fn control_request(
    service: State<'_, Arc<crate::control::ControlService>>,
    request: crate::control::ControlRequest,
) -> crate::control::ControlResponse {
    service.dispatch(request)
}

#[tauri::command]
pub fn browser_register_surface(
    browser: State<'_, Arc<BrowserManager>>,
    executor: State<'_, Arc<TauriBrowserExecutor>>,
    request: RegisterBrowserSurfaceRequest,
) -> Result<BrowserSurfaceRecord, crate::control::ControlError> {
    executor.initialize(&request.webview_label)?;
    browser.register(
        request.project_id,
        request.agent_id,
        request.webview_label,
        request.url,
        request.profile_id,
    )
}

#[tauri::command]
pub fn browser_update_navigation(
    browser: State<'_, Arc<BrowserManager>>,
    surface_id: String,
    url: String,
) -> Result<BrowserSurfaceRecord, crate::control::ControlError> {
    browser.update_navigation(&surface_id, url)
}

#[tauri::command]
pub fn browser_grant_capability(
    browser: State<'_, Arc<BrowserManager>>,
    surface_id: String,
    capability: BrowserCapability,
) -> Result<BrowserSurfaceRecord, crate::control::ControlError> {
    browser.grant(&surface_id, capability)
}

#[tauri::command]
pub fn browser_revoke_capability(
    browser: State<'_, Arc<BrowserManager>>,
    surface_id: String,
    capability: BrowserCapability,
) -> Result<BrowserSurfaceRecord, crate::control::ControlError> {
    browser.revoke(&surface_id, capability)
}

#[tauri::command]
pub fn browser_close_surface(
    browser: State<'_, Arc<BrowserManager>>,
    surface_id: String,
) -> Result<BrowserSurfaceRecord, crate::control::ControlError> {
    browser.close(&surface_id)
}

#[tauri::command]
pub fn browser_control_status(
    browser: State<'_, Arc<BrowserManager>>,
    profile_id: Option<String>,
) -> Result<BrowserControlStatus, crate::control::ControlError> {
    browser.control_status(profile_id.as_deref().unwrap_or("clean"))
}

#[tauri::command]
pub fn browser_control_set(
    browser: State<'_, Arc<BrowserManager>>,
    profile_id: Option<String>,
    enabled: bool,
) -> Result<BrowserControlStatus, crate::control::ControlError> {
    browser.set_control_enabled(profile_id.as_deref().unwrap_or("clean"), enabled)
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
    team: State<'_, Arc<TeamCoordinator>>,
    id: String,
) -> Result<(), BackendError> {
    let team = team.inner().clone();
    run_blocking(move || match team.stop("*", &id) {
        Ok(_) => Ok(()),
        Err(error) if error.code == ControlErrorCode::SessionNotFound => Ok(()),
        Err(error) => Err(BackendError::Internal(error.message)),
    })
    .await
}

#[tauri::command]
pub async fn pull_agent_inbox(
    team: State<'_, Arc<TeamCoordinator>>,
    project_id: String,
    agent_id: String,
) -> Result<PullReceipt, BackendError> {
    let team = team.inner().clone();
    run_blocking(move || {
        team.pull(&project_id, &agent_id)
            .map_err(|error| BackendError::Internal(error.message))
    })
    .await
}

#[tauri::command]
pub async fn provider_capability_report(
    team: State<'_, Arc<TeamCoordinator>>,
    provider_id: String,
) -> Result<ProviderCapabilityReport, BackendError> {
    let team = team.inner().clone();
    run_blocking(move || {
        team.capability_report(&provider_id)
            .map_err(|error| BackendError::Internal(error.message))
    })
    .await
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
    use super::{
        rollback_agent_launch, validate_create_request, validate_dimensions_request,
        CreatePtyRequest,
    };
    use crate::agents::{AgentManager, LaunchAgentRequest};
    use crate::pty::{MemoryEventSink, PtyManager};
    use std::sync::Arc;

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

    #[test]
    fn launch_rollback_forgets_an_unbound_agent_and_terminal() {
        let directory = tempfile::tempdir().unwrap();
        let pty = PtyManager::new();
        let agents = AgentManager::new();
        let agent = agents
            .launch(
                LaunchAgentRequest {
                    name: "rollback-test".to_owned(),
                    provider: "shell".to_owned(),
                    cwd: directory.path().to_string_lossy().into_owned(),
                    create_worktree: false,
                    restart_agent_id: None,
                    cols: Some(80),
                    rows: Some(24),
                },
                &pty,
                Arc::new(MemoryEventSink::awaiting_agent_binding()),
            )
            .unwrap();

        rollback_agent_launch(
            &agents,
            &pty,
            &agent,
            &directory.path().to_string_lossy(),
        );

        assert_eq!(pty.session_count(), 0);
        assert!(agents.list(&pty).unwrap().is_empty());
    }
}
