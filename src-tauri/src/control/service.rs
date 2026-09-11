use super::attention::{AttentionReducer, AttentionState};
use super::browser::commands::{BrowserCapability, BrowserCommand, BrowserResult};
use super::{
    BrowserExecutor, BrowserManager, CallerIdentity, Capability, CommandRouter, ControlError,
    ControlErrorCode, ControlHandler, ControlMethod, ControlRequest, ControlResponse,
    SpawnAgentRequest, Supervisor, TeamCoordinator, SUPERVISOR_PROTOCOL_VERSION,
};
use crate::agents::AgentManager;
use crate::pty::{EventSink, PtyManager};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};
use uuid::Uuid;

pub struct RuntimeControlHandler {
    pty: PtyManager,
    agents: AgentManager,
    supervisor: Arc<Supervisor>,
    team: Arc<TeamCoordinator>,
    browser: Arc<BrowserManager>,
    browser_executor: Arc<dyn BrowserExecutor>,
    sink: Arc<dyn EventSink>,
}

impl RuntimeControlHandler {
    pub fn new(
        pty: PtyManager,
        agents: AgentManager,
        supervisor: Arc<Supervisor>,
        team: Arc<TeamCoordinator>,
        browser: Arc<BrowserManager>,
        browser_executor: Arc<dyn BrowserExecutor>,
        sink: Arc<dyn EventSink>,
    ) -> Self {
        Self {
            pty,
            agents,
            supervisor,
            team,
            browser,
            browser_executor,
            sink,
        }
    }
}

