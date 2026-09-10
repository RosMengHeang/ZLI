use super::{
    AgentEventEnvelope, AgentEventKind, AgentEventPayload, AgentEventSource, AttentionStatus,
    ExecutionStatus,
};
use crate::commands::{
    control_events_after_from_hub, forward_control_event, publish_attention_ack,
    publish_attention_mark_all_read,
};
use crate::event_hub::EventHub;
use crate::pty::{
    MemoryEventSink, PtyManager, TerminalOutputEvent, TerminalStatus, TerminalStatusEvent,
};
use serde::Serialize;
use serde_json::json;
use std::time::{Duration, Instant};
use tempfile::tempdir;

#[test]
fn attention_lifecycle_and_acknowledgement() {
    use super::attention::{AttentionReducer, AttentionState};
    let mut state = AttentionState::default();
    for (kind, execution, attention, unread) in [
        (
            AgentEventKind::AgentStarted,
            ExecutionStatus::Running,
            AttentionStatus::Working,
            0,
        ),
        (
            AgentEventKind::AgentWaiting,
            ExecutionStatus::Running,
            AttentionStatus::WaitingForYou,
            1,
        ),
        (
            AgentEventKind::AttentionAck,
            ExecutionStatus::Running,
            AttentionStatus::WaitingForYou,
            0,
        ),
        (
            AgentEventKind::AgentPromptDetected,
            ExecutionStatus::Running,
            AttentionStatus::WaitingForYou,
            0,
        ),
        (
            AgentEventKind::AgentOutput,
            ExecutionStatus::Running,
            AttentionStatus::WaitingForYou,
            0,
        ),
        (
            AgentEventKind::AgentStarted,
            ExecutionStatus::Running,
            AttentionStatus::Working,
            0,
        ),
        (
            AgentEventKind::AgentPromptDetected,
            ExecutionStatus::Running,
            AttentionStatus::WaitingForYou,
            1,
        ),
        (
            AgentEventKind::AgentCompleted,
            ExecutionStatus::Running,
            AttentionStatus::Completed,
            2,
        ),
        (
            AgentEventKind::AgentExited,
            ExecutionStatus::Exited,
            AttentionStatus::Completed,
            2,
        ),
        (
            AgentEventKind::AttentionMarkAllRead,
            ExecutionStatus::Exited,
            AttentionStatus::Completed,
            0,
        ),
        (
            AgentEventKind::AgentStarted,
            ExecutionStatus::Running,
            AttentionStatus::Working,
            0,
        ),
        (
            AgentEventKind::AgentFailed,
            ExecutionStatus::Error,
            AttentionStatus::Failed,
            1,
        ),
        (
            AgentEventKind::AgentExited,
            ExecutionStatus::Error,
            AttentionStatus::Failed,
            1,
        ),
        (
            AgentEventKind::AgentStarted,
            ExecutionStatus::Running,
            AttentionStatus::Working,
            1,
        ),
        (
            AgentEventKind::AgentPaused,
            ExecutionStatus::Paused,
            AttentionStatus::Paused,
            1,
        ),
        (
            AgentEventKind::AgentStarted,
            ExecutionStatus::Running,
            AttentionStatus::Working,
            1,
        ),
        (
            AgentEventKind::AgentStopped,
            ExecutionStatus::Stopped,
            AttentionStatus::Offline,
            1,
        ),
        (
            AgentEventKind::AgentExited,
            ExecutionStatus::Stopped,
            AttentionStatus::Offline,
            1,
        ),
    ] {
        let mut event = test_event("attention");
        event.kind = kind;
        event.payload = AgentEventPayload::Empty;
        state = AttentionReducer::apply(&state, &event);
        assert_eq!(state.execution_status, execution);
        assert_eq!(state.attention_status, attention);
        assert_eq!(state.unread_count, unread);
        assert_eq!(state.unread, unread > 0);
    }
}

