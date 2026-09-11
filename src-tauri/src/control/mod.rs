pub mod attention;
pub mod browser;
mod events;
pub(crate) mod event_log;
mod ownership;
pub(crate) mod persistence;
pub(crate) mod prompt_detector;
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
    BrowserControlSettingsStore, BrowserControlStatus, BrowserExecutor, BrowserManager,
    BrowserSurfaceRecord, TauriBrowserExecutor,
};
pub use browser::gateway::tool_names as gateway_tools;
pub use events::{
    AgentEventEnvelope, AgentEventKind, AgentEventPayload, AgentEventSource, AttentionStatus,
    ExecutionStatus,
};
pub use persistence::{ProjectSnapshot, SnapshotStore, SnapshotStoreError};
pub use ownership::{
    OwnershipLedger, OwnershipLedgerError, RuntimeOwnershipRecord, OWNERSHIP_SCHEMA_VERSION,
};
pub use protocol::{
    CallerIdentity, Capability, ControlError, ControlErrorCode, ControlMethod, ControlRequest,
    ControlResponse, CONTROL_PROTOCOL_VERSION,
};
pub use reconcile::ReconcileReport;
pub use router::{CommandRouter, ControlHandler};
pub use runtime::{SessionCheckpoint, SessionManager};
pub use security::{CapabilityTokenStore, IssuedCapabilityToken};
pub use service::{local_cli_identity, ControlService, RuntimeControlHandler};
pub use session::{RuntimeSession, SessionDescriptor, SessionRegistry};
pub use supervisor::{
    ReconnectResult, RestoreResult, SessionCommandError, Supervisor, SUPERVISOR_PROTOCOL_VERSION,
};
pub use team::{
    zli_executable_path, AgentQueueStatus, BrowserAgentCapability, RuntimeTeamBackend,
    SpawnAgentRequest, TeamAgent, TeamBackend, TeamCoordinator,
};
#[cfg(windows)]
pub use transport::named_pipe::{NamedPipeClient, NamedPipeServer};
pub use transport::{ControlTransport, TransportHandle};

#[cfg(test)]
mod tests;
