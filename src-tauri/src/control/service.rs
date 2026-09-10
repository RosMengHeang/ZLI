use super::{
    CallerIdentity, Capability, CommandRouter, ControlError, ControlErrorCode, ControlHandler,
    ControlMethod, ControlRequest, ControlResponse, SpawnAgentRequest, Supervisor, TeamCoordinator,
    SUPERVISOR_PROTOCOL_VERSION,
};
use crate::agents::AgentManager;
use crate::pty::PtyManager;
use serde_json::{json, Value};
use std::sync::Arc;

pub struct RuntimeControlHandler {
    pty: PtyManager,
    agents: AgentManager,
    supervisor: Arc<Supervisor>,
    team: Arc<TeamCoordinator>,
}

impl RuntimeControlHandler {
    pub fn new(
        pty: PtyManager,
        agents: AgentManager,
        supervisor: Arc<Supervisor>,
        team: Arc<TeamCoordinator>,
    ) -> Self {
        Self {
            pty,
            agents,
            supervisor,
            team,
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
                serde_json::to_value(self.agents.list(&self.pty).map_err(runtime_error)?)
                    .map_err(serialization_error)
            }
            ControlMethod::SessionList => serde_json::to_value(
                self.supervisor
                    .reconnect(SUPERVISOR_PROTOCOL_VERSION, 0)
                    .map_err(|error| {
                        ControlError::new(
                            ControlErrorCode::ControlRuntimeError,
                            format!("session list failed: {error:?}"),
                        )
                    })?
                    .sessions,
            )
            .map_err(serialization_error),
            ControlMethod::WorkspaceList => Ok(json!([])),
            ControlMethod::AgentSpawn => {
                let mut spawn: SpawnAgentRequest = serde_json::from_value(request.params.clone())
                    .map_err(|_| invalid_params("agent.spawn"))?;
                if spawn.project_id.is_empty() && identity.project_id != "*" {
                    spawn.project_id.clone_from(&identity.project_id);
                }
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
            _ => Err(ControlError::new(
                ControlErrorCode::MethodNotImplemented,
                "Control method is not implemented yet",
            )),
        }
    }
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
        Capability::SessionResume,
        Capability::BrowserRead,
        Capability::BrowserControl,
        Capability::BrowserJavascript,
        Capability::BrowserStorage,
        Capability::BrowserDownload,
        Capability::TaxChatSend,
        Capability::WorktreeDiscard,
        Capability::CommandExecute,
    ]
}

fn runtime_error(error: crate::error::BackendError) -> ControlError {
    ControlError::new(ControlErrorCode::ControlRuntimeError, error.to_string())
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

fn invalid_params(method: &str) -> ControlError {
    ControlError::new(
        ControlErrorCode::InvalidControlRequest,
        format!("Invalid parameters for {method}"),
    )
}