#[test]
fn terminal_execution_states_reject_stale_lifecycle_evidence_until_an_agent_starts() {
    use super::attention::{AttentionReducer, AttentionState};
    let terminal_states = [
        AttentionState {
            execution_status: ExecutionStatus::Error,
            attention_status: AttentionStatus::Failed,
            unread: true,
            unread_count: 4,
        },
        AttentionState {
            execution_status: ExecutionStatus::Exited,
            attention_status: AttentionStatus::Completed,
            unread: false,
            unread_count: 0,
        },
        AttentionState {
            execution_status: ExecutionStatus::Stopped,
            attention_status: AttentionStatus::Offline,
            unread: true,
            unread_count: 2,
        },
    ];
    let stale_kinds = [
        AgentEventKind::AgentPromptDetected,
        AgentEventKind::AgentWaiting,
        AgentEventKind::AgentCompleted,
        AgentEventKind::AgentFailed,
        AgentEventKind::AgentPaused,
        AgentEventKind::AgentStopped,
        AgentEventKind::AgentExited,
    ];

    for state in terminal_states {
        for kind in &stale_kinds {
            let mut event = test_event("stale");
            event.kind = kind.clone();
            assert_eq!(AttentionReducer::apply(&state, &event), state);
        }
        let mut started = test_event("started");
        started.kind = AgentEventKind::AgentStarted;
        assert_eq!(
            AttentionReducer::apply(&state, &started),
            AttentionState {
                execution_status: ExecutionStatus::Running,
                attention_status: AttentionStatus::Working,
                unread: state.unread,
                unread_count: state.unread_count,
            }
        );
    }
}

#[test]
fn attention_exit_codes_and_notification_derivation() {
    use super::attention::{derive_notification, AttentionReducer, AttentionState};
    for (code, attention, unread) in [
        (Some(0), AttentionStatus::Completed, 1),
        (Some(7), AttentionStatus::Failed, 1),
        (None, AttentionStatus::Offline, 0),
    ] {
        let mut event = test_event("exit");
        event.kind = AgentEventKind::AgentExited;
        event.payload = AgentEventPayload::Exit { code };
        let state = AttentionReducer::apply(&AttentionState::default(), &event);
        assert_eq!(state.execution_status, ExecutionStatus::Exited);
        assert_eq!(state.attention_status, attention);
        assert_eq!(state.unread_count, unread);
    }
    let mut event = test_event("waiting");
    event.kind = AgentEventKind::AgentWaiting;
    event.payload = AgentEventPayload::Attention {
        reason: "\u{1b}[31m<script>secret\n".into(),
    };
    let initial = AttentionState::default();
    let notification = derive_notification(&event, &initial).expect("waiting notification");
    assert_eq!(notification.project_id, "project-1");
    assert_eq!(notification.agent_id.as_deref(), Some("agent-1"));
    assert!(!notification.message.contains("secret"));
    let waiting = AttentionReducer::apply(&initial, &event);
    assert!(derive_notification(&event, &waiting).is_none());
    let mut ack = event.clone();
    ack.kind = AgentEventKind::AttentionAck;
    assert!(derive_notification(&event, &AttentionReducer::apply(&waiting, &ack)).is_none());
    for kind in [
        AgentEventKind::AgentOutput,
        AgentEventKind::AgentPaused,
        AgentEventKind::AgentStopped,
        AgentEventKind::AgentMessageDelivered,
        AgentEventKind::AttentionAck,
    ] {
        event.kind = kind;
        assert!(derive_notification(&event, &initial).is_none());
    }
}

