use super::{
    AgentEventEnvelope, AgentEventKind, AgentEventPayload, AgentEventSource, AttentionStatus,
    ExecutionStatus,
};
use serde::Serialize;
use serde_json::json;

#[test]
fn event_envelope_round_trips_with_schema_version_and_sequence() {
    let event = AgentEventEnvelope::new(
        "evt-1".into(),
        "project-1".into(),
        Some("agent-1".into()),
        AgentEventKind::AgentStarted,
        AgentEventPayload::Empty,
    );
    let json = serde_json::to_string(&event).expect("serialize event");
    let decoded: AgentEventEnvelope = serde_json::from_str(&json).expect("deserialize event");
    assert_eq!(decoded.schema_version, 1);
    assert_eq!(decoded.sequence, 0);
    assert_eq!(decoded.event_id, "evt-1");
}

#[test]
fn event_envelope_serializes_with_frontend_field_names() {
    let event = AgentEventEnvelope::new(
        "evt-1".into(),
        "project-1".into(),
        Some("agent-1".into()),
        AgentEventKind::AgentStarted,
        AgentEventPayload::Empty,
    );
    let timestamp = event.timestamp.clone();

    assert_eq!(
        serde_json::to_value(event).expect("serialize event"),
        json!({
            "schemaVersion": 1,
            "sequence": 0,
            "eventId": "evt-1",
            "projectId": "project-1",
            "agentId": "agent-1",
            "parentAgentId": null,
            "timestamp": timestamp,
            "source": "runtime",
            "kind": "agent_started",
            "payload": { "type": "empty" },
        })
    );
}

#[test]
fn contract_enums_serialize_with_snake_case_wire_values() {
    assert_wire_values([
        (AgentEventKind::AgentCreated, "agent_created"),
        (AgentEventKind::AgentStarted, "agent_started"),
        (AgentEventKind::AgentOutput, "agent_output"),
        (AgentEventKind::AgentPromptDetected, "agent_prompt_detected"),
        (AgentEventKind::AgentWaiting, "agent_waiting"),
        (
            AgentEventKind::AgentMessageReceived,
            "agent_message_received",
        ),
        (
            AgentEventKind::AgentMessageDelivered,
            "agent_message_delivered",
        ),
        (AgentEventKind::AgentCompleted, "agent_completed"),
        (AgentEventKind::AgentFailed, "agent_failed"),
        (AgentEventKind::AgentPaused, "agent_paused"),
        (AgentEventKind::AgentStopped, "agent_stopped"),
        (AgentEventKind::AgentExited, "agent_exited"),
        (
            AgentEventKind::AgentResumeAvailable,
            "agent_resume_available",
        ),
        (
            AgentEventKind::AgentResumeUnavailable,
            "agent_resume_unavailable",
        ),
        (
            AgentEventKind::AgentWorktreeCreated,
            "agent_worktree_created",
        ),
        (
            AgentEventKind::AgentWorktreeCleanupFailed,
            "agent_worktree_cleanup_failed",
        ),
        (
            AgentEventKind::BrowserSurfaceCreated,
            "browser_surface_created",
        ),
        (
            AgentEventKind::BrowserNavigationChanged,
            "browser_navigation_changed",
        ),
        (AgentEventKind::BrowserConsoleError, "browser_console_error"),
        (
            AgentEventKind::BrowserCommandFailed,
            "browser_command_failed",
        ),
        (AgentEventKind::TaxchatRoomStarted, "taxchat_room_started"),
        (AgentEventKind::TaxchatMessageSent, "taxchat_message_sent"),
        (
            AgentEventKind::TaxchatMessageFailed,
            "taxchat_message_failed",
        ),
        (AgentEventKind::AttentionAck, "attention_ack"),
        (
            AgentEventKind::AttentionMarkAllRead,
            "attention_mark_all_read",
        ),
    ]);
    assert_wire_values([
        (AgentEventSource::Runtime, "runtime"),
        (AgentEventSource::Provider, "provider"),
        (AgentEventSource::Pty, "pty"),
        (AgentEventSource::Taxchat, "taxchat"),
        (AgentEventSource::Browser, "browser"),
        (AgentEventSource::User, "user"),
        (AgentEventSource::Api, "api"),
    ]);
    assert_wire_values([
        (ExecutionStatus::Starting, "starting"),
        (ExecutionStatus::Running, "running"),
        (ExecutionStatus::Paused, "paused"),
        (ExecutionStatus::Exited, "exited"),
        (ExecutionStatus::Error, "error"),
        (ExecutionStatus::Stopped, "stopped"),
    ]);
    assert_wire_values([
        (AttentionStatus::Working, "working"),
        (AttentionStatus::WaitingForYou, "waiting_for_you"),
        (AttentionStatus::Completed, "completed"),
        (AttentionStatus::Failed, "failed"),
        (AttentionStatus::Paused, "paused"),
        (AttentionStatus::Offline, "offline"),
    ]);
}

#[test]
fn event_payload_variants_serialize_with_tagged_frontend_shapes() {
    let cases = [
        (AgentEventPayload::Empty, json!({ "type": "empty" })),
        (
            AgentEventPayload::Text {
                text: "hello".into(),
            },
            json!({ "type": "text", "text": "hello" }),
        ),
        (
            AgentEventPayload::Exit { code: Some(7) },
            json!({ "type": "exit", "code": 7 }),
        ),
        (
            AgentEventPayload::Attention {
                reason: "approval needed".into(),
            },
            json!({ "type": "attention", "reason": "approval needed" }),
        ),
        (
            AgentEventPayload::Message {
                message_id: "message-1".into(),
            },
            json!({ "type": "message", "messageId": "message-1" }),
        ),
    ];

    for (payload, expected) in cases {
        assert_eq!(
            serde_json::to_value(payload).expect("serialize payload"),
            expected
        );
    }
}

fn assert_wire_values<T, const N: usize>(cases: [(T, &str); N])
where
    T: Serialize,
{
    for (value, expected) in cases {
        assert_eq!(
            serde_json::to_value(value).expect("serialize enum"),
            json!(expected)
        );
    }
}
