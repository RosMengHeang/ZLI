pub mod attention;
mod events;
mod persistence;
pub(crate) mod prompt_detector;
mod runtime;
mod session;

pub use events::{
    AgentEventEnvelope, AgentEventKind, AgentEventPayload, AgentEventSource, AttentionStatus,
    ExecutionStatus,
};
pub use persistence::{ProjectSnapshot, SnapshotStore, SnapshotStoreError};
pub use runtime::{SessionCheckpoint, SessionManager};
pub use session::{RuntimeSession, SessionDescriptor, SessionRegistry};

#[cfg(test)]
mod tests;