#[test]
fn attention_quiet_period_and_hysteresis() {
    use super::attention::{
        should_promote_to_waiting, AttentionReducer, AttentionState, WaitingEvidence,
    };
    let initial = AttentionState::default();
    let evidence = WaitingEvidence::GenericOutput {
        last_output_at: Some(1000),
    };
    assert!(!should_promote_to_waiting(&initial, &evidence, 5999));
    assert!(should_promote_to_waiting(&initial, &evidence, 6000));
    assert!(!should_promote_to_waiting(&initial, &evidence, 999));
    assert!(!should_promote_to_waiting(
        &initial,
        &WaitingEvidence::GenericOutput {
            last_output_at: None
        },
        6000
    ));
    for evidence in [
        WaitingEvidence::ProviderHook,
        WaitingEvidence::ProcessExit,
        WaitingEvidence::TaxchatDelivery,
        WaitingEvidence::Api,
        WaitingEvidence::ProviderPrompt,
    ] {
        assert!(should_promote_to_waiting(&initial, &evidence, 0));
    }
    let mut event = test_event("waiting");
    event.kind = AgentEventKind::AgentWaiting;
    let waiting = AttentionReducer::apply(&initial, &event);
    assert!(!should_promote_to_waiting(&waiting, &evidence, 10000));
    event.kind = AgentEventKind::AttentionAck;
    assert!(!should_promote_to_waiting(
        &AttentionReducer::apply(&waiting, &event),
        &evidence,
        10000
    ));
}

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
            AgentEventPayload::Exit { code: None },
            json!({ "type": "exit", "code": null }),
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
fn event_hub_attention_acceptance_preserves_lifecycle_and_terminal_precedence() {
    use super::attention::{AttentionReducer, AttentionState};
    use std::collections::HashMap;

    let hub = EventHub::new(32);
    let publish = |event_id: &str,
                   agent_id: &str,
                   kind: AgentEventKind,
                   payload: AgentEventPayload,
                   source: AgentEventSource| {
        let mut event = AgentEventEnvelope::new(
            event_id.into(),
            "project-acceptance".into(),
            Some(agent_id.into()),
            kind,
            payload,
        );
        event.source = source;
        hub.publish(event)
    };

    for (event_id, agent_id, kind, payload, source) in [
        (
            "start-a",
            "agent-a",
            AgentEventKind::AgentStarted,
            AgentEventPayload::Empty,
            AgentEventSource::Runtime,
        ),
        (
            "completed-a",
            "agent-a",
            AgentEventKind::AgentCompleted,
            AgentEventPayload::Empty,
            AgentEventSource::Runtime,
        ),
        (
            "exit-a",
            "agent-a",
            AgentEventKind::AgentExited,
            AgentEventPayload::Exit { code: Some(0) },
            AgentEventSource::Runtime,
        ),
        (
            "stale-wait-a",
            "agent-a",
            AgentEventKind::AgentWaiting,
            AgentEventPayload::Empty,
            AgentEventSource::Provider,
        ),
        (
            "restart-a",
            "agent-a",
            AgentEventKind::AgentStarted,
            AgentEventPayload::Empty,
            AgentEventSource::Runtime,
        ),
        (
            "failed-a",
            "agent-a",
            AgentEventKind::AgentFailed,
            AgentEventPayload::Empty,
            AgentEventSource::Runtime,
        ),
        (
            "stale-completed-a",
            "agent-a",
            AgentEventKind::AgentCompleted,
            AgentEventPayload::Empty,
            AgentEventSource::Runtime,
        ),
        (
            "waiting-b",
            "agent-b",
            AgentEventKind::AgentWaiting,
            AgentEventPayload::Empty,
            AgentEventSource::Provider,
        ),
    ] {
        assert!(publish(event_id, agent_id, kind, payload, source).is_some());
    }
    assert!(publish(
        "waiting-b",
        "agent-b",
        AgentEventKind::AgentFailed,
        AgentEventPayload::Empty,
        AgentEventSource::Runtime,
    )
    .is_none());
    let ack = publish_attention_ack(&hub, "project-acceptance", "agent-a").expect("ack event");

    let mut states = HashMap::<String, AttentionState>::new();
    for event in hub.subscribe_after(0) {
        let agent_id = event.agent_id.clone().expect("agent-scoped event");
        let previous = states.get(&agent_id).cloned().unwrap_or_default();
        let next = AttentionReducer::apply(&previous, &event);
        match event.event_id.as_str() {
            "completed-a" => {
                assert_eq!(next.execution_status, ExecutionStatus::Running);
                assert_eq!(next.attention_status, AttentionStatus::Completed);
            }
            "stale-wait-a" => {
                assert_eq!(next.execution_status, ExecutionStatus::Exited);
                assert_eq!(next.attention_status, AttentionStatus::Completed);
            }
            "restart-a" => {
                assert_eq!(next.execution_status, ExecutionStatus::Running);
                assert_eq!(next.attention_status, AttentionStatus::Working);
                assert_eq!(next.unread_count, 1);
            }
            "stale-completed-a" => {
                assert_eq!(next.execution_status, ExecutionStatus::Error);
                assert_eq!(next.attention_status, AttentionStatus::Failed);
            }
            _ => {}
        }
        states.insert(agent_id, next);
    }

    assert_eq!(hub.latest_sequence(), 9);
    assert_eq!(ack.sequence, 9);
    assert_eq!(
        states.get("agent-a"),
        Some(&AttentionState {
            execution_status: ExecutionStatus::Error,
            attention_status: AttentionStatus::Failed,
            unread: false,
            unread_count: 0,
        })
    );
    assert_eq!(
        states.get("agent-b"),
        Some(&AttentionState {
            execution_status: ExecutionStatus::Starting,
            attention_status: AttentionStatus::WaitingForYou,
            unread: true,
            unread_count: 1,
        })
    );
}

