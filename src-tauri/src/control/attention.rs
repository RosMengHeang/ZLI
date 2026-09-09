use super::{
    AgentEventEnvelope, AgentEventKind, AgentEventPayload, AttentionStatus, ExecutionStatus,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttentionState {
    pub execution_status: ExecutionStatus,
    pub attention_status: AttentionStatus,
    pub unread: bool,
    pub unread_count: u64,
}

impl Default for AttentionState {
    fn default() -> Self {
        Self {
            execution_status: ExecutionStatus::Starting,
            attention_status: AttentionStatus::Working,
            unread: false,
            unread_count: 0,
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttentionNotification {
    pub event_id: String,
    pub project_id: String,
    pub agent_id: Option<String>,
    pub timestamp: String,
    pub attention_status: AttentionStatus,
    pub message: String,
}

pub enum WaitingEvidence {
    GenericOutput { last_output_at: Option<u64> },
    ProviderHook,
    ProcessExit,
    TaxchatDelivery,
    Api,
    ProviderPrompt,
}

// The detector supplies a prompt candidate and monotonic milliseconds, not raw output.
pub fn should_promote_to_waiting(
    state: &AttentionState,
    evidence: &WaitingEvidence,
    now: u64,
) -> bool {
    if state.attention_status != AttentionStatus::Working
        || !matches!(
            state.execution_status,
            ExecutionStatus::Starting | ExecutionStatus::Running
        )
    {
        return false;
    }
    match evidence {
        WaitingEvidence::GenericOutput { last_output_at } => last_output_at
            .and_then(|last| now.checked_sub(last))
            .is_some_and(|elapsed| elapsed >= 5000),
        _ => true,
    }
}

pub struct AttentionReducer;

fn is_terminal_execution(status: &ExecutionStatus) -> bool {
    matches!(
        status,
        ExecutionStatus::Error | ExecutionStatus::Exited | ExecutionStatus::Stopped
    )
}

impl AttentionReducer {
    // Envelopes must be validated, ordered, and deduplicated by the caller.
    pub fn apply(state: &AttentionState, event: &AgentEventEnvelope) -> AttentionState {
        let mut next = state.clone();
        match event.kind {
            AgentEventKind::AttentionAck | AgentEventKind::AttentionMarkAllRead => {
                next.unread = false;
                next.unread_count = 0;
                return next;
            }
            AgentEventKind::AgentStarted => {}
            _ if is_terminal_execution(&state.execution_status) => return next,
            _ => {}
        }
        match event.kind {
            AgentEventKind::AgentStarted => {
                next.execution_status = ExecutionStatus::Running;
                next.attention_status = AttentionStatus::Working;
            }
            AgentEventKind::AgentPromptDetected | AgentEventKind::AgentWaiting => {
                next.attention_status = AttentionStatus::WaitingForYou;
            }
            AgentEventKind::AgentCompleted => next.attention_status = AttentionStatus::Completed,
            AgentEventKind::AgentFailed => {
                next.execution_status = ExecutionStatus::Error;
                next.attention_status = AttentionStatus::Failed;
            }
            AgentEventKind::AgentPaused => {
                next.execution_status = ExecutionStatus::Paused;
                next.attention_status = AttentionStatus::Paused;
            }
            AgentEventKind::AgentStopped => {
                next.execution_status = ExecutionStatus::Stopped;
                next.attention_status = AttentionStatus::Offline;
            }
            AgentEventKind::AgentExited => {
                if state.execution_status == ExecutionStatus::Stopped {
                    return next;
                }
                next.execution_status = ExecutionStatus::Exited;
                let code = match event.payload {
                    AgentEventPayload::Exit { code } => code,
                    _ => None,
                };
                if code.is_some_and(|code| code != 0) {
                    next.attention_status = AttentionStatus::Failed;
                } else if !matches!(
                    state.attention_status,
                    AttentionStatus::Completed | AttentionStatus::Failed
                ) {
                    next.attention_status = if code == Some(0) {
                        AttentionStatus::Completed
                    } else {
                        AttentionStatus::Offline
                    };
                }
            }
            _ => return next,
        }
        if next.attention_status != state.attention_status
            && notification_message(&next.attention_status).is_some()
        {
            next.unread = true;
            next.unread_count = state
                .unread_count
                .saturating_add(1)
                .min(9_007_199_254_740_991);
        }
        next
    }
}

fn notification_message(status: &AttentionStatus) -> Option<&'static str> {
    match status {
        AttentionStatus::WaitingForYou => Some("Agent is waiting for your input."),
        AttentionStatus::Completed => Some("Agent completed its task."),
        AttentionStatus::Failed => Some("Agent failed. Check its terminal for details."),
        _ => None,
    }
}

// Pass the state before applying this event. Payload text is never copied into notifications.
pub fn derive_notification(
    event: &AgentEventEnvelope,
    state: &AttentionState,
) -> Option<AttentionNotification> {
    let next = AttentionReducer::apply(state, event);
    if next.attention_status == state.attention_status {
        return None;
    }
    let message = notification_message(&next.attention_status)?;
    Some(AttentionNotification {
        event_id: event.event_id.clone(),
        project_id: event.project_id.clone(),
        agent_id: event.agent_id.clone(),
        timestamp: event.timestamp.clone(),
        attention_status: next.attention_status,
        message: message.into(),
    })
}
