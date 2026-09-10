pub mod attention;
mod events;
pub(crate) mod prompt_detector;

pub use events::{
    AgentEventEnvelope, AgentEventKind, AgentEventPayload, AgentEventSource, AttentionStatus,
    ExecutionStatus,
};

#[cfg(test)]
mod tests;
