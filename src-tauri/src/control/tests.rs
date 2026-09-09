use super::{
    AgentEventEnvelope, AgentEventKind, AgentEventPayload, AgentEventSource, AttentionStatus,
    ExecutionStatus,
};
use crate::commands::{control_events_after_from_hub, forward_control_event};
use crate::event_hub::EventHub;
use crate::pty::{
    MemoryEventSink, PtyManager, TerminalOutputEvent, TerminalStatus, TerminalStatusEvent,
};
use serde::Serialize;
use serde_json::json;
use std::time::{Duration, Instant};
use tempfile::tempdir;

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

#[test]
fn event_hub_assigns_monotonic_sequence_and_replays_after_cursor() {
    let hub = EventHub::new(32);
    let first = hub.publish(test_event("one")).expect("publish one");
    let second = hub.publish(test_event("two")).expect("publish two");

    assert_eq!(first.sequence, 1);
    assert_eq!(second.sequence, 2);
    assert_eq!(hub.latest_sequence(), 2);
    let replay = hub.subscribe_after(1);
    assert_eq!(replay.len(), 1);
    assert_eq!(replay[0].event_id, "two");
}

#[test]
fn event_hub_does_not_duplicate_event_ids() {
    let hub = EventHub::new(32);
    let first = hub.publish(test_event("same")).expect("publish event");
    let duplicate = hub.publish(test_event("same"));

    assert_eq!(hub.len(), 1);
    assert_eq!(hub.latest_sequence(), 1);
    assert!(duplicate.is_none());
    assert_eq!(hub.subscribe_after(0), vec![first]);
}

#[test]
fn event_hub_bounds_replay_and_ignores_a_newer_cursor() {
    let hub = EventHub::new(2);
    let _ = hub.publish(test_event("one"));
    let _ = hub.publish(test_event("two"));
    let _ = hub.publish(test_event("three"));

    let replay = hub.subscribe_after(0);
    assert_eq!(replay.len(), 2);
    assert_eq!(replay[0].event_id, "two");
    assert_eq!(replay[1].event_id, "three");
    assert!(hub.subscribe_after(4).is_empty());
}

#[test]
fn event_hub_rejects_an_event_id_after_its_replay_entry_is_evicted() {
    let hub = EventHub::new(2);
    let _ = hub.publish(test_event("one"));
    let _ = hub.publish(test_event("two"));
    let _ = hub.publish(test_event("three"));

    assert!(hub.publish(test_event("one")).is_none());

    assert_eq!(hub.latest_sequence(), 3);
    assert_eq!(hub.len(), 2);
    let replay = hub.subscribe_after(0);
    assert_eq!(
        replay
            .iter()
            .map(|event| event.event_id.as_str())
            .collect::<Vec<_>>(),
        vec!["two", "three"]
    );
}

#[test]
fn control_forwarding_never_reemits_an_older_duplicate_sequence() {
    let hub = EventHub::new(2);
    let mut forwarded = Vec::new();

    forward_control_event(&hub, test_event("a"), |event| forwarded.push(event));
    forward_control_event(&hub, test_event("b"), |event| forwarded.push(event));
    forward_control_event(&hub, test_event("a"), |event| forwarded.push(event));

    assert_eq!(
        forwarded
            .iter()
            .map(|event| (event.event_id.as_str(), event.sequence))
            .collect::<Vec<_>>(),
        vec![("a", 1), ("b", 2)]
    );
}

fn test_event(event_id: &str) -> AgentEventEnvelope {
    AgentEventEnvelope::new(
        event_id.into(),
        "project-1".into(),
        Some("agent-1".into()),
        AgentEventKind::AgentOutput,
        AgentEventPayload::Text {
            text: event_id.into(),
        },
    )
}

#[test]
fn mapped_pty_output_preserves_agent_identity_and_text() {
    let event = PtyManager::agent_output_event(
        "project-1",
        "agent-1",
        &TerminalOutputEvent {
            terminal_id: "terminal-1".into(),
            data: "hello from the PTY".into(),
        },
    );

    assert_eq!(event.project_id, "project-1");
    assert_eq!(event.agent_id.as_deref(), Some("agent-1"));
    assert_eq!(event.source, AgentEventSource::Pty);
    assert_eq!(event.kind, AgentEventKind::AgentOutput);
    assert_eq!(
        event.payload,
        AgentEventPayload::Text {
            text: "hello from the PTY".into(),
        }
    );
}