#[test]
fn provider_prompt_detection_flows_from_pty_output_to_waiting_once() {
    assert_real_provider_prompt_fixture("codex", 0x203a, "codex_prompt_marker");
}

#[test]
fn claude_prompt_detection_flows_from_pty_output_to_waiting_once() {
    assert_real_provider_prompt_fixture("claude-code", 0x276f, "claude_code_prompt_marker");
}

#[test]
fn provider_prompt_detection_handles_claude_epochs_and_unknown_providers() {
    use super::prompt_detector::AgentOutputNormalizer;

    let prompt_count = |events: &[AgentEventEnvelope]| {
        events
            .iter()
            .filter(|event| event.kind == AgentEventKind::AgentPromptDetected)
            .count()
    };
    let mut claude = AgentOutputNormalizer::new("project-1", "agent-claude", "claude-code");
    assert_eq!(
        prompt_count(&claude.accept_output(b"\x1b[2K\r\x1b[1m\xe2\x9d")),
        0
    );
    let detected = claude.accept_output(b"\xaf\x1b[22m \x1b[?25h");
    assert_eq!(prompt_count(&detected), 1);
    assert_eq!(detected[1].source, AgentEventSource::Provider);
    assert_eq!(
        detected[1].payload,
        AgentEventPayload::Attention {
            reason: "claude_code_prompt_marker".into(),
        }
    );
    assert_eq!(
        prompt_count(&claude.accept_output(b"\x1b[2K\r\x1b[1m\xe2\x9d\xaf\x1b[22m \x1b[?25h")),
        0
    );
    assert_eq!(
        prompt_count(&claude.accept_output(b"Applied the requested edit.\r\n")),
        0
    );
    assert_eq!(
        prompt_count(&claude.accept_output(b"\x1b[2K\r\x1b[1m\xe2\x9d\xaf\x1b[22m \x1b[?25h")),
        0
    );
    claude.accept_input(b"x");
    assert_eq!(
        prompt_count(&claude.accept_output(b"\x1b[2K\r\x1b[1m\xe2\x9d\xaf\x1b[22m \x1b[?25h")),
        0
    );
    claude.accept_input(b"\r");
    assert_eq!(
        prompt_count(&claude.accept_output(b"\x1b[2K\r\x1b[1m\xe2\x9d\xaf\x1b[22m \x1b[?25h")),
        1
    );

    let mut unknown = AgentOutputNormalizer::new("project-1", "agent-unknown", "shell");
    assert_eq!(
        prompt_count(&unknown.accept_output(b"\x1b[2K\r\xe2\x80\xba \r\n\x1b[2K\r\xe2\x9d\xaf ")),
        0
    );
    claude.clear();
    assert_eq!(
        prompt_count(&claude.accept_output(b"activity\r\n\xe2\x9d\xaf ")),
        0
    );
}

#[test]
fn provider_prompt_detection_accepts_codex_screen_fixture_without_redraw_storms() {
    use super::prompt_detector::AgentOutputNormalizer;

    let prompt_count = |events: &[AgentEventEnvelope]| {
        events
            .iter()
            .filter(|event| event.kind == AgentEventKind::AgentPromptDetected)
            .count()
    };
    let frame = b"\x1b[?2026h\x1b[12;1H\xe2\x80\xba \x1b[13;1H? for shortcuts\x1b[?2026l";
    let mut codex = AgentOutputNormalizer::new("project-1", "agent-codex", "codex");

    assert_eq!(prompt_count(&codex.accept_output(frame)), 1);
    assert_eq!(prompt_count(&codex.accept_output(frame)), 0);
    codex.accept_input(b"\r");
    assert_eq!(prompt_count(&codex.accept_output(frame)), 1);
}

