use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};

pub const CONTROL_PROTOCOL_VERSION: u16 = 1;
const MIN_TIMEOUT_MS: u64 = 100;
const MAX_TIMEOUT_MS: u64 = 120_000;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Hash, Serialize)]
pub enum ControlMethod {
    #[serde(rename = "workspace.list")]
    WorkspaceList,
    #[serde(rename = "workspace.open")]
    WorkspaceOpen,
    #[serde(rename = "agent.list")]
    AgentList,
    #[serde(rename = "agent.queue_status")]
    AgentQueueStatus,
    #[serde(rename = "agent.spawn")]
    AgentSpawn,
    #[serde(rename = "agent.send")]
    AgentSend,
    #[serde(rename = "agent.pull")]
    AgentPull,
    #[serde(rename = "agent.read")]
    AgentRead,
    #[serde(rename = "agent.focus")]
    AgentFocus,
    #[serde(rename = "agent.pause")]
    AgentPause,
    #[serde(rename = "agent.stop")]
    AgentStop,
    #[serde(rename = "worktree.audit")]
    WorktreeAudit,
    #[serde(rename = "attention.list")]
    AttentionList,
    #[serde(rename = "attention.ack")]
    AttentionAck,
    #[serde(rename = "session.list")]
    SessionList,
    #[serde(rename = "session.reconcile")]
    SessionReconcile,
    #[serde(rename = "session.resume")]
    SessionResume,
    #[serde(rename = "runtime.health")]
    RuntimeHealth,
    #[serde(rename = "browser.list")]
    BrowserList,
    #[serde(rename = "browser.status")]
    BrowserStatus,
    #[serde(rename = "browser.control_status")]
    BrowserControlStatus,
    #[serde(rename = "browser.control_set")]
    BrowserControlSet,
    #[serde(rename = "browser.use")]
    BrowserUse,
    #[serde(rename = "browser.open")]
    BrowserOpen,
    #[serde(rename = "browser.navigate")]
    BrowserNavigate,
    #[serde(rename = "browser.wait")]
    BrowserWait,
    #[serde(rename = "browser.snapshot")]
    BrowserSnapshot,
    #[serde(rename = "browser.click")]
    BrowserClick,
    #[serde(rename = "browser.fill")]
    BrowserFill,
    #[serde(rename = "browser.press")]
    BrowserPress,
    #[serde(rename = "browser.eval")]
    BrowserEval,
    #[serde(rename = "browser.console")]
    BrowserConsole,
    #[serde(rename = "browser.errors")]
    BrowserErrors,
    #[serde(rename = "browser.screenshot")]
    BrowserScreenshot,
    #[serde(rename = "taxchat.send")]
    TaxChatSend,
    #[serde(rename = "provider.capability_report")]
    ProviderCapabilityReport,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Hash, Serialize)]
