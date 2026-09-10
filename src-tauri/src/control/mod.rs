pub mod attention;
mod events;
mod persistence;
mod protocol;
mod router;
mod security;
pub(crate) mod prompt_detector;
mod reconcile;
mod runtime;
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
pub use router::{CommandRouter, ControlHandler};
pub use security::{CapabilityTokenStore, IssuedCapabilityToken};
pub use reconcile::ReconcileReport;
pub use runtime::{SessionCheckpoint, SessionManager};
pub use session::{RuntimeSession, SessionDescriptor, SessionRegistry};
pub use supervisor::{
    ReconnectResult, RestoreResult, SessionCommandError, Supervisor, SUPERVISOR_PROTOCOL_VERSION,
};
pub use transport::{ControlTransport, TransportHandle};
#[cfg(windows)]
pub use transport::named_pipe::{NamedPipeClient, NamedPipeServer};

#[cfg(test)]
mod tests;