impl ControlHandler for RuntimeControlHandler {
    fn handle(
        &self,
        request: &ControlRequest,
        identity: &CallerIdentity,
    ) -> Result<Value, ControlError> {
        match request.method {
            ControlMethod::AgentList => {
                let mut agents = self.agents.list(&self.pty).map_err(runtime_error)?;
                if identity.project_id != "*" {
                    let allowed = self
                        .supervisor
                        .reconnect(SUPERVISOR_PROTOCOL_VERSION, 0)
                        .map_err(session_runtime)?
                        .sessions
                        .into_iter()
                        .filter(|session| session.project_id == identity.project_id)
                        .map(|session| session.agent_id)
                        .collect::<HashSet<_>>();
                    agents.retain(|agent| allowed.contains(&agent.id));
                }
                serde_json::to_value(agents).map_err(serialization_error)
            }
            ControlMethod::AgentQueueStatus => {
                let requested_project_id = match request.params.get("projectId") {
                    None | Some(Value::Null) => None,
                    Some(Value::String(value)) if !value.trim().is_empty() => {
                        Some(value.to_owned())
                    }
                    _ => return Err(invalid_params("agent.queue_status projectId")),
                };
                let project_id = requested_project_id
                    .or_else(|| (identity.project_id != "*").then(|| identity.project_id.clone()));
                serde_json::to_value(self.team.queue_status(project_id.as_deref())?)
                    .map_err(serialization_error)
            }
            ControlMethod::WorktreeAudit => {
                let requested_project_id = match request.params.get("projectId") {
                    None | Some(Value::Null) => None,
                    Some(Value::String(value)) if !value.trim().is_empty() => {
                        Some(value.to_owned())
                    }
                    _ => return Err(invalid_params("worktree.audit projectId")),
                };
                let project_id = requested_project_id
                    .or_else(|| (identity.project_id != "*").then(|| identity.project_id.clone()))
                    .ok_or_else(|| invalid_params("worktree.audit projectId"))?;
                if identity.project_id != "*" && identity.project_id != project_id {
                    return Err(ControlError::new(
                        ControlErrorCode::CapabilityDenied,
                        "Caller cannot access another project's worktree",
                    ));
                }
                let audit = crate::git::worktree::audit_worktrees(&project_id).map_err(|error| {
                    ControlError::new(
                        ControlErrorCode::ControlRuntimeError,
                        format!("worktree audit failed: {error}"),
                    )
                })?;
                serde_json::to_value(audit).map_err(serialization_error)
            }
            ControlMethod::SessionList => {
                let mut sessions = self
                    .supervisor
                    .reconnect(SUPERVISOR_PROTOCOL_VERSION, 0)
                    .map_err(session_runtime)?
                    .sessions;
                if identity.project_id != "*" {
                    sessions.retain(|session| session.project_id == identity.project_id);
                }
                serde_json::to_value(sessions).map_err(serialization_error)
            }
            ControlMethod::SessionReconcile => {
                let project_id =
                    (identity.project_id != "*").then_some(identity.project_id.as_str());
                serde_json::to_value(
                    self.supervisor
                        .reconcile_project(project_id)
                        .map_err(session_runtime)?,
                )
                .map_err(serialization_error)
            }
            ControlMethod::WorkspaceList => Ok(json!([])),
            ControlMethod::AttentionList => {
                let events = self
                    .supervisor
                    .reconnect(SUPERVISOR_PROTOCOL_VERSION, 0)
                    .map_err(session_runtime)?
                    .events;
                let mut states = HashMap::<(String, String), AttentionState>::new();
                for event in events {
                    let Some(agent_id) = event.agent_id.clone() else {
                        continue;
                    };
                    if identity.project_id != "*" && event.project_id != identity.project_id {
                        continue;
                    }
                    let key = (event.project_id.clone(), agent_id);
                    let previous = states.get(&key).cloned().unwrap_or_default();
                    states.insert(key, AttentionReducer::apply(&previous, &event));
                }
                Ok(Value::Array(
                    states
                        .into_iter()
                        .map(|((project_id, agent_id), state)| {
                            json!({ "projectId": project_id, "agentId": agent_id, "state": state })
                        })
                        .collect(),
                ))
            }
            ControlMethod::AttentionAck => {
                let project_id = request
                    .params
                    .get("projectId")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .map(str::to_owned)
                    .or_else(|| (identity.project_id != "*").then(|| identity.project_id.clone()))
                    .ok_or_else(|| invalid_params("attention.ack projectId"))?;
                let agent_id = param(&request.params, "agentId")?;
                publish_runtime_attention_ack(self.sink.as_ref(), identity, &project_id, agent_id)?;
                Ok(json!({ "projectId": project_id, "agentId": agent_id, "acknowledged": true }))
            }
            ControlMethod::AgentSpawn => {
                let mut spawn: SpawnAgentRequest = serde_json::from_value(request.params.clone())
                    .map_err(|_| invalid_params("agent.spawn"))?;
                apply_spawn_scope(&mut spawn, identity)?;
                serde_json::to_value(self.team.spawn(spawn)?).map_err(serialization_error)
            }
            ControlMethod::AgentSend => {
                let agent_id = param(&request.params, "agentId")?;
                let body = param(&request.params, "body")?;
                self.team.send(&identity.project_id, agent_id, body)
            }
            ControlMethod::AgentRead => self
                .team
                .read(&identity.project_id, param(&request.params, "agentId")?),
            ControlMethod::AgentFocus => self
                .team
                .focus(&identity.project_id, param(&request.params, "agentId")?),
            ControlMethod::AgentPause => self
                .team
                .pause(&identity.project_id, param(&request.params, "agentId")?),
            ControlMethod::AgentStop => self
                .team
                .stop(&identity.project_id, param(&request.params, "agentId")?),
            ControlMethod::SessionResume => {
                let session_id = param(&request.params, "sessionId")?;
                let (existing, _) = self
                    .supervisor
                    .read_session(session_id)
                    .map_err(session_runtime)?;
                if identity.project_id != "*" && existing.project_id != identity.project_id {
                    return Err(ControlError::new(
                        ControlErrorCode::CapabilityDenied,
                        "Caller cannot resume another project's session",
                    ));
                }
                let descriptor = self
                    .supervisor
                    .resume(session_id, self.sink.clone())
                    .map_err(session_runtime)?;
                serde_json::to_value(descriptor).map_err(serialization_error)
            }
            ControlMethod::TaxChatSend => {
                let project_id = request
                    .params
                    .get("projectId")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .map(str::to_owned)
                    .or_else(|| (identity.project_id != "*").then(|| identity.project_id.clone()))
                    .ok_or_else(|| invalid_params("taxchat.send projectId"))?;
                if identity.project_id != "*" && identity.project_id != project_id {
                    return Err(ControlError::new(
                        ControlErrorCode::CapabilityDenied,
                        "Caller cannot send TaxChat messages to another project",
                    ));
                }
                let mut recipient_ids = string_array(&request.params, "recipientIds")?;
                if recipient_ids.is_empty() {
                    recipient_ids = self
                        .supervisor
                        .reconnect(SUPERVISOR_PROTOCOL_VERSION, 0)
                        .map_err(session_runtime)?
                        .sessions
                        .into_iter()
                        .filter(|session| session.project_id == project_id)
                        .map(|session| session.agent_id)
                        .collect();
                }
                self.team.send_taxchat(
                    &project_id,
                    identity.agent_id.as_deref(),
                    param(&request.params, "body")?,
                    &recipient_ids,
                )
            }
            ControlMethod::BrowserList => {
                serde_json::to_value(self.browser.list(identity)).map_err(serialization_error)
            }
            ControlMethod::BrowserOpen => {
                let project_id = request
                    .params
                    .get("projectId")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .map(str::to_owned)
                    .or_else(|| (identity.project_id != "*").then(|| identity.project_id.clone()))
                    .ok_or_else(|| invalid_params("browser.open projectId"))?;
                let url = param(&request.params, "url")?.to_owned();
                BrowserCommand::decode(json!({ "kind": "open", "url": url }))?;
                self.browser.authorize_project(
                    identity,
                    &project_id,
                    BrowserCapability::Control,
                )?;
                if let Some(surface) = self
                    .browser
                    .list(identity)
                    .into_iter()
                    .find(|surface| surface.project_id == project_id && surface.url == url)
                {
                    return serde_json::to_value(surface).map_err(serialization_error);
                }
                self.browser_executor.request_open(&project_id, &url)?;
                let started = Instant::now();
                let timeout = Duration::from_millis(request.timeout_ms);
                loop {
                    if let Some(surface) = self
                        .browser
                        .list(identity)
                        .into_iter()
                        .find(|surface| surface.project_id == project_id && surface.url == url)
                    {
                        return serde_json::to_value(surface).map_err(serialization_error);
                    }
                    if started.elapsed() >= timeout {
                        return Err(ControlError::new(
                            ControlErrorCode::BrowserCommandTimeout,
                            "Browser pane did not open before the deadline",
                        ));
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
            ControlMethod::BrowserNavigate
            | ControlMethod::BrowserWait
            | ControlMethod::BrowserSnapshot
            | ControlMethod::BrowserClick
            | ControlMethod::BrowserFill
            | ControlMethod::BrowserPress
            | ControlMethod::BrowserEval
            | ControlMethod::BrowserConsole
            | ControlMethod::BrowserErrors
            | ControlMethod::BrowserScreenshot => {
                let command = decode_browser_command(request.method, request.params.clone())?;
                let surface_id = command.surface_id().ok_or_else(|| {
                    ControlError::new(
                        ControlErrorCode::BrowserInvalidCommand,
                        "Browser surface is required",
                    )
                })?;
                let label = self.browser.webview_label(surface_id)?;
                let executor = self.browser_executor.clone();
                let timeout = Duration::from_millis(request.timeout_ms);
                let result = self.browser.dispatch(
                    identity,
                    command,
                    request.timeout_ms,
                    move |_, command| executor.execute(&label, command, timeout),
                )?;
                if let BrowserResult::Navigation {
                    surface_id, url, ..
                } = &result
                {
                    self.browser.update_navigation(surface_id, url.clone())?;
                }
                serde_json::to_value(result).map_err(serialization_error)
            }
            ControlMethod::WorkspaceOpen => Err(ControlError::new(
                ControlErrorCode::MethodNotImplemented,
                "Workspace opening is reserved for a future control API version",
            )),
        }
    }
}

pub(super) fn publish_runtime_attention_ack(
    sink: &dyn EventSink,
    identity: &CallerIdentity,
    project_id: &str,
    agent_id: &str,
) -> Result<(), ControlError> {
    if identity.project_id != "*" && identity.project_id != project_id {
        return Err(ControlError::new(
            ControlErrorCode::CapabilityDenied,
            "Caller cannot acknowledge another project's attention",
        ));
    }
    let mut event = super::AgentEventEnvelope::new(
        Uuid::new_v4().to_string(),
        project_id.to_owned(),
        Some(agent_id.to_owned()),
        super::AgentEventKind::AttentionAck,
        super::AgentEventPayload::Empty,
    );
    event.source = super::AgentEventSource::Api;
    sink.emit_control(event);
    Ok(())
}

fn decode_browser_command(
    method: ControlMethod,
    params: Value,
) -> Result<BrowserCommand, ControlError> {
    let kind = match method {
        ControlMethod::BrowserNavigate => "navigate",
        ControlMethod::BrowserWait => "wait",
        ControlMethod::BrowserSnapshot => "snapshot",
        ControlMethod::BrowserClick => "click",
        ControlMethod::BrowserFill => "fill",
        ControlMethod::BrowserPress => "press",
        ControlMethod::BrowserEval => "eval",
        ControlMethod::BrowserConsole => "console",
        ControlMethod::BrowserErrors => "errors",
        ControlMethod::BrowserScreenshot => "screenshot",
        _ => {
            return Err(ControlError::new(
                ControlErrorCode::BrowserInvalidCommand,
                "Control method is not a surface browser command",
            ))
        }
    };
    let mut object = params.as_object().cloned().ok_or_else(|| {
        ControlError::new(
            ControlErrorCode::BrowserInvalidCommand,
            "Browser command parameters must be an object",
        )
    })?;
    object.insert("kind".into(), Value::String(kind.into()));
    BrowserCommand::decode(Value::Object(object))
}

pub struct ControlService {
    router: Arc<CommandRouter>,
    ui_identity: CallerIdentity,
}

impl ControlService {
    pub fn new(router: Arc<CommandRouter>) -> Self {
        Self {
            router,
            ui_identity: CallerIdentity {
                caller_id: "zli-ui".into(),
                project_id: "*".into(),
                agent_id: None,
                parent_agent_id: None,
                capabilities: all_capabilities(),
                expires_at: None,
            },
        }
    }

    pub fn dispatch(&self, request: ControlRequest) -> ControlResponse {
        self.router.dispatch(request, self.ui_identity.clone())
    }
}

pub fn local_cli_identity() -> CallerIdentity {
    CallerIdentity {
        caller_id: "zli-cli".into(),
        project_id: "*".into(),
        agent_id: None,
        parent_agent_id: None,
        capabilities: all_capabilities(),
        expires_at: None,
    }
}

fn all_capabilities() -> Vec<Capability> {
    vec![
        Capability::WorkspaceList,
        Capability::WorkspaceOpen,
        Capability::AgentList,
        Capability::AgentSpawn,
        Capability::AgentSend,
        Capability::AgentRead,
        Capability::AgentFocus,
        Capability::AgentPause,
        Capability::AgentStop,
        Capability::AttentionRead,
        Capability::AttentionAck,
        Capability::SessionRead,
        Capability::SessionReconcile,
        Capability::SessionResume,
        Capability::BrowserRead,
        Capability::BrowserControl,
        Capability::BrowserJavascript,
        Capability::BrowserStorage,
        Capability::BrowserDownload,
        Capability::TaxChatSend,
        Capability::WorktreeRead,
        Capability::WorktreeDiscard,
        Capability::CommandExecute,
    ]
}

fn runtime_error(error: crate::error::BackendError) -> ControlError {
    ControlError::new(ControlErrorCode::ControlRuntimeError, error.to_string())
}

fn session_runtime(error: super::SessionCommandError) -> ControlError {
    ControlError::new(
        ControlErrorCode::ControlRuntimeError,
        format!("session operation failed: {error:?}"),
    )
}

fn serialization_error(error: serde_json::Error) -> ControlError {
    ControlError::new(ControlErrorCode::ControlRuntimeError, error.to_string())
}

fn param<'a>(params: &'a Value, key: &str) -> Result<&'a str, ControlError> {
    params
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| invalid_params(key))
}

fn string_array(params: &Value, key: &str) -> Result<Vec<String>, ControlError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(values)) => values
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .filter(|value| !value.trim().is_empty())
                    .map(str::to_owned)
                    .ok_or_else(|| invalid_params(key))
            })
            .collect(),
        _ => Err(invalid_params(key)),
    }
}

pub(crate) fn apply_spawn_scope(
    request: &mut SpawnAgentRequest,
    identity: &CallerIdentity,
) -> Result<(), ControlError> {
    if request.project_id.is_empty() && identity.project_id != "*" {
        request.project_id.clone_from(&identity.project_id);
    }
    if let Some(agent_id) = identity.agent_id.as_deref() {
        match request.parent_agent_id.as_deref() {
            Some(parent_agent_id) if parent_agent_id == agent_id => {}
            None => request.parent_agent_id = Some(agent_id.to_owned()),
            Some(_) => {
                return Err(ControlError::new(
                    ControlErrorCode::CapabilityDenied,
                    "Child agents may spawn only under their own identity",
                ));
            }
        }
    }
    Ok(())
}

fn invalid_params(method: &str) -> ControlError {
    ControlError::new(
        ControlErrorCode::InvalidControlRequest,
        format!("Invalid parameters for {method}"),
    )
}