#[test]
fn mapped_pty_statuses_produce_started_exited_and_failed_evidence() {
    let cases = [
        (
            TerminalStatus::Running,
            AgentEventKind::AgentStarted,
            AgentEventPayload::Empty,
        ),
        (
            TerminalStatus::Exited,
            AgentEventKind::AgentExited,
            AgentEventPayload::Exit { code: None },
        ),
        (
            TerminalStatus::Killed,
            AgentEventKind::AgentExited,
            AgentEventPayload::Exit { code: None },
        ),
        (
            TerminalStatus::Failed,
            AgentEventKind::AgentFailed,
            AgentEventPayload::Attention {
                reason: "PTY reader stopped unexpectedly".into(),
            },
        ),
    ];

    for (status, expected_kind, expected_payload) in cases {
        let event = PtyManager::agent_status_event(
            "project-1",
            "agent-1",
            &TerminalStatusEvent {
                terminal_id: "terminal-1".into(),
                status,
            },
        );
        assert_eq!(event.kind, expected_kind);
        assert_eq!(event.payload, expected_payload);
    }
}

#[test]
fn control_events_after_replays_from_the_requested_sequence() {
    let hub = EventHub::new(4);
    let _ = hub.publish(test_event("one"));
    let _ = hub.publish(test_event("two"));

    let replay = control_events_after_from_hub(&hub, 1);
    assert_eq!(replay.len(), 1);
    assert_eq!(replay[0].event_id, "two");
    assert!(control_events_after_from_hub(&hub, 3).is_empty());
}

#[test]
fn mapped_pty_session_keeps_terminal_events_and_adds_control_evidence() {
    let directory = tempdir().expect("temporary directory");
    let manager = PtyManager::new();
    let sink = MemoryEventSink::default();
    let terminal = manager
        .create_shell(
            Some(directory.path().to_string_lossy().as_ref()),
            sink.clone(),
        )
        .expect("create shell");

    manager
        .bind_agent(&terminal.id, "project-1".into(), "agent-1".into())
        .expect("bind agent");
    let marker = "CONTROL_EVENT_OUTPUT_MARKER";
    manager
        .write(&terminal.id, &format!("echo {marker}\r\n"))
        .expect("write marker");

    assert!(wait_for_control_event(&sink, |event| {
        event.kind == AgentEventKind::AgentOutput
            && matches!(&event.payload, AgentEventPayload::Text { text } if text.contains(marker))
    }));
    assert!(sink.contains(&terminal.id, marker));
    assert!(sink
        .statuses()
        .iter()
        .any(|event| event.status == TerminalStatus::Running));

    manager.kill(&terminal.id).expect("kill shell");
    assert!(wait_for_control_event(&sink, |event| {
        event.kind == AgentEventKind::AgentExited
    }));
    assert!(sink
        .statuses()
        .iter()
        .any(|event| event.status == TerminalStatus::Killed));
}

#[test]
fn agent_outcome_before_binding_is_retained_and_published_once() {
    let directory = tempdir().expect("temporary directory");
    let manager = PtyManager::new();
    let sink = MemoryEventSink::awaiting_agent_binding();
    let terminal = manager
        .create_shell(
            Some(directory.path().to_string_lossy().as_ref()),
            sink.clone(),
        )
        .expect("spawn agent terminal");

    manager.kill(&terminal.id).expect("record terminal outcome");
    assert_eq!(
        manager
            .session_status(&terminal.id)
            .expect("retained session"),
        TerminalStatus::Killed
    );
    assert!(sink.control_events().is_empty());

    manager
        .bind_agent(&terminal.id, "project-1".into(), "agent-1".into())
        .expect("bind completed agent");

    let terminal_outcomes = sink
        .statuses()
        .into_iter()
        .filter(|event| event.status != TerminalStatus::Running)
        .collect::<Vec<_>>();
    assert_eq!(terminal_outcomes.len(), 1);
    let control_events = sink.control_events();
    assert_eq!(control_events.len(), 1);
    let control_outcomes = control_events
        .iter()
        .filter(|event| {
            matches!(
                event.kind,
                AgentEventKind::AgentExited | AgentEventKind::AgentFailed
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(control_outcomes.len(), 1);
    assert_eq!(control_outcomes[0].kind, AgentEventKind::AgentExited);
    assert!(manager.session_status(&terminal.id).is_err());
}

fn wait_for_control_event(
    sink: &MemoryEventSink,
    predicate: impl Fn(&AgentEventEnvelope) -> bool,
) -> bool {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if sink.control_events().iter().any(&predicate) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    false
}