#[test]
fn provider_prompt_detection_starts_a_clean_epoch_after_input() {
    use super::prompt_detector::AgentOutputNormalizer;

    let prompt_events = |events: Vec<AgentEventEnvelope>| {
        events
            .into_iter()
            .filter(|event| event.kind == AgentEventKind::AgentPromptDetected)
            .collect::<Vec<_>>()
    };
    let marker = b"\x1b[2K\r\xe2\x80\xba \x1b[?25h";
    let mut codex = AgentOutputNormalizer::new("project-1", "agent-codex", "codex");

    let initial = prompt_events(codex.accept_output(marker));
    assert_eq!(initial.len(), 1);
    assert_eq!(
        initial[0].payload,
        AgentEventPayload::Attention {
            reason: "codex_prompt_marker".into(),
        }
    );

    codex.accept_input(b"run tests\r");
    assert!(prompt_events(codex.accept_output(b"\x1b[?25h")).is_empty());
    assert!(prompt_events(codex.accept_output(b"Compiling workspace\r\n")).is_empty());

    let later = prompt_events(codex.accept_output(marker));
    assert_eq!(later.len(), 1);
    assert_eq!(
        later[0].payload,
        AgentEventPayload::Attention {
            reason: "codex_prompt_marker".into(),
        }
    );
}

