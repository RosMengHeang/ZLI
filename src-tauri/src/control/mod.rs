pub mod attention;
mod events;
mod persistence;
pub(crate) mod prompt_detector;
mod reconcile;
mod runtime;
mod session;
mod supervisor;

pub use events::{
    AgentEventEnvelope, AgentEventKind, AgentEventPayload, AgentEventSource, AttentionStatus,
    ExecutionStatus,
};
pub use persistence::{ProjectSnapshot, SnapshotStore, SnapshotStoreError};
pub use reconcile::ReconcileReport;
pub use runtime::{SessionCheckpoint, SessionManager};
pub use session::{RuntimeSession, SessionDescriptor, SessionRegistry};
pub use supervisor::{
    ReconnectResult, RestoreResult, SessionCommandError, Supervisor, SUPERVISOR_PROTOCOL_VERSION,
};

#[cfg(test)]
mod tests;
