pub mod attention;
mod events;
mod persistence;
pub(crate) mod prompt_detector;

pub use events::{
    AgentEventEnvelope, AgentEventKind, AgentEventPayload, AgentEventSource, AttentionStatus,
    ExecutionStatus,
};
pub use persistence::{ProjectSnapshot, SnapshotStore, SnapshotStoreError};

#[cfg(test)]
mod tests;
