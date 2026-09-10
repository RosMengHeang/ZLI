pub mod attention;
mod events;
mod persistence;
pub(crate) mod prompt_detector;
mod protocol;
mod reconcile;
mod router;
mod runtime;
mod security;
mod service;
mod session;
mod supervisor;
mod transport;

pub use events::{
    AgentEventEnvelope, AgentEventKind, AgentEventPayload, AgentEventSource, AttentionStatus,
    ExecutionStatus,
};
pub use persistence::{ProjectSnapshot, SnapshotStore, SnapshotStoreError};
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
#[cfg(windows)]
pub use transport::named_pipe::{NamedPipeClient, NamedPipeServer};
pub use transport::{ControlTransport, TransportHandle};

#[cfg(test)]
mod tests;