#[test]
fn provider_prompt_detection_does_not_treat_chunk_boundaries_as_line_boundaries() {
    use super::prompt_detector::AgentOutputNormalizer;

    let prompt_count = |events: &[AgentEventEnvelope]| {
        events
            .iter()
            .filter(|event| event.kind == AgentEventKind::AgentPromptDetected)
            .count()
    };
    let mut codex = AgentOutputNormalizer::new("project-1", "agent-codex", "codex");

    assert_eq!(prompt_count(&codex.accept_output("›".as_bytes())), 0);
    assert_eq!(
        prompt_count(&codex.accept_output(b" ordinary progress\r\n")),
        0
    );

    let mut codex = AgentOutputNormalizer::new("project-1", "agent-codex", "codex");
    assert_eq!(
        prompt_count(&codex.accept_output(b"\x1b[?2026h\xe2\x80\xba\x1b[?2026h ordinary\r\n")),
        0
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
fn output_before_binding_is_normalized_after_provider_metadata_arrives() {
    let directory = tempdir().expect("temporary directory");
    let manager = PtyManager::new();
    let sink = MemoryEventSink::awaiting_agent_binding();
    let terminal = manager
        .create_shell(
            Some(directory.path().to_string_lossy().as_ref()),
            sink.clone(),
        )
        .expect("create agent terminal");
    let marker = "OUTPUT_BEFORE_AGENT_BINDING";
    manager
        .write(&terminal.id, &format!("echo {marker}\r\n"))
        .expect("write marker");
    assert!(wait_for_terminal_output(&sink, &terminal.id, marker));
    assert!(sink.control_events().is_empty());

    manager
        .bind_agent(
            &terminal.id,
            "project-1".into(),
            "agent-1".into(),
            "codex".into(),
        )
        .expect("bind agent with provider");

    assert!(wait_for_control_event(&sink, |event| {
        event.kind == AgentEventKind::AgentOutput
            && matches!(&event.payload, AgentEventPayload::Text { text } if text.contains(marker))
    }));
    manager.kill(&terminal.id).expect("kill shell");
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
fn acknowledgement_commands_publish_normalized_scoped_events() {
    let hub = EventHub::new(4);
    let ack = publish_attention_ack(&hub, "project-1", "agent-1").expect("ack event");
    let mark_all = publish_attention_mark_all_read(&hub, "project-1").expect("mark all event");

    assert_eq!(ack.sequence, 1);
    assert_eq!(ack.project_id, "project-1");
    assert_eq!(ack.agent_id.as_deref(), Some("agent-1"));
    assert_eq!(ack.source, AgentEventSource::User);
    assert_eq!(ack.kind, AgentEventKind::AttentionAck);
    assert_eq!(ack.payload, AgentEventPayload::Empty);
    assert_eq!(mark_all.sequence, 2);
    assert_eq!(mark_all.project_id, "project-1");
    assert_eq!(mark_all.agent_id, None);
    assert_eq!(mark_all.source, AgentEventSource::User);
    assert_eq!(mark_all.kind, AgentEventKind::AttentionMarkAllRead);
    assert_eq!(hub.subscribe_after(0), vec![ack, mark_all]);
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
        .bind_agent(
            &terminal.id,
            "project-1".into(),
            "agent-1".into(),
            "codex".into(),
        )
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
        .bind_agent(
            &terminal.id,
            "project-1".into(),
            "agent-1".into(),
            "claude-code".into(),
        )
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

fn assert_real_provider_prompt_fixture(
    provider_id: &str,
    marker_codepoint: u32,
    expected_reason: &str,
) {
    use super::attention::{AttentionReducer, AttentionState};
    use crate::system::detect_powershell;
    use std::ffi::OsString;

    let directory = tempdir().expect("temporary directory");
    let manager = PtyManager::new();
    let sink = MemoryEventSink::awaiting_agent_binding();
    let hub = EventHub::new(32);
    let marker = format!("[char]0x{marker_codepoint:X}");
    let script = format!(
        concat!(
            "$escape = [char]27; ",
            "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); ",
            "Write-Output 'ordinary progress >'; ",
            "Start-Sleep -Milliseconds 750; ",
            "[Console]::Out.Write(\"$escape[2K`r$escape[1m\"); ",
            "[Console]::Out.Flush(); ",
            "Start-Sleep -Milliseconds 75; ",
            "[Console]::Out.Write({marker}); ",
            "[Console]::Out.Flush(); ",
            "Start-Sleep -Milliseconds 75; ",
            "[Console]::Out.Write(\"$escape[22m $escape[?25h\"); ",
            "[Console]::Out.Flush(); ",
            "Start-Sleep -Milliseconds 75; ",
            "[Console]::Out.Write(\"$escape[2K`r$escape[1m$({marker})$escape[22m $escape[?25h\"); ",
            "[Console]::Out.Flush(); ",
            "[Console]::Out.Write(\"`r`nREDRAW_COMPLETE`r`n\"); ",
            "[Console]::Out.Flush(); ",
            "Start-Sleep -Seconds 2",
        ),
        marker = marker,
    );
    let terminal = manager
        .spawn_agent_with_size_args(
            detect_powershell().expect("detect PowerShell"),
            vec![
                OsString::from("-NoLogo"),
                OsString::from("-NoProfile"),
                OsString::from("-Command"),
                OsString::from(script),
            ],
            Some(directory.path().to_string_lossy().as_ref()),
            120,
            30,
            std::sync::Arc::new(sink.clone()),
        )
        .expect("spawn deterministic prompt fixture");
    manager
        .bind_agent(
            &terminal.id,
            "project-1".into(),
            "agent-1".into(),
            provider_id.into(),
        )
        .expect("bind provider identity");
    assert!(wait_for_control_event(&sink, |event| {
        event.kind == AgentEventKind::AgentPromptDetected
    }));
    assert!(wait_for_terminal_output(
        &sink,
        &terminal.id,
        "REDRAW_COMPLETE"
    ));

    let control_events = sink.control_events();
    assert!(control_events.iter().any(|event| {
        event.kind == AgentEventKind::AgentOutput
            && matches!(&event.payload, AgentEventPayload::Text { text } if text.contains("ordinary progress >"))
    }));
    assert!(sink.contains(&terminal.id, "ordinary progress >"));
    for event in control_events {
        hub.publish(event).expect("publish PTY evidence once");
    }

    let replay = hub.subscribe_after(0);
    let prompt_events = replay
        .iter()
        .filter(|event| event.kind == AgentEventKind::AgentPromptDetected)
        .collect::<Vec<_>>();
    assert_eq!(prompt_events.len(), 1);
    assert_eq!(prompt_events[0].source, AgentEventSource::Provider);
    assert_eq!(
        prompt_events[0].payload,
        AgentEventPayload::Attention {
            reason: expected_reason.into(),
        }
    );
    let state = replay
        .iter()
        .fold(AttentionState::default(), |state, event| {
            AttentionReducer::apply(&state, event)
        });
    assert_eq!(state.execution_status, ExecutionStatus::Running);
    assert_eq!(state.attention_status, AttentionStatus::WaitingForYou);
    assert_eq!(state.unread_count, 1);
    manager.kill(&terminal.id).expect("kill prompt fixture");
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

fn wait_for_terminal_output(sink: &MemoryEventSink, terminal_id: &str, marker: &str) -> bool {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if sink.contains(terminal_id, marker) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    false
}
