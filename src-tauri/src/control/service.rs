use super::{
    CallerIdentity, Capability, CommandRouter, ControlError, ControlErrorCode, ControlHandler,
    ControlMethod, ControlRequest, ControlResponse, Supervisor, SUPERVISOR_PROTOCOL_VERSION,
};
use crate::agents::AgentManager;
use crate::pty::PtyManager;
use serde_json::{json, Value};
use std::sync::Arc;

pub struct RuntimeControlHandler {
    pty: PtyManager,
    agents: AgentManager,
    supervisor: Arc<Supervisor>,
}

impl RuntimeControlHandler {
    pub fn new(pty: PtyManager, agents: AgentManager, supervisor: Arc<Supervisor>) -> Self {
        Self {
            pty,
            agents,
            supervisor,
        }
    }
}

impl ControlHandler for RuntimeControlHandler {
    fn handle(
        &self,
        request: &ControlRequest,
        _identity: &CallerIdentity,
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