pub enum Capability {
    #[serde(rename = "workspace.list")]
    WorkspaceList,
    #[serde(rename = "workspace.open")]
    WorkspaceOpen,
    #[serde(rename = "agent.list")]
    AgentList,
    #[serde(rename = "agent.spawn")]
    AgentSpawn,
    #[serde(rename = "agent.send")]
    AgentSend,
    #[serde(rename = "agent.read")]
    AgentRead,
    #[serde(rename = "agent.focus")]
    AgentFocus,
    #[serde(rename = "agent.pause")]
    AgentPause,
    #[serde(rename = "agent.stop")]
    AgentStop,
    #[serde(rename = "attention.read")]
    AttentionRead,
    #[serde(rename = "attention.ack")]
    AttentionAck,
    #[serde(rename = "session.read")]
    SessionRead,
    #[serde(rename = "session.reconcile")]
    SessionReconcile,
    #[serde(rename = "session.resume")]
    SessionResume,
    #[serde(rename = "runtime.read")]
    RuntimeRead,
    #[serde(rename = "browser.read")]
    BrowserRead,
    #[serde(rename = "browser.control")]
    BrowserControl,
    #[serde(rename = "browser.javascript")]
    BrowserJavascript,
    #[serde(rename = "browser.storage")]
    BrowserStorage,
    #[serde(rename = "browser.download")]
    BrowserDownload,
    #[serde(rename = "taxchat.send")]
    TaxChatSend,
    #[serde(rename = "worktree.read")]
    WorktreeRead,
    #[serde(rename = "worktree.discard")]
    WorktreeDiscard,
    #[serde(rename = "command.execute")]
    CommandExecute,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallerIdentity {
    pub caller_id: String,
    pub project_id: String,
    pub agent_id: Option<String>,
    pub parent_agent_id: Option<String>,
    pub capabilities: Vec<Capability>,
    pub expires_at: Option<u64>,
}

impl CallerIdentity {
    pub fn allows(&self, capability: Capability) -> bool {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        self.expires_at.is_none_or(|expires_at| expires_at > now)
            && self.capabilities.contains(&capability)
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlRequest {
    pub id: String,
    pub protocol_version: u16,
    pub method: ControlMethod,
    pub params: Value,
    pub timeout_ms: u64,
}

impl ControlRequest {
    pub fn new(
        id: impl Into<String>,
        method: ControlMethod,
        params: Value,
        timeout_ms: u64,
    ) -> Result<Self, ControlError> {
        let request = Self {
            id: id.into(),
            protocol_version: CONTROL_PROTOCOL_VERSION,
            method,
            params,
            timeout_ms,
        };
        request.validate()?;
        Ok(request)
    }

    pub fn from_json(input: &str) -> Result<Self, ControlError> {
        let value: Value = serde_json::from_str(input)
            .map_err(|_| ControlError::invalid_request("Request is not valid JSON"))?;
        let version = value
            .get("protocolVersion")
            .and_then(Value::as_u64)
            .ok_or_else(|| {
                ControlError::invalid_request("Protocol version must be an unsigned integer")
            })?;
        if version != u64::from(CONTROL_PROTOCOL_VERSION) {
            return Err(ControlError::new(
                ControlErrorCode::ControlProtocolMismatch,
                "Unsupported control protocol version",
            ));
        }
        let request: Self = serde_json::from_value(value)
            .map_err(|_| ControlError::invalid_request("Request envelope is invalid"))?;
        request.validate()?;
        Ok(request)
    }

    pub fn validate(&self) -> Result<(), ControlError> {
        if self.protocol_version != CONTROL_PROTOCOL_VERSION {
            return Err(ControlError::new(
                ControlErrorCode::ControlProtocolMismatch,
                "Unsupported control protocol version",
            ));
        }
        if self.id.trim().is_empty() {
            return Err(ControlError::invalid_request("Request ID is required"));
        }
        if !(MIN_TIMEOUT_MS..=MAX_TIMEOUT_MS).contains(&self.timeout_ms) {
            return Err(ControlError::invalid_request(
                "Request timeout must be between 100 and 120000 milliseconds",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ControlErrorCode {
    InvalidControlRequest,
    ControlProtocolMismatch,
    CapabilityDenied,
    AgentLimitReached,
    AgentInboxFull,
    SessionNotFound,
    WorktreeCreateFailed,
    WorktreeCleanupFailed,
    ProviderNotInstalled,
    ProviderResumeUnsupported,
    ParentAgentNotFound,
    BrowserSurfaceNotFound,
    BrowserSurfaceForbidden,
    BrowserPermissionRequired,
    BrowserCommandTimeout,
    BrowserInvalidCommand,
    BrowserResultTooLarge,
    BrowserControlDisabled,
    ControlTimeout,
    ControlRuntimeError,
    MethodNotImplemented,
}

impl ControlErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidControlRequest => "INVALID_CONTROL_REQUEST",
            Self::ControlProtocolMismatch => "CONTROL_PROTOCOL_MISMATCH",
            Self::CapabilityDenied => "CAPABILITY_DENIED",
            Self::AgentLimitReached => "AGENT_LIMIT_REACHED",
            Self::AgentInboxFull => "AGENT_INBOX_FULL",
            Self::SessionNotFound => "SESSION_NOT_FOUND",
            Self::WorktreeCreateFailed => "WORKTREE_CREATE_FAILED",
            Self::WorktreeCleanupFailed => "WORKTREE_CLEANUP_FAILED",
            Self::ProviderNotInstalled => "PROVIDER_NOT_INSTALLED",
            Self::ProviderResumeUnsupported => "PROVIDER_RESUME_UNSUPPORTED",
            Self::ParentAgentNotFound => "PARENT_AGENT_NOT_FOUND",
            Self::BrowserSurfaceNotFound => "BROWSER_SURFACE_NOT_FOUND",
            Self::BrowserSurfaceForbidden => "BROWSER_SURFACE_FORBIDDEN",
            Self::BrowserPermissionRequired => "BROWSER_PERMISSION_REQUIRED",
            Self::BrowserCommandTimeout => "BROWSER_COMMAND_TIMEOUT",
            Self::BrowserInvalidCommand => "BROWSER_INVALID_COMMAND",
            Self::BrowserResultTooLarge => "BROWSER_RESULT_TOO_LARGE",
            Self::BrowserControlDisabled => "BROWSER_CONTROL_DISABLED",
            Self::ControlTimeout => "CONTROL_TIMEOUT",
            Self::ControlRuntimeError => "CONTROL_RUNTIME_ERROR",
            Self::MethodNotImplemented => "METHOD_NOT_IMPLEMENTED",
        }
    }
}

impl PartialEq<&str> for ControlErrorCode {
    fn eq(&self, other: &&str) -> bool {
        self.as_str() == *other
    }
}

impl std::fmt::Display for ControlErrorCode {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, thiserror::Error)]
#[error("{code}: {message}")]
#[serde(rename_all = "camelCase")]
pub struct ControlError {
    pub code: ControlErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

impl ControlError {
    pub fn new(code: ControlErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            details: None,
        }
    }

    pub fn invalid_request(message: impl Into<String>) -> Self {
        Self::new(ControlErrorCode::InvalidControlRequest, message)
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlResponse {
    pub id: String,
    pub protocol_version: u16,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ControlError>,
}

impl ControlResponse {
    pub fn success(id: impl Into<String>, result: Value) -> Self {
        Self {
            id: id.into(),
            protocol_version: CONTROL_PROTOCOL_VERSION,
            ok: true,
            result: Some(result),
            error: None,
        }
    }

    pub fn failure(id: impl Into<String>, error: ControlError) -> Self {
        Self {
            id: id.into(),
            protocol_version: CONTROL_PROTOCOL_VERSION,
            ok: false,
            result: None,
            error: Some(error),
        }
    }

    pub fn from_json(input: &str) -> Result<Self, ControlError> {
        let response: Self = serde_json::from_str(input)
            .map_err(|_| ControlError::invalid_request("Response envelope is invalid"))?;
        response.validate()?;
        Ok(response)
    }

    pub fn validate(&self) -> Result<(), ControlError> {
        if self.protocol_version != CONTROL_PROTOCOL_VERSION {
            return Err(ControlError::new(
                ControlErrorCode::ControlProtocolMismatch,
                "Unsupported control protocol version",
            ));
        }
        if self.id.trim().is_empty()
            || (self.ok && (self.result.is_none() || self.error.is_some()))
            || (!self.ok && (self.error.is_none() || self.result.is_some()))
        {
            return Err(ControlError::invalid_request(
                "Response envelope is invalid",
            ));
        }
        Ok(())
    }
}
