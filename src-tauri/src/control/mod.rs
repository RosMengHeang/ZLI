pub mod attention;
pub mod browser;
mod delivery_desk;
mod events;
mod mcp_stdio;
mod provider_tools;
pub(crate) mod event_log;
mod managed_agent_context;
mod ownership;
pub(crate) mod persistence;
pub(crate) mod prompt_detector;
pub(crate) mod utf8_stream;
mod protocol;
mod reconcile;
mod router;
mod runtime;
mod security;
mod service;
mod session;
mod supervisor;
mod team;
mod transport;

pub use browser::{
    clean_profile_data_dir, instrumentation_script, BrowserControlSettingsStore,
    BrowserControlStatus, BrowserExecutor, BrowserManager, BrowserSurfaceRecord,
    TauriBrowserExecutor, CLEAN_PROFILE_ID,
};
pub use browser::gateway::tool_names as gateway_tools;
pub use mcp_stdio::{
    dispatch, handle as handle_mcp, json_rpc_error, negotiate_version, parse_incoming, Dispatch,
    Incoming, DEFAULT_MCP_PROTOCOL_VERSION, SUPPORTED_MCP_PROTOCOL_VERSIONS,
};
pub use provider_tools::{
    help_contains, merge_reserved_server, overlay_dir, recipe_for, write_claude_mcp_json,
    write_shell_fallback_txt, BindError, BindEvidence, BindRequest, ProjectMcpFormat,
    ProviderTools, ToolBindContext, ToolBinding, ToolRecipe, ZLI_MCP_SERVER_ID,
};
pub use events::{
    AgentEventEnvelope, AgentEventKind, AgentEventPayload, AgentEventSource, AttentionStatus,
    ExecutionStatus,
};
pub use persistence::{ProjectSnapshot, SnapshotStore, SnapshotStoreError};
pub use ownership::{
    OwnershipLedger, OwnershipLedgerError, RuntimeOwnershipRecord, OWNERSHIP_SCHEMA_VERSION,
};
pub use managed_agent_context::{
    install_directory, ControlEndpoint, LaunchIntent, ManagedAgentContext, ManagedAgentIdentity,
    ManagedContextError, ManagedEnvironment, ManagedLaunch, SidecarPaths,
};
pub use protocol::{
    CallerIdentity, Capability, ControlError, ControlErrorCode, ControlMethod, ControlRequest,
    ControlResponse, CONTROL_FRAME_ENVELOPE_OVERHEAD, CONTROL_PROTOCOL_VERSION,
    MAX_CONTROL_FRAME_BYTES,
};
pub use reconcile::ReconcileReport;
pub use router::{CommandRouter, ControlHandler};
pub use runtime::{SessionCheckpoint, SessionManager};
pub use security::{CapabilityTokenStore, CredentialHandle, IssuedCapabilityToken};
pub use service::{local_cli_identity, ControlService, RuntimeControlHandler};
pub use session::{RuntimeSession, SessionDescriptor, SessionRegistry};
pub use supervisor::{
    ReconnectResult, RestoreResult, SessionCommandError, Supervisor, SUPERVISOR_PROTOCOL_VERSION,
};
pub use delivery_desk::{PullReceipt, ReadinessView};
pub use team::{
    AgentQueueStatus, BrowserAgentCapability, RuntimeTeamBackend, SpawnAgentRequest, TeamAgent,
    TeamBackend, TeamCoordinator,
};
#[cfg(windows)]
pub use transport::named_pipe::{NamedPipeClient, NamedPipeServer};
pub use transport::{ControlTransport, TransportHandle};

#[cfg(test)]
mod tests;
