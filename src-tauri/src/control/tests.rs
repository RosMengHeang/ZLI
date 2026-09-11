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

use super::{
    CallerIdentity, Capability, ControlMethod, ControlRequest, ControlResponse,
    CONTROL_PROTOCOL_VERSION,
};
use super::{CapabilityTokenStore, CommandRouter, ControlHandler};
use super::{
    OwnershipLedger, ProjectSnapshot, RuntimeOwnershipRecord, SnapshotStore, SnapshotStoreError,
};
use crate::pty::ProcessIdentity;
#[cfg(windows)]
use std::process::Command;
use super::{RuntimeSession, SessionRegistry};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Barrier};
use std::thread;

#[test]
fn browser_control_settings_enable_clean_profile_by_default() {
    let control_dir = tempdir().expect("temporary control directory");
    let store = super::browser::settings::BrowserControlSettingsStore::open(control_dir.path())
        .expect("open settings store");

    assert!(store.is_enabled("clean").expect("clean profile setting"));
    assert!(!store
        .is_enabled("default")
        .expect("unknown profile setting"));
}

#[test]
fn browser_control_settings_fail_closed_for_corrupt_json() {
    let control_dir = tempdir().expect("temporary control directory");
    std::fs::write(control_dir.path().join("settings.json"), b"not json")
        .expect("write corrupt settings");

    let store = super::browser::settings::BrowserControlSettingsStore::open(control_dir.path())
        .expect("open corrupt settings store");

    assert!(!store.is_enabled("clean").expect("corrupt settings should fail closed"));
}

#[test]
fn browser_control_settings_reload_profile_values() {
    let control_dir = tempdir().expect("temporary control directory");
    let store = super::browser::settings::BrowserControlSettingsStore::open(control_dir.path())
        .expect("open settings store");

    store
        .set_enabled("clean", false)
        .expect("disable clean profile");
    store
        .set_enabled("preview", true)
        .expect("enable preview profile");

    let reloaded = super::browser::settings::BrowserControlSettingsStore::open(control_dir.path())
        .expect("reload settings store");
    assert!(!reloaded.is_enabled("clean").expect("clean profile setting"));
    assert!(reloaded
        .is_enabled("preview")
        .expect("preview profile setting"));
}

#[test]
fn browser_control_protocol_accepts_status_methods_and_error_code() {
    let status = ControlRequest::from_json(
        r#"{"id":"browser-status","protocolVersion":1,"method":"browser.status","params":{},"timeoutMs":5000}"#,
    )
    .expect("browser status request");
    assert_eq!(status.method, ControlMethod::BrowserStatus);

    let error = super::ControlError::new(
        super::ControlErrorCode::BrowserControlDisabled,
        "Built-in browser control is disabled",
    );
    assert_eq!(error.code, "BROWSER_CONTROL_DISABLED");
}

#[test]
fn disabled_browser_profile_rejects_read_before_surface_grant() {
    let control_dir = tempdir().expect("temporary control directory");
    let settings = Arc::new(
        super::browser::settings::BrowserControlSettingsStore::open(control_dir.path())
            .expect("open settings store"),
    );
    settings
        .set_enabled("clean", false)
        .expect("disable clean profile");
    let manager = super::browser::BrowserManager::with_settings(Arc::new(|_| {}), settings);
    let surface = manager
        .register(
            "project-1",
            Some("agent-1".into()),
            "browser-panel-1",
            "about:blank",
            "clean",
        )
        .expect("register clean surface");
    manager
        .grant(&surface.surface_id, super::browser::commands::BrowserCapability::Read)
        .expect("grant read");

    let caller = CallerIdentity {
        caller_id: "agent-1".into(),
        project_id: "project-1".into(),
        agent_id: Some("agent-1".into()),
        parent_agent_id: None,
        capabilities: vec![Capability::BrowserRead],
        expires_at: None,
    };
    let command = super::browser::commands::BrowserCommand::Snapshot {
        surface_id: surface.surface_id.clone(),
        selector: None,
        max_depth: None,
    };
    assert_eq!(
        manager
            .authorize(&caller, &surface.surface_id, &command)
            .expect_err("disabled profile must reject read")
            .code,
        super::ControlErrorCode::BrowserControlDisabled
    );
}

#[test]
fn control_request_round_trips_and_rejects_unknown_protocol_versions() {
    let request = ControlRequest::new("req-1", ControlMethod::AgentList, json!({}), 5_000)
        .expect("valid control request");
    let encoded = serde_json::to_string(&request).expect("serialize request");
    let decoded = ControlRequest::from_json(&encoded).expect("decode request");
    assert_eq!(decoded.protocol_version, CONTROL_PROTOCOL_VERSION);
    assert_eq!(decoded.method, ControlMethod::AgentList);

    let mismatch = ControlRequest::from_json(
        r#"{"id":"req-2","protocolVersion":99,"method":"agent.list","params":{},"timeoutMs":5000}"#,
    )
    .expect_err("future protocol must fail");
    assert_eq!(mismatch.code, "CONTROL_PROTOCOL_MISMATCH");
}

#[test]
fn control_request_validates_ids_timeouts_methods_and_capability_wire_names() {
    assert!(ControlRequest::new("", ControlMethod::AgentList, json!({}), 5_000).is_err());
    assert!(ControlRequest::new("req", ControlMethod::AgentList, json!({}), 99).is_err());
    assert!(ControlRequest::new("req", ControlMethod::AgentList, json!({}), 120_001).is_err());
    assert!(ControlRequest::from_json(
        r#"{"id":"req","protocolVersion":1,"method":"agent.destroy","params":{},"timeoutMs":5000}"#,
    )
    .is_err());
    assert_eq!(
        serde_json::to_string(&Capability::AgentSpawn).unwrap(),
        r#""agent.spawn""#
    );
    assert_eq!(
        serde_json::to_string(&Capability::BrowserJavascript).unwrap(),
        r#""browser.javascript""#
    );
    assert_eq!(
        ControlRequest::from_json(
            r#"{"id":"req","method":"agent.list","params":{},"timeoutMs":5000}"#
        )
        .expect_err("missing version")
        .code,
        "INVALID_CONTROL_REQUEST"
    );
    assert!(ControlResponse::from_json(
        r#"{"id":"req","protocolVersion":1,"ok":true,"result":{},"error":{"code":"CAPABILITY_DENIED","message":"no"}}"#,
    )
    .is_err());
}

fn test_parent_identity() -> super::CallerIdentity {
    super::CallerIdentity {
        caller_id: "parent-1".into(),
        project_id: "project-1".into(),
        agent_id: Some("parent-1".into()),
        parent_agent_id: None,
        capabilities: vec![
            Capability::AgentList,
            Capability::AgentSpawn,
            Capability::AgentSend,
        ],
        expires_at: None,
    }
}

#[test]
fn parent_agent_can_spawn_and_message_but_cannot_discard_worktree() {
    let identity = test_parent_identity();
    assert!(identity.allows(Capability::AgentSpawn));
    assert!(identity.allows(Capability::AgentSend));
    assert!(!identity.allows(Capability::WorktreeDiscard));
}

#[test]
fn expired_identity_and_browser_eval_need_explicit_authority() {
    let mut identity = test_parent_identity();
    identity.expires_at = Some(0);
    assert!(!identity.allows(Capability::AgentList));

    let calls = Arc::new(AtomicUsize::new(0));
    let router = CommandRouter::new(Arc::new(CountingHandler(calls)));
    let request = ControlRequest::new("req-js", ControlMethod::BrowserEval, json!({}), 5_000)
        .expect("valid request");
    let response = router.dispatch(request, test_parent_identity());
    assert_eq!(response.error.expect("denied").code, "CAPABILITY_DENIED");
}

struct CountingHandler(Arc<AtomicUsize>);

impl ControlHandler for CountingHandler {
    fn handle(
        &self,
        _request: &ControlRequest,
        _identity: &super::CallerIdentity,
    ) -> Result<serde_json::Value, super::ControlError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(json!({ "agents": [] }))
    }
}

#[test]
fn duplicate_request_id_returns_the_original_response() {
    let calls = Arc::new(AtomicUsize::new(0));
    let router = CommandRouter::new(Arc::new(CountingHandler(calls.clone())));
    let request = ControlRequest::new("req-1", ControlMethod::AgentList, json!({}), 5_000)
        .expect("valid request");
    let first = router.dispatch(request.clone(), test_parent_identity());
    let second = router.dispatch(request, test_parent_identity());
    assert_eq!(first, second);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

struct SlowCountingHandler {
    calls: Arc<AtomicUsize>,
}

impl ControlHandler for SlowCountingHandler {
    fn handle(
        &self,
        _request: &ControlRequest,
        _identity: &super::CallerIdentity,
    ) -> Result<serde_json::Value, super::ControlError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        thread::sleep(Duration::from_millis(50));
        Ok(json!({ "agents": [] }))
    }
}

#[test]
fn concurrent_duplicate_request_ids_execute_only_once() {
    let calls = Arc::new(AtomicUsize::new(0));
    let router = Arc::new(CommandRouter::new(Arc::new(SlowCountingHandler {
        calls: calls.clone(),
    })));
    let request = ControlRequest::new("concurrent-1", ControlMethod::AgentList, json!({}), 5_000)
        .expect("valid request");
    let start = Arc::new(Barrier::new(8));
    let workers = (0..8)
        .map(|_| {
            let router = router.clone();
            let request = request.clone();
            let start = start.clone();
            thread::spawn(move || {
                start.wait();
                router.dispatch(request, test_parent_identity())
            })
        })
        .collect::<Vec<_>>();

    let responses = workers
        .into_iter()
        .map(|worker| worker.join().expect("worker should finish"))
        .collect::<Vec<_>>();
    assert!(responses.windows(2).all(|pair| pair[0] == pair[1]));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[test]
fn router_rejects_capability_and_cross_project_access() {
    let calls = Arc::new(AtomicUsize::new(0));
    let router = CommandRouter::new(Arc::new(CountingHandler(calls)));
    let denied = ControlRequest::new("req-1", ControlMethod::AgentStop, json!({}), 5_000)
        .expect("valid request");
    let response = router.dispatch(denied, test_parent_identity());
    assert_eq!(response.error.expect("denied").code, "CAPABILITY_DENIED");

    let cross_project = ControlRequest::new(
        "req-2",
        ControlMethod::AgentList,
        json!({ "projectId": "project-2" }),
        5_000,
    )
    .expect("valid request");
    let response = router.dispatch(cross_project, test_parent_identity());
    assert_eq!(response.error.expect("denied").code, "CAPABILITY_DENIED");
}

#[test]
fn capability_tokens_are_scoped_expiring_and_single_store_verifiable() {
    let store = CapabilityTokenStore::default();
    let issued = store.issue(test_parent_identity(), Duration::from_secs(60));
    let verified = store.verify(&issued.token).expect("valid token");
    assert_eq!(verified.project_id, "project-1");
    assert!(!format!("{store:?}").contains(&issued.token));

    let expired = store.issue(test_parent_identity(), Duration::ZERO);
    assert_eq!(
        store.verify(&expired.token).expect_err("expired").code,
        "CAPABILITY_DENIED"
    );
    assert_eq!(
        store.verify("wrong-token").expect_err("unknown").code,
        "CAPABILITY_DENIED"
    );
}

#[cfg(windows)]
#[test]
fn named_pipe_client_receives_a_json_response_from_the_router() {
    let calls = Arc::new(AtomicUsize::new(0));
    let router = Arc::new(CommandRouter::new(Arc::new(CountingHandler(calls))));
    let tokens = Arc::new(CapabilityTokenStore::default());
    let issued = tokens.issue(test_parent_identity(), Duration::from_secs(60));
    let server = super::NamedPipeServer::start_random(router, tokens).expect("start pipe");
    let client = super::NamedPipeClient::new(server.endpoint().to_owned(), issued.token);
    let request =
        ControlRequest::new("pipe-1", ControlMethod::AgentList, json!({}), 5_000).expect("request");
    let response = client.request(request).expect("response");
    assert!(response.ok);
    server.stop().expect("stop server");
}

#[cfg(windows)]
#[test]
fn named_pipe_client_fails_cleanly_after_server_disconnect() {
    let router = Arc::new(CommandRouter::new(Arc::new(CountingHandler(Arc::new(
        AtomicUsize::new(0),
    )))));
    let tokens = Arc::new(CapabilityTokenStore::default());
    let issued = tokens.issue(test_parent_identity(), Duration::from_secs(60));
    let server = super::NamedPipeServer::start_random(router, tokens).expect("start pipe");
    let client = super::NamedPipeClient::new(server.endpoint().to_owned(), issued.token);
    server.stop().expect("stop server");

    let request = ControlRequest::new("pipe-stopped", ControlMethod::AgentList, json!({}), 500)
        .expect("request");
    assert!(client.request(request).is_err());
}

fn test_runtime_session(session_id: &str, agent_id: &str) -> RuntimeSession {
    RuntimeSession::detached_for_test(
        session_id.to_owned(),
        "project-1".to_owned(),
        agent_id.to_owned(),
        "codex".to_owned(),
        "terminal-1".to_owned(),
    )
}

#[test]
fn detached_session_can_be_found_and_attached_by_session_id() {
    let registry = SessionRegistry::default();
    registry.insert(test_runtime_session("session-1", "agent-1"));
    registry.detach("session-1").expect("detach");
    let descriptor = registry.attach("session-1").expect("attach");
    assert_eq!(descriptor.session_id, "session-1");
    assert_eq!(descriptor.agent_id, "agent-1");
    assert!(descriptor.attached);
}

#[test]
fn removed_session_is_no_longer_listed_and_remove_is_idempotent() {
    let registry = SessionRegistry::default();
    registry.insert(test_runtime_session("session-1", "agent-1"));

    assert!(registry.remove("session-1").expect("remove").is_some());
    assert!(registry.list().expect("list").is_empty());
    assert!(registry
        .remove("session-1")
        .expect("repeat remove")
        .is_none());
}

#[test]
fn session_registry_does_not_remove_a_replacement_session() {
    let registry = SessionRegistry::default();
    let original = registry.insert(test_runtime_session("session-1", "agent-1"));
    let replacement = registry.insert(test_runtime_session("session-1", "agent-2"));

    assert!(!registry
        .remove_if_current("session-1", &original)
        .expect("conditional remove"));
    assert!(std::sync::Arc::ptr_eq(
        &registry.get("session-1").expect("replacement"),
        &replacement,
    ));
}

#[test]
fn session_registry_replaces_only_the_expected_session() {
    let registry = SessionRegistry::default();
    let original = registry.insert(test_runtime_session("session-1", "agent-1"));
    let replacement = std::sync::Arc::new(test_runtime_session("session-1", "agent-2"));

    assert!(registry
        .replace_if_current("session-1", &original, replacement.clone())
        .expect("replace current session"));
    assert!(std::sync::Arc::ptr_eq(
        &registry.get("session-1").expect("replacement"),
        &replacement,
    ));

    let stale = std::sync::Arc::new(test_runtime_session("session-1", "agent-3"));
    assert!(!registry
        .replace_if_current("session-1", &original, stale)
        .expect("reject stale replacement"));
    assert_eq!(
        registry
            .get("session-1")
            .expect("current session")
            .descriptor()
            .expect("descriptor")
            .agent_id,
        "agent-2"
    );
}

#[test]
fn session_descriptor_persists_parent_agent_relationship() {
    let mut descriptor = test_runtime_session("session-child", "child-1")
        .descriptor()
        .expect("descriptor");
    descriptor.parent_agent_id = Some("parent-1".into());

    let encoded = serde_json::to_value(&descriptor).expect("serialize descriptor");
    let decoded: super::SessionDescriptor =
        serde_json::from_value(encoded).expect("decode descriptor");

    assert_eq!(decoded.parent_agent_id.as_deref(), Some("parent-1"));
}

#[test]
fn detached_session_keeps_bounded_scrollback_without_forwarding_output() {
    use crate::pty::TerminalOutputEvent;
    let visible = MemoryEventSink::default();
    let session = RuntimeSession::new(
        super::SessionDescriptor {
            session_id: "session-1".into(),
            project_id: "project-1".into(),
            agent_id: "agent-1".into(),
            parent_agent_id: None,
            name: "Codex".into(),
            provider_id: "codex".into(),
            terminal_id: "terminal-1".into(),
            working_directory: "D:/project".into(),
            branch: String::new(),
            worktree_path: None,
            resume: None,
            attached: false,
        },
        PtyManager::new(),
        Some(std::sync::Arc::new(visible.clone())),
        8,
    );
    let sink = session.event_sink();
    sink.emit_output(TerminalOutputEvent {
        terminal_id: "terminal-1".into(),
        data: "123456".into(),
    });
    session.detach().expect("detach");
    sink.emit_output(TerminalOutputEvent {
        terminal_id: "terminal-1".into(),
        data: "7890".into(),
    });

    assert!(visible.contains("terminal-1", "123456"));
    assert!(!visible.contains("terminal-1", "7890"));
    assert_eq!(session.scrollback().expect("scrollback"), "34567890");
}

#[test]
fn older_checkpoint_generation_cannot_replace_a_newer_snapshot() {
    use super::SessionManager;
    let root = tempfile::tempdir().expect("temp dir");
    let store = SnapshotStore::new(root.path().to_path_buf());
    let manager = SessionManager::new(
        std::sync::Arc::new(SessionRegistry::default()),
        store.clone(),
    );
    let mut newer = ProjectSnapshot::empty("project-1".into());
    newer.last_event_sequence = 20;
    let mut older = ProjectSnapshot::empty("project-1".into());
    older.last_event_sequence = 10;

    assert!(manager.persist_generation(2, &newer).expect("newer save"));
    assert!(!manager.persist_generation(1, &older).expect("stale save"));
    assert_eq!(
        store
            .load("project-1")
            .expect("load")
            .expect("snapshot")
            .last_event_sequence,
        20
    );
}

#[test]
fn debounced_checkpoint_persists_only_the_latest_generation() {
    let root = tempfile::tempdir().expect("temp dir");
    let store = SnapshotStore::new(root.path().to_path_buf());
    let manager = std::sync::Arc::new(super::SessionManager::new(
        std::sync::Arc::new(SessionRegistry::default()),
        store.clone(),
    ));
    let mut first = ProjectSnapshot::empty("project-1".into());
    first.last_event_sequence = 1;
    let mut second = ProjectSnapshot::empty("project-1".into());
    second.last_event_sequence = 2;
    manager.schedule_checkpoint(first, Duration::from_millis(30));
    manager.schedule_checkpoint(second, Duration::from_millis(30));
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    let snapshot = loop {
        if let Some(snapshot) = store.load("project-1").expect("load") {
            break snapshot;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "checkpoint was not persisted before the deadline"
        );
        std::thread::sleep(Duration::from_millis(10));
    };

    assert_eq!(snapshot.last_event_sequence, 2);
}

#[test]
fn reconnect_replays_events_after_cursor_without_duplicate_sessions() {
    let root = tempfile::tempdir().expect("temp dir");
    let store = SnapshotStore::new(root.path().to_path_buf());
    let mut snapshot = ProjectSnapshot::empty("project-1".into());
    snapshot.agents.push(json!({
        "descriptor": {
            "sessionId": "session-1",
            "projectId": "project-1",
            "agentId": "agent-1",
            "providerId": "codex",
            "terminalId": "missing-terminal",
            "resume": null,
            "attached": false
        },
        "scrollback": "saved output"
    }));
    store.save_atomic(&snapshot).expect("save snapshot");
    let hub = EventHub::new(8);
    let _ = hub.publish(test_event("before"));
    let _ = hub.publish(test_event("after"));
    let supervisor = super::Supervisor::new(root.path().to_path_buf(), PtyManager::new(), hub);

    assert!(supervisor.start_or_connect().expect("start"));
    let initial = supervisor.restore_project("project-1").expect("restore");
    assert_eq!(initial.created_session_ids, vec!["session-1"]);
    let repeated = supervisor
        .restore_project("project-1")
        .expect("restore again");
    assert_eq!(repeated.session_ids, vec!["session-1"]);
    assert!(repeated.created_session_ids.is_empty());
    let reconnect = supervisor
        .reconnect(super::SUPERVISOR_PROTOCOL_VERSION, 1)
        .expect("reconnect");
    assert_eq!(reconnect.current_sequence, 3);
    assert_eq!(reconnect.events.len(), 2);
    assert_eq!(reconnect.events[0].event_id, "after");
    assert_eq!(reconnect.events[1].kind, AgentEventKind::AgentStopped);
    assert_eq!(reconnect.sessions.len(), 1);
    let repeated_reconnect = supervisor
        .reconnect(
            super::SUPERVISOR_PROTOCOL_VERSION,
            reconnect.current_sequence,
        )
        .expect("reconnect is idempotent");
    assert_eq!(
        repeated_reconnect.current_sequence,
        reconnect.current_sequence
    );
    assert!(repeated_reconnect.events.is_empty());
}

#[test]
fn supervisor_reports_protocol_and_resume_failures_with_stable_codes() {
    let root = tempfile::tempdir().expect("temp dir");
    let supervisor = super::Supervisor::new(
        root.path().to_path_buf(),
        PtyManager::new(),
        EventHub::new(8),
    );
    let protocol = supervisor.reconnect(99, 0).expect_err("protocol mismatch");
    assert_eq!(
        serde_json::to_value(protocol).expect("serialize error")["code"],
        "protocol_mismatch"
    );
    let missing = supervisor
        .resume("missing", std::sync::Arc::new(MemoryEventSink::default()))
        .expect_err("missing session");
    assert_eq!(
        serde_json::to_value(missing).expect("serialize error")["code"],
        "missing_session"
    );
}

#[test]
fn ownership_ledger_round_trips_atomically_and_replaces_records() {
    let root = tempfile::tempdir().expect("temp dir");
    let ledger = OwnershipLedger::new(root.path().to_path_buf());
    let first = RuntimeOwnershipRecord {
        session_id: "session-1".into(),
        agent_id: "agent-1".into(),
        project_id: "project-1".into(),
        terminal_id: "terminal-1".into(),
        worktree_path: Some("D:/worktrees/agent-1".into()),
        process: ProcessIdentity {
            pid: 1001,
            start_time: 2002,
            executable: "C:/Windows/System32/cmd.exe".into(),
        },
        recorded_at: "2026-09-11T10:00:00Z".into(),
    };
    ledger.record(first.clone()).expect("record ownership");

    let mut replacement = first.clone();
    replacement.process.pid = 1002;
    ledger.record(replacement.clone()).expect("replace ownership");

    let records = ledger.records().expect("load ownership");
    assert_eq!(records, vec![replacement]);
    let path = root.path().join("control/runtime-ownership.json");
    assert!(path.is_file());
    assert!(!root.path().join("control/runtime-ownership.json.tmp").exists());
    let encoded = std::fs::read_to_string(path).expect("read ownership");
    assert!(!encoded.contains("environment"));
    assert!(!encoded.contains("token"));
    assert!(!encoded.contains("cookie"));
    assert!(!encoded.contains("command"));

    ledger.remove("session-1").expect("remove ownership");
    assert!(ledger.records().expect("load after removal").is_empty());
}

#[test]
fn ownership_ledger_rejects_future_schema_versions() {
    let root = tempfile::tempdir().expect("temp dir");
    let ledger = OwnershipLedger::new(root.path().to_path_buf());
    let directory = root.path().join("control");
    std::fs::create_dir_all(&directory).expect("control dir");
    std::fs::write(
        directory.join("runtime-ownership.json"),
        r#"{"schemaVersion":99,"records":[]}"#,
    )
    .expect("write future ownership schema");

    let error = ledger.records().expect_err("future schema must fail");
    assert_eq!(error.code(), "unsupported_ownership_schema");
}

#[cfg(windows)]
#[test]
fn reconcile_ownership_stops_an_exact_orphan_process() {
    let root = tempfile::tempdir().expect("temp dir");
    let mut child = Command::new("cmd.exe")
        .args(["/C", "timeout", "/T", "30", "/NOBREAK", ">NUL"])
        .spawn()
        .expect("spawn orphan fixture");
    let identity = crate::pty::capture_process(child.id()).expect("capture process identity");
    let ledger = OwnershipLedger::new(root.path().to_path_buf());
    ledger
        .record(RuntimeOwnershipRecord {
            session_id: "orphan-session".into(),
            agent_id: "orphan-agent".into(),
            project_id: "project-1".into(),
            terminal_id: "orphan-terminal".into(),
            worktree_path: Some("D:/worktrees/orphan".into()),
            process: identity,
            recorded_at: "2026-09-11T10:00:00Z".into(),
        })
        .expect("record orphan ownership");
    let supervisor = super::Supervisor::new(
        root.path().to_path_buf(),
        PtyManager::new(),
        EventHub::new(8),
    );

    let report = supervisor.reconcile().expect("reconcile exact orphan");

    assert_eq!(report.stopped_owned_process_ids, vec![child.id().to_string()]);
    assert_eq!(
        report.orphaned_owned_process_ids,
        vec![child.id().to_string()]
    );
    assert_eq!(report.cleared_ownership_record_ids, vec!["orphan-session"]);
    assert!(child.try_wait().expect("wait orphan fixture").is_some());
    assert!(ledger.records().expect("read cleared ledger").is_empty());
}

#[cfg(windows)]
#[test]
fn reconcile_ownership_retains_a_pid_with_a_different_creation_time() {
    let root = tempfile::tempdir().expect("temp dir");
    let mut child = Command::new("cmd.exe")
        .args(["/C", "timeout", "/T", "30", "/NOBREAK", ">NUL"])
        .spawn()
        .expect("spawn mismatch fixture");
    let mut identity = crate::pty::capture_process(child.id()).expect("capture process identity");
    identity.start_time += 1;
    let ledger = OwnershipLedger::new(root.path().to_path_buf());
    ledger
        .record(RuntimeOwnershipRecord {
            session_id: "mismatch-session".into(),
            agent_id: "mismatch-agent".into(),
            project_id: "project-1".into(),
            terminal_id: "mismatch-terminal".into(),
            worktree_path: None,
            process: identity,
            recorded_at: "2026-09-11T10:00:00Z".into(),
        })
        .expect("record mismatch ownership");
    let supervisor = super::Supervisor::new(
        root.path().to_path_buf(),
        PtyManager::new(),
        EventHub::new(8),
    );

    let report = supervisor.reconcile().expect("reconcile mismatch");

    assert!(report.stopped_owned_process_ids.is_empty());
    assert!(report.orphaned_owned_process_ids.is_empty());
    assert_eq!(report.unknown_process_ids, vec![child.id().to_string()]);
    assert_eq!(ledger.records().expect("read retained ledger").len(), 1);
    assert!(child.try_wait().expect("poll mismatch fixture").is_none());
    child.kill().expect("clean mismatch fixture");
    child.wait().expect("reap mismatch fixture");
}

#[test]
fn supervisor_shutdown_clears_current_records_but_retains_unrelated_records() {
    use crate::agents::{Agent, AgentStatus};

    let root = tempfile::tempdir().expect("temp dir");
    let pty = PtyManager::new();
    let terminal = pty
        .create_shell(
            Some(root.path().to_string_lossy().as_ref()),
            MemoryEventSink::default(),
        )
        .expect("create current runtime terminal");
    let supervisor = super::Supervisor::new(root.path().to_path_buf(), pty.clone(), EventHub::new(8));
    supervisor
        .register_agent(
            &Agent {
                id: "current-agent".into(),
                name: "Current agent".into(),
                provider: "shell".into(),
                terminal_id: terminal.id.clone(),
                cwd: terminal.cwd.clone(),
                branch: String::new(),
                worktree_path: None,
                status: AgentStatus::Running,
                error: None,
            },
            "project-1".into(),
            supervisor.runtime_sink(Arc::new(MemoryEventSink::default())),
        )
        .expect("register current runtime");
    let ledger = OwnershipLedger::new(root.path().to_path_buf());
    ledger
        .record(RuntimeOwnershipRecord {
            session_id: "unrelated-session".into(),
            agent_id: "unrelated-agent".into(),
            project_id: "project-2".into(),
            terminal_id: "unrelated-terminal".into(),
            worktree_path: None,
            process: ProcessIdentity {
                pid: 4,
                start_time: 1,
                executable: "C:/unknown.exe".into(),
            },
            recorded_at: "2026-09-11T10:00:00Z".into(),
        })
        .expect("record unrelated ownership");

    supervisor.shutdown().expect("shutdown supervisor");

    let records = ledger.records().expect("read post-shutdown ledger");
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].session_id, "unrelated-session");
    pty.kill(&terminal.id).expect("stop current runtime terminal");
}

#[test]
fn reconciliation_marks_restored_sessions_offline_without_stopping_unknown_processes() {
    let root = tempfile::tempdir().expect("temp dir");
    let store = SnapshotStore::new(root.path().to_path_buf());
    let missing_worktree = root.path().join("missing-worktree");
    let mut snapshot = ProjectSnapshot::empty("project-1".into());
    snapshot.agents.push(json!({
        "descriptor": {
            "sessionId": "session-offline",
            "projectId": "project-1",
            "agentId": "agent-offline",
            "providerId": "cursor-agent",
            "terminalId": "missing-terminal",
            "worktreePath": missing_worktree.to_string_lossy(),
            "resume": null,
            "attached": false
        },
        "scrollback": ""
    }));
    store.save_atomic(&snapshot).expect("save snapshot");
    let hub = EventHub::new(8);
    let supervisor =
        super::Supervisor::new(root.path().to_path_buf(), PtyManager::new(), hub.clone());
    supervisor.restore_project("project-1").expect("restore");

    let report = supervisor.reconcile().expect("reconcile");
    assert_eq!(report.offline_session_ids, vec!["session-offline"]);
    assert_eq!(
        report.retained_missing_worktrees,
        vec![missing_worktree.to_string_lossy().to_string()]
    );
    assert!(report.stopped_owned_process_ids.is_empty());
    assert!(hub
        .subscribe_after(0)
        .iter()
        .any(|event| event.kind == AgentEventKind::AgentStopped));
}

#[test]
fn reconciliation_detaches_live_sessions_with_missing_worktrees_without_killing_the_pty() {
    use crate::agents::{Agent, AgentStatus};

    let root = tempfile::tempdir().expect("temp dir");
    let missing_worktree = root.path().join("missing-live-worktree");
    let pty = PtyManager::new();
    let terminal = pty
        .create_shell(
            Some(root.path().to_string_lossy().as_ref()),
            MemoryEventSink::default(),
        )
        .expect("create live terminal");
    let supervisor = super::Supervisor::new(
        root.path().to_path_buf(),
        pty.clone(),
        EventHub::new(8),
    );
    let agent = Agent {
        id: "agent-live".into(),
        name: "Live agent".into(),
        provider: "shell".into(),
        terminal_id: terminal.id.clone(),
        cwd: root.path().to_string_lossy().into_owned(),
        branch: "main".into(),
        worktree_path: Some(missing_worktree.to_string_lossy().into_owned()),
        status: AgentStatus::Running,
        error: None,
    };
    supervisor
        .register_agent(
            &agent,
            "project-1".into(),
            supervisor.runtime_sink(Arc::new(MemoryEventSink::default())),
        )
        .expect("register agent");

    let report = supervisor.reconcile().expect("reconcile");

    assert_eq!(report.offline_session_ids, vec!["agent-live"]);
    assert_eq!(
        report.retained_missing_worktrees,
        vec![missing_worktree.to_string_lossy().to_string()]
    );
    assert_eq!(
        pty.session_status(&terminal.id).expect("terminal status"),
        TerminalStatus::Running
    );
    pty.kill(&terminal.id).expect("kill test terminal");
}

#[test]
fn checkpoint_discovers_a_real_provider_resume_marker_from_bounded_scrollback() {
    use crate::agents::{Agent, AgentStatus};
    use crate::pty::{EventSink, TerminalOutputEvent};
    let root = tempfile::tempdir().expect("temp dir");
    let supervisor = super::Supervisor::new(
        root.path().to_path_buf(),
        PtyManager::new(),
        EventHub::new(8),
    );
    let runtime_sink = supervisor.runtime_sink(std::sync::Arc::new(MemoryEventSink::default()));
    runtime_sink.emit_output(TerminalOutputEvent {
        terminal_id: "terminal-1".into(),
        data: "OpenAI Codex ready\r\nSession ID: exact-session-42\r\n".into(),
    });
    supervisor
        .register_agent(
            &Agent {
                id: "agent-1".into(),
                name: "Codex".into(),
                provider: "codex".into(),
                terminal_id: "terminal-1".into(),
                cwd: "D:/project".into(),
                branch: String::new(),
                worktree_path: None,
                status: AgentStatus::Running,
                error: None,
            },
            "project-1".into(),
            runtime_sink,
        )
        .expect("register runtime");

    let snapshot = supervisor
        .checkpoint("project-1", serde_json::Value::Null, Vec::new(), None, 0)
        .expect("checkpoint");
    assert_eq!(
        snapshot.agents[0]["descriptor"]["resume"]["providerSessionId"],
        "exact-session-42"
    );
    assert_eq!(
        snapshot.agents[0]["descriptor"]["resume"]["workingDirectory"],
        "D:/project"
    );
}

#[test]
fn snapshot_store_round_trips_and_writes_schema_version() {
    let root = tempfile::tempdir().expect("temp dir");
    let store = SnapshotStore::new(root.path().to_path_buf());
    let snapshot = ProjectSnapshot::empty("project-1".into());

    store.save_atomic(&snapshot).expect("save snapshot");

    let loaded = store
        .load("project-1")
        .expect("load snapshot")
        .expect("snapshot exists");
    assert_eq!(loaded.schema_version, 1);
    assert_eq!(loaded.project_id, "project-1");
    assert!(!root
        .path()
        .join("control/projects/project-1/project.json.tmp")
        .exists());
}

#[test]
fn snapshot_store_preserves_unknown_fields_and_replaces_existing_snapshot() {
    let root = tempfile::tempdir().expect("temp dir");
    let store = SnapshotStore::new(root.path().to_path_buf());
    let mut snapshot = ProjectSnapshot::empty("project-1".into());
    snapshot.pane_tree = json!({ "type": "split", "ratio": 0.4 });
    store.save_atomic(&snapshot).expect("save first snapshot");

    snapshot.extensions.insert(
        "providerMetadata".into(),
        json!({ "resumeHint": "session-42" }),
    );
    store
        .save_atomic(&snapshot)
        .expect("replace existing snapshot");

    let loaded = store
        .load("project-1")
        .expect("load snapshot")
        .expect("snapshot exists");
    assert_eq!(loaded.pane_tree["type"], "split");
    assert_eq!(
        loaded.extensions["providerMetadata"]["resumeHint"],
        "session-42"
    );
}

#[test]
fn snapshot_store_rejects_future_schema_versions_with_a_stable_error() {
    let root = tempfile::tempdir().expect("temp dir");
    let path = root.path().join("control/projects/project-1");
    std::fs::create_dir_all(&path).expect("create project snapshot directory");
    std::fs::write(
        path.join("project.json"),
        br#"{"schemaVersion":2,"projectId":"project-1"}"#,
    )
    .expect("write future snapshot");
    let store = SnapshotStore::new(root.path().to_path_buf());

    let error = store.load("project-1").expect_err("reject future schema");

    assert!(matches!(
        error,
        SnapshotStoreError::UnsupportedSchemaVersion {
            found: 2,
            supported: 1
        }
    ));
    assert_eq!(error.code(), "unsupported_snapshot_schema");
}

#[test]
fn snapshot_store_loads_missing_as_none_and_deletes_project_data() {
    let root = tempfile::tempdir().expect("temp dir");
    let store = SnapshotStore::new(root.path().to_path_buf());
    assert!(store
        .load("project-1")
        .expect("load missing snapshot")
        .is_none());

    store
        .save_atomic(&ProjectSnapshot::empty("project-1".into()))
        .expect("save snapshot");
    store.delete_project("project-1").expect("delete project");

    assert!(store
        .load("project-1")
        .expect("load deleted snapshot")
        .is_none());
    assert!(!root.path().join("control/projects/project-1").exists());
}

#[test]
fn snapshot_store_safely_maps_repository_paths_without_changing_project_identity() {
    let root = tempfile::tempdir().expect("temp dir");
    let store = SnapshotStore::new(root.path().to_path_buf());
    let project_id = r"D:\work\taxzy";
    store
        .save_atomic(&ProjectSnapshot::empty(project_id.into()))
        .expect("save path project");
    let loaded = store
        .load(project_id)
        .expect("load path project")
        .expect("snapshot");
    assert_eq!(loaded.project_id, project_id);
    assert!(!root.path().join("work").exists());
    store
        .delete_project(project_id)
        .expect("delete path project");
    assert!(store.load(project_id).expect("load deleted").is_none());
}

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
        (AgentEventKind::AgentMessageQueued, "agent_message_queued"),
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
            AgentEventKind::BrowserCommandStarted,
            "browser_command_started",
        ),
        (
            AgentEventKind::BrowserCommandCompleted,
            "browser_command_completed",
        ),
        (
            AgentEventKind::BrowserCommandFailed,
            "browser_command_failed",
        ),
        (AgentEventKind::TaxchatRoomStarted, "taxchat_room_started"),
        (
            AgentEventKind::TaxchatMessageQueued,
            "taxchat_message_queued",
        ),
        (
            AgentEventKind::TaxchatMessageDelivered,
            "taxchat_message_delivered",
        ),
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
        (
            AgentEventPayload::Taxchat {
                message_id: "message-2".into(),
                body: "Review the release".into(),
                recipient_ids: vec!["agent-1".into()],
                queued_ids: vec![],
                delivered_ids: vec!["agent-1".into()],
                failed_ids: vec![],
            },
            json!({
                "type": "taxchat",
                "messageId": "message-2",
                "body": "Review the release",
                "recipientIds": ["agent-1"],
                "queuedIds": [],
                "deliveredIds": ["agent-1"],
                "failedIds": [],
            }),
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
            None,
            AgentEventKind::AgentStarted,
            AgentEventPayload::Empty,
        ),
        (
            TerminalStatus::Exited,
            Some(42),
            AgentEventKind::AgentExited,
            AgentEventPayload::Exit { code: Some(42) },
        ),
        (
            TerminalStatus::Killed,
            None,
            AgentEventKind::AgentExited,
            AgentEventPayload::Exit { code: None },
        ),
        (
            TerminalStatus::Failed,
            None,
            AgentEventKind::AgentFailed,
            AgentEventPayload::Attention {
                reason: "PTY reader stopped unexpectedly".into(),
            },
        ),
    ];

    for (status, exit_code, expected_kind, expected_payload) in cases {
        let event = PtyManager::agent_status_event(
            "project-1",
            "agent-1",
            &TerminalStatusEvent {
                terminal_id: "terminal-1".into(),
                status,
                exit_code,
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
fn public_attention_ack_emits_one_scoped_control_event() {
    let sink = MemoryEventSink::default();
    let identity = CallerIdentity {
        caller_id: "agent-1".into(),
        project_id: "project-1".into(),
        agent_id: Some("agent-1".into()),
        parent_agent_id: None,
        capabilities: vec![Capability::AttentionAck],
        expires_at: None,
    };

    super::service::publish_runtime_attention_ack(&sink, &identity, "project-1", "agent-2")
        .expect("acknowledge attention");

    let events = sink.control_events();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].kind, AgentEventKind::AttentionAck);
    assert_eq!(events[0].agent_id.as_deref(), Some("agent-2"));
    assert_eq!(events[0].source, AgentEventSource::Api);
    let error =
        super::service::publish_runtime_attention_ack(&sink, &identity, "project-2", "agent-2")
            .expect_err("cross-project acknowledgement must fail");
    assert_eq!(error.code, super::ControlErrorCode::CapabilityDenied);
    assert_eq!(sink.control_events().len(), 1);
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

#[derive(Default)]
struct FakeTeamBackend {
    active: AtomicUsize,
    fail_launch: std::sync::atomic::AtomicBool,
    fail_delivery: std::sync::atomic::AtomicBool,
    delivery_hook: std::sync::Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    launches: std::sync::Mutex<Vec<super::team::ChildLaunch>>,
    deliveries: std::sync::Mutex<Vec<(String, String)>>,
    aborts: std::sync::Mutex<Vec<String>>,
    cleanups: std::sync::Mutex<Vec<(String, String)>>,
    events: std::sync::Mutex<Vec<AgentEventEnvelope>>,
}

impl super::team::TeamBackend for FakeTeamBackend {
    fn active_agent_count(&self, _project_id: &str) -> Result<usize, super::ControlError> {
        Ok(self.active.load(Ordering::SeqCst))
    }

    fn agent_exists(&self, project_id: &str, agent_id: &str) -> Result<bool, super::ControlError> {
        Ok(project_id == "project-1" && agent_id == "parent-1")
    }

    fn recover_agent(
        &self,
        _project_id: &str,
        _agent_id: &str,
    ) -> Result<Option<super::TeamAgent>, super::ControlError> {
        Ok(None)
    }

    fn provider_installed(&self, provider_id: &str) -> bool {
        provider_id == "codex"
    }

    fn create_worktree(
        &self,
        _project_id: &str,
        _provider_id: &str,
    ) -> Result<super::team::PreparedWorktree, super::ControlError> {
        Ok(super::team::PreparedWorktree {
            branch: "codex/child".into(),
            path: r"D:\repo.worktrees\child".into(),
        })
    }

    fn launch_child(
        &self,
        launch: super::team::ChildLaunch,
    ) -> Result<crate::agents::Agent, super::ControlError> {
        self.launches.lock().unwrap().push(launch.clone());
        if self.fail_launch.load(Ordering::SeqCst) {
            return Err(super::ControlError::new(
                super::ControlErrorCode::ControlRuntimeError,
                "launch failed",
            ));
        }
        Ok(crate::agents::Agent {
            id: launch.agent_id,
            name: launch.name,
            provider: launch.provider_id,
            terminal_id: "terminal-child".into(),
            cwd: launch.worktree.path.clone(),
            branch: launch.worktree.branch,
            worktree_path: Some(launch.worktree.path),
            status: crate::agents::AgentStatus::Running,
            error: None,
        })
    }

    fn deliver(&self, terminal_id: &str, body: &str) -> Result<(), super::ControlError> {
        if self.fail_delivery.swap(false, Ordering::SeqCst) {
            if let Some(hook) = self.delivery_hook.lock().unwrap().clone() {
                hook();
            }
            return Err(super::ControlError::new(
                super::ControlErrorCode::ControlRuntimeError,
                "delivery failed",
            ));
        }
        self.deliveries
            .lock()
            .unwrap()
            .push((terminal_id.into(), body.into()));
        if let Some(hook) = self.delivery_hook.lock().unwrap().clone() {
            hook();
        }
        Ok(())
    }

    fn read(&self, _agent_id: &str) -> Result<(String, String), super::ControlError> {
        Ok(("running".into(), "output".into()))
    }

    fn stop(&self, _agent_id: &str) -> Result<(), super::ControlError> {
        Ok(())
    }

    fn abort(&self, agent_id: &str) -> Result<(), super::ControlError> {
        self.aborts.lock().unwrap().push(agent_id.into());
        Ok(())
    }

    fn cleanup_worktree(&self, project_id: &str, path: &str) -> Result<(), super::ControlError> {
        self.cleanups
            .lock()
            .unwrap()
            .push((project_id.into(), path.into()));
        Ok(())
    }

    fn emit(&self, event: AgentEventEnvelope) {
        self.events.lock().unwrap().push(event);
    }
}

fn team_spawn_request() -> super::team::SpawnAgentRequest {
    super::team::SpawnAgentRequest {
        project_id: "project-1".into(),
        parent_agent_id: Some("parent-1".into()),
        provider_id: "codex".into(),
        task: "Run the focused tests".into(),
        name: Some("Test child".into()),
    }
}

#[test]
fn team_spawn_creates_scoped_child_and_delivers_initial_task() {
    let backend = Arc::new(FakeTeamBackend::default());
    let coordinator = super::TeamCoordinator::new(
        backend.clone(),
        Arc::new(CapabilityTokenStore::default()),
        r"\\.\pipe\zli-test".into(),
    )
    .with_control_executable(Some(std::path::PathBuf::from(
        r"C:\Program Files\Taxzy\zli.exe",
    )));

    let child = coordinator
        .spawn(team_spawn_request())
        .expect("spawn child");

    assert_eq!(child.parent_agent_id.as_deref(), Some("parent-1"));
    assert_eq!(child.worktree_path, r"D:\repo.worktrees\child");
    let launches = backend.launches.lock().unwrap();
    let launch = launches.first().expect("captured launch");
    assert_eq!(
        launch
            .environment
            .get(std::ffi::OsStr::new("ZLI_PROJECT_ID"))
            .unwrap(),
        "project-1"
    );
    assert_eq!(
        launch
            .environment
            .get(std::ffi::OsStr::new("ZLI_PARENT_AGENT_ID"))
            .unwrap(),
        "parent-1"
    );
    assert!(!launch
        .environment
        .get(std::ffi::OsStr::new("ZLI_CONTROL_TOKEN"))
        .unwrap()
        .is_empty());
    assert_eq!(
        launch
            .environment
            .get(std::ffi::OsStr::new("ZLI_COMMAND"))
            .unwrap(),
        r"C:\Program Files\Taxzy\zli.exe"
    );
    assert_eq!(
        launch
            .environment
            .get(std::ffi::OsStr::new("ZLI_BROWSER_PROFILE"))
            .unwrap(),
        "clean"
    );
    assert_eq!(
        launch
            .environment
            .get(std::ffi::OsStr::new("ZLI_BROWSER_SESSION"))
            .unwrap(),
        child.agent_id.as_str()
    );
    assert_eq!(
        launch
            .environment
            .get(std::ffi::OsStr::new("ZLI_BROWSER_USE_COMMAND"))
            .unwrap(),
        r"C:\Program Files\Taxzy\zli-browser-use.exe"
    );
    assert!(std::env::split_paths(
        launch
            .environment
            .get(std::ffi::OsStr::new("PATH"))
            .unwrap()
    )
    .next()
    .is_some_and(|path| path == std::path::Path::new(r"C:\Program Files\Taxzy")));
    drop(launches);
    assert_eq!(
        backend.deliveries.lock().unwrap().as_slice(),
        &[("terminal-child".into(), "Run the focused tests".into())]
    );
    let events = backend.events.lock().unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].kind, AgentEventKind::AgentStarted);
    assert_eq!(events[0].parent_agent_id.as_deref(), Some("parent-1"));
}

#[test]
fn child_spawn_scope_cannot_reparent_delegated_work() {
    let identity = CallerIdentity {
        caller_id: "child-1".into(),
        project_id: "project-1".into(),
        agent_id: Some("child-1".into()),
        parent_agent_id: Some("parent-1".into()),
        capabilities: vec![Capability::AgentSpawn],
        expires_at: None,
    };
    let mut request = team_spawn_request();
    request.parent_agent_id = Some("sibling-1".into());

    let error = super::service::apply_spawn_scope(&mut request, &identity)
        .expect_err("a child cannot reparent a spawned agent");
    assert_eq!(error.code, super::ControlErrorCode::CapabilityDenied);

    request.parent_agent_id = None;
    super::service::apply_spawn_scope(&mut request, &identity).expect("default child parent");
    assert_eq!(request.parent_agent_id.as_deref(), Some("child-1"));
}

#[test]
fn team_spawn_enforces_the_twelve_agent_project_cap() {
    let backend = Arc::new(FakeTeamBackend::default());
    backend.active.store(12, Ordering::SeqCst);
    let coordinator = super::TeamCoordinator::new(
        backend,
        Arc::new(CapabilityTokenStore::default()),
        "endpoint".into(),
    );

    let error = coordinator
        .spawn(team_spawn_request())
        .expect_err("cap must reject");
    assert_eq!(error.code, super::ControlErrorCode::AgentLimitReached);
}

#[test]
fn managed_agent_browser_capability_reports_safe_fallback_without_credentials() {
    let backend = Arc::new(FakeTeamBackend::default());
    let coordinator = super::TeamCoordinator::new(
        backend,
        Arc::new(CapabilityTokenStore::default()),
        r"\\.\pipe\zli-test".into(),
    )
    .with_control_executable(Some(std::path::PathBuf::from(
        r"C:\Program Files\Taxzy\zli.exe",
    )));

    let child = coordinator
        .spawn(team_spawn_request())
        .expect("spawn child");
    let capability = coordinator
        .browser_capability("project-1", &child.agent_id)
        .expect("browser capability");

    assert_eq!(capability.profile_id, "clean");
    assert!(capability.shell_fallback_available);
    assert!(!capability.mcp_provider_configured);
    assert_eq!(capability.mode, "shell_fallback");
    let serialized = serde_json::to_string(&capability).expect("serialize capability");
    assert!(!serialized.contains("ZLI_CONTROL_TOKEN"));
}

#[test]
fn supervisor_agent_slot_reservation_is_atomic_per_project() {
    let root = tempdir().expect("temporary supervisor directory");
    let supervisor = Arc::new(super::Supervisor::new(
        root.path().to_path_buf(),
        PtyManager::new(),
        EventHub::new(8),
    ));
    let barrier = Arc::new(std::sync::Barrier::new(16));
    let handles = (0..16)
        .map(|_| {
            let supervisor = supervisor.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                supervisor
                    .reserve_agent_slot("project-1")
                    .expect("reserve slot")
            })
        })
        .collect::<Vec<_>>();
    let reserved = handles
        .into_iter()
        .map(|handle| handle.join().expect("slot thread"))
        .filter(|reserved| *reserved)
        .count();
    assert_eq!(reserved, super::team::MAX_TEAM_AGENTS);
    assert!(!supervisor
        .reserve_agent_slot("project-1")
        .expect("check full project"));
    assert!(supervisor
        .reserve_agent_slot("project-2")
        .expect("reserve another project"));
}

#[test]
fn supervisor_health_reports_capacity_and_event_persistence_without_reconciliation() {
    let root = tempdir().expect("temporary supervisor directory");
    let events = EventHub::new(8);
    events
        .enable_persistence(root.path().join("events"))
        .expect("enable event persistence");
    events.publish(test_event("health-event"));
    let supervisor = super::Supervisor::new(root.path().to_path_buf(), PtyManager::new(), events);
    assert!(supervisor
        .reserve_agent_slot("project-1")
        .expect("reserve launch slot"));

    let project_health = supervisor
        .health(Some("project-1"))
        .expect("project health");
    assert_eq!(project_health.project_id.as_deref(), Some("project-1"));
    assert_eq!(project_health.active_agents, 0);
    assert_eq!(project_health.reserved_agent_slots, 1);
    assert_eq!(project_health.available_agent_slots, Some(11));
    assert_eq!(project_health.event_hub.retained_events, 1);
    assert_eq!(project_health.event_hub.current_sequence, 1);
    assert!(project_health.event_hub.enabled);
    assert!(project_health.event_hub.healthy);

    let global_health = supervisor.health(None).expect("global health");
    assert_eq!(global_health.reserved_agent_slots, 1);
    assert_eq!(global_health.available_agent_slots, None);
}

#[test]
fn team_spawn_rolls_back_worktree_when_launch_fails() {
    let backend = Arc::new(FakeTeamBackend::default());
    backend.fail_launch.store(true, Ordering::SeqCst);
    let coordinator = super::TeamCoordinator::new(
        backend.clone(),
        Arc::new(CapabilityTokenStore::default()),
        "endpoint".into(),
    );

    coordinator
        .spawn(team_spawn_request())
        .expect_err("launch must fail");

    assert_eq!(
        backend.cleanups.lock().unwrap().as_slice(),
        &[("project-1".into(), r"D:\repo.worktrees\child".into())]
    );
    assert!(backend.deliveries.lock().unwrap().is_empty());
}

#[test]
fn event_hub_restores_durable_lifecycle_history_and_sequence_after_restart() {
    let root = tempdir().expect("temporary event log directory");
    let first = EventHub::new(8);
    first
        .enable_persistence(root.path())
        .expect("enable event persistence");

    let output = first.publish(test_event("output")).expect("publish output");
    let started = first
        .publish(AgentEventEnvelope::new(
            "started".into(),
            "project-1".into(),
            Some("agent-1".into()),
            AgentEventKind::AgentStarted,
            AgentEventPayload::Empty,
        ))
        .expect("publish lifecycle event");
    assert_eq!(output.sequence, 1);
    assert_eq!(started.sequence, 2);

    drop(first);
    let second = EventHub::new(8);
    second
        .enable_persistence(root.path())
        .expect("restore event persistence");

    assert_eq!(second.latest_sequence(), 2);
    let replay = second.subscribe_after(0);
    assert_eq!(
        replay
            .iter()
            .map(|event| event.event_id.as_str())
            .collect::<Vec<_>>(),
        vec!["output", "started"]
    );
    assert_eq!(replay[0].payload, AgentEventPayload::Empty);
    let next = second
        .publish(AgentEventEnvelope::new(
            "completed".into(),
            "project-1".into(),
            Some("agent-1".into()),
            AgentEventKind::AgentCompleted,
            AgentEventPayload::Empty,
        ))
        .expect("publish after restart");
    assert_eq!(next.sequence, 3);
}

#[test]
fn event_hub_durable_output_markers_preserve_sequence_when_output_follows_lifecycle() {
    let root = tempdir().expect("temporary event log directory");
    let first = EventHub::new(8);
    first
        .enable_persistence(root.path())
        .expect("enable event persistence");
    first
        .publish(AgentEventEnvelope::new(
            "started".into(),
            "project-1".into(),
            Some("agent-1".into()),
            AgentEventKind::AgentStarted,
            AgentEventPayload::Empty,
        ))
        .expect("publish lifecycle event");
    for event_id in ["output-1", "output-2", "output-3"] {
        first
            .publish(test_event(event_id))
            .expect("publish output event");
    }
    drop(first);

    let second = EventHub::new(8);
    second
        .enable_persistence(root.path())
        .expect("restore event persistence");
    assert_eq!(second.latest_sequence(), 4);
    let next = second
        .publish(AgentEventEnvelope::new(
            "completed".into(),
            "project-1".into(),
            Some("agent-1".into()),
            AgentEventKind::AgentCompleted,
            AgentEventPayload::Empty,
        ))
        .expect("publish after output-only tail");
    assert_eq!(next.sequence, 5);
}

#[test]
fn event_hub_compacts_durable_history_to_its_replay_capacity() {
    let root = tempdir().expect("temporary event log directory");
    let first = EventHub::new(2);
    first
        .enable_persistence(root.path())
        .expect("enable event persistence");
    for (event_id, kind) in [
        ("started", AgentEventKind::AgentStarted),
        ("completed", AgentEventKind::AgentCompleted),
        ("failed", AgentEventKind::AgentFailed),
    ] {
        first
            .publish(AgentEventEnvelope::new(
                event_id.into(),
                "project-1".into(),
                Some("agent-1".into()),
                kind,
                AgentEventPayload::Empty,
            ))
            .expect("publish event");
    }
    drop(first);

    let second = EventHub::new(2);
    second
        .enable_persistence(root.path())
        .expect("restore compacted event log");
    assert_eq!(
        second
            .subscribe_after(0)
            .iter()
            .map(|event| event.event_id.as_str())
            .collect::<Vec<_>>(),
        vec!["completed", "failed"]
    );
    assert_eq!(second.latest_sequence(), 3);
}

#[test]
fn team_spawn_aborts_the_session_when_initial_delivery_fails() {
    let backend = Arc::new(FakeTeamBackend::default());
    backend.fail_delivery.store(true, Ordering::SeqCst);
    let coordinator = super::TeamCoordinator::new(
        backend.clone(),
        Arc::new(CapabilityTokenStore::default()),
        "endpoint".into(),
    );

    coordinator
        .spawn(team_spawn_request())
        .expect_err("initial delivery must fail");

    assert_eq!(backend.aborts.lock().unwrap().len(), 1);
    assert_eq!(backend.cleanups.lock().unwrap().len(), 1);
}

#[test]
fn child_exit_during_initial_delivery_does_not_leave_coordination_state() {
    let backend = Arc::new(FakeTeamBackend::default());
    let tokens = Arc::new(CapabilityTokenStore::default());
    let coordinator = Arc::new(super::TeamCoordinator::new(
        backend.clone(),
        tokens.clone(),
        "endpoint".into(),
    ));
    let coordinator_for_hook = coordinator.clone();
    let backend_for_hook = backend.clone();
    *backend.delivery_hook.lock().unwrap() = Some(Arc::new(move || {
        let agent_id = backend_for_hook.launches.lock().unwrap().last().unwrap().agent_id.clone();
        coordinator_for_hook.handle_event(&AgentEventEnvelope::new(
            "startup-exit".into(),
            "project-1".into(),
            Some(agent_id),
            AgentEventKind::AgentExited,
            AgentEventPayload::Exit { code: Some(1) },
        ));
    }));

    let child = coordinator.spawn(team_spawn_request()).expect("spawn child");
    let token = backend.launches.lock().unwrap()[0]
        .environment
        .get(std::ffi::OsStr::new("ZLI_CONTROL_TOKEN"))
        .unwrap()
        .to_string_lossy()
        .into_owned();

    assert!(coordinator
        .list("project-1")
        .expect("list team agents")
        .is_empty());
    assert!(tokens.verify(&token).is_err());
    assert_eq!(child.project_id, "project-1");
}

#[test]
fn team_stop_revokes_the_child_control_token() {
    let backend = Arc::new(FakeTeamBackend::default());
    let tokens = Arc::new(CapabilityTokenStore::default());
    let coordinator =
        super::TeamCoordinator::new(backend.clone(), tokens.clone(), "endpoint".into());
    let child = coordinator
        .spawn(team_spawn_request())
        .expect("spawn child");
    let token = backend.launches.lock().unwrap()[0]
        .environment
        .get(std::ffi::OsStr::new("ZLI_CONTROL_TOKEN"))
        .unwrap()
        .to_string_lossy()
        .into_owned();
    assert!(tokens.verify(&token).is_ok());

    coordinator
        .stop("project-1", &child.agent_id)
        .expect("stop child");

    assert!(tokens.verify(&token).is_err());
}

#[test]
fn team_stop_removes_the_agent_from_coordination_registry() {
    let backend = Arc::new(FakeTeamBackend::default());
    let coordinator = super::TeamCoordinator::new(
        backend,
        Arc::new(CapabilityTokenStore::default()),
        "endpoint".into(),
    );
    let child = coordinator
        .spawn(team_spawn_request())
        .expect("spawn child");

    coordinator
        .stop("project-1", &child.agent_id)
        .expect("stop child");

    assert!(coordinator
        .list("project-1")
        .expect("list team agents")
        .is_empty());
    let error = coordinator
        .send("project-1", &child.agent_id, "This must not be delivered")
        .expect_err("stopped agent must not accept new work");
    assert_eq!(error.code, super::ControlErrorCode::SessionNotFound);
}

#[test]
fn runtime_team_stop_accepts_an_already_removed_agent() {
    let root = tempfile::tempdir().expect("temporary directory");
    let pty = PtyManager::new();
    let supervisor = Arc::new(super::Supervisor::new(
        root.path().to_path_buf(),
        pty.clone(),
        EventHub::new(8),
    ));
    let backend = super::team::RuntimeTeamBackend::new(
        pty,
        crate::agents::AgentManager::new(),
        supervisor,
        Arc::new(MemoryEventSink::default()),
    );

    super::team::TeamBackend::stop(&backend, "already-removed")
        .expect("stopping an already removed agent should be idempotent");
}

#[test]
fn stopping_agent_fails_and_removes_queued_messages() {
    let backend = Arc::new(FakeTeamBackend::default());
    let coordinator = super::TeamCoordinator::new(
        backend.clone(),
        Arc::new(CapabilityTokenStore::default()),
        "endpoint".into(),
    );
    let child = coordinator
        .spawn(team_spawn_request())
        .expect("spawn child");
    backend.events.lock().unwrap().clear();

    coordinator
        .send("project-1", &child.agent_id, "This should be reported")
        .expect("queue message");
    coordinator
        .stop("project-1", &child.agent_id)
        .expect("stop child");

    assert!(coordinator
        .queue_status(Some("project-1"))
        .expect("read queue status")
        .is_empty());
    let events = backend.events.lock().unwrap();
    assert!(events
        .iter()
        .any(|event| event.kind == AgentEventKind::AgentMessageFailed));
    assert!(events
        .iter()
        .any(|event| event.kind == AgentEventKind::AgentStopped));
}

#[test]
fn exited_agent_is_removed_from_coordination_and_cannot_keep_its_child_token() {
    let backend = Arc::new(FakeTeamBackend::default());
    let tokens = Arc::new(CapabilityTokenStore::default());
    let coordinator = super::TeamCoordinator::new(backend.clone(), tokens.clone(), "endpoint".into());
    let child = coordinator
        .spawn(team_spawn_request())
        .expect("spawn child");
    let token = backend.launches.lock().unwrap()[0]
        .environment
        .get(std::ffi::OsStr::new("ZLI_CONTROL_TOKEN"))
        .unwrap()
        .to_string_lossy()
        .into_owned();

    coordinator.handle_event(&AgentEventEnvelope::new(
        "agent-exit-cleanup".into(),
        "project-1".into(),
        Some(child.agent_id.clone()),
        AgentEventKind::AgentExited,
        AgentEventPayload::Exit { code: Some(1) },
    ));

    assert!(coordinator
        .list("project-1")
        .expect("list team agents")
        .is_empty());
    assert!(tokens.verify(&token).is_err());
}

#[test]
fn team_message_queue_is_parent_child_scoped_and_not_written_early() {
    let backend = Arc::new(FakeTeamBackend::default());
    let coordinator = super::TeamCoordinator::new(
        backend.clone(),
        Arc::new(CapabilityTokenStore::default()),
        "endpoint".into(),
    );
    let child = coordinator
        .spawn(team_spawn_request())
        .expect("spawn child");

    let result = coordinator
        .send("project-1", &child.agent_id, "Report status")
        .expect("deliver message");

    assert_eq!(result["queued"], true);
    assert_eq!(backend.deliveries.lock().unwrap().len(), 1);
    assert_eq!(
        backend.events.lock().unwrap().last().unwrap().kind,
        AgentEventKind::AgentMessageQueued
    );
    let error = coordinator
        .send("project-2", &child.agent_id, "Cross project")
        .expect_err("cross-project delivery must fail");
    assert_eq!(error.code, super::ControlErrorCode::SessionNotFound);
    assert_eq!(backend.deliveries.lock().unwrap().len(), 1);
}

#[test]
fn pending_agent_messages_survive_coordinator_restart() {
    use super::team::{AgentMessageInbox, QueuedAgentMessage, QueuedAgentMessageKind};

    let root = tempfile::tempdir().expect("temporary directory");
    let store = SnapshotStore::new(root.path().to_path_buf());
    let inbox = AgentMessageInbox::with_store(store.clone()).expect("create persistent inbox");
    inbox
        .enqueue(QueuedAgentMessage {
            message_id: "message-1".into(),
            project_id: "project-1".into(),
            agent_id: "agent-1".into(),
            terminal_id: "terminal-1".into(),
            body: "Run the focused tests".into(),
            kind: QueuedAgentMessageKind::Agent,
        })
        .expect("persist message");
    inbox
        .enqueue(QueuedAgentMessage {
            message_id: "message-2".into(),
            project_id: "project-1".into(),
            agent_id: "agent-1".into(),
            terminal_id: "terminal-1".into(),
            body: "Review the release".into(),
            kind: QueuedAgentMessageKind::Taxchat {
                message_id: "message-2".into(),
                sender_agent_id: Some("agent-parent".into()),
                body: "Review the release".into(),
                recipient_ids: vec!["agent-1".into()],
            },
        })
        .expect("persist TaxChat message");
    drop(inbox);

    let restored = AgentMessageInbox::with_store(store.clone()).expect("restore inbox");
    assert_eq!(restored.pending_count("agent-1"), 2);
    let message = restored
        .take_next("agent-1")
        .expect("begin delivery")
        .expect("message exists");
    assert_eq!(message.message_id, "message-1");
    drop(restored);

    let replayed = AgentMessageInbox::with_store(store.clone()).expect("replay in-flight message");
    assert_eq!(replayed.pending_count("agent-1"), 2);
    let replay = replayed
        .take_next("agent-1")
        .expect("begin replay")
        .expect("message exists");
    assert_eq!(replay.message_id, "message-1");
    replayed
        .ack("agent-1", "message-1")
        .expect("acknowledge replay");
    let taxchat = replayed
        .take_next("agent-1")
        .expect("begin TaxChat delivery")
        .expect("TaxChat message exists");
    assert!(matches!(
        taxchat.kind,
        QueuedAgentMessageKind::Taxchat {
            message_id,
            sender_agent_id: Some(_),
            recipient_ids,
            ..
        } if message_id == "message-2" && recipient_ids == vec!["agent-1"]
    ));
    replayed
        .ack("agent-1", "message-2")
        .expect("acknowledge TaxChat delivery");

    let empty = AgentMessageInbox::with_store(store).expect("reload acknowledged inbox");
    assert_eq!(empty.pending_count("agent-1"), 0);
}

#[test]
fn team_message_waits_for_a_provider_prompt_before_writing_to_the_pty() {
    let backend = Arc::new(FakeTeamBackend::default());
    let coordinator = super::TeamCoordinator::new(
        backend.clone(),
        Arc::new(CapabilityTokenStore::default()),
        "endpoint".into(),
    );
    let child = coordinator
        .spawn(team_spawn_request())
        .expect("spawn child");
    backend.deliveries.lock().unwrap().clear();
    backend.events.lock().unwrap().clear();

    let result = coordinator
        .send("project-1", &child.agent_id, "Report status")
        .expect("queue message");

    assert_eq!(result["queued"], true);
    assert!(backend.deliveries.lock().unwrap().is_empty());
    assert_eq!(
        backend.events.lock().unwrap().last().unwrap().kind,
        AgentEventKind::AgentMessageQueued
    );

    let mut prompt = AgentEventEnvelope::new(
        "prompt-1".into(),
        "project-1".into(),
        Some(child.agent_id.clone()),
        AgentEventKind::AgentPromptDetected,
        AgentEventPayload::Attention {
            reason: "provider_prompt".into(),
        },
    );
    prompt.source = AgentEventSource::Provider;
    coordinator.handle_event(&prompt);

    assert_eq!(
        backend.deliveries.lock().unwrap().as_slice(),
        &[("terminal-child".into(), "Report status".into())]
    );
    assert_eq!(
        backend.events.lock().unwrap().last().unwrap().kind,
        AgentEventKind::AgentMessageDelivered
    );
}

#[test]
fn failed_agent_message_stays_queued_until_a_later_prompt() {
    let backend = Arc::new(FakeTeamBackend::default());
    let coordinator = super::TeamCoordinator::new(
        backend.clone(),
        Arc::new(CapabilityTokenStore::default()),
        "endpoint".into(),
    );
    let child = coordinator
        .spawn(team_spawn_request())
        .expect("spawn child");
    backend.deliveries.lock().unwrap().clear();
    backend.events.lock().unwrap().clear();
    backend.fail_delivery.store(true, Ordering::SeqCst);

    coordinator
        .send("project-1", &child.agent_id, "Do not lose this")
        .expect("queue message");

    let mut failed_prompt = AgentEventEnvelope::new(
        "failed-delivery-prompt".into(),
        "project-1".into(),
        Some(child.agent_id.clone()),
        AgentEventKind::AgentPromptDetected,
        AgentEventPayload::Attention {
            reason: "provider_prompt".into(),
        },
    );
    failed_prompt.source = AgentEventSource::Provider;
    coordinator.handle_event(&failed_prompt);

    let status = coordinator
        .queue_status(Some("project-1"))
        .expect("read queue status")
        .into_iter()
        .find(|status| status.agent_id == child.agent_id)
        .expect("agent queue status");
    assert_eq!(status.pending_count, 1);
    assert_eq!(status.in_flight_count, 0);
    assert!(backend.deliveries.lock().unwrap().is_empty());

    let mut retry_prompt = failed_prompt;
    retry_prompt.event_id = "retry-delivery-prompt".into();
    coordinator.handle_event(&retry_prompt);

    assert_eq!(
        backend.deliveries.lock().unwrap().as_slice(),
        &[("terminal-child".into(), "Do not lose this".into())]
    );
    assert_eq!(
        backend.events.lock().unwrap().last().unwrap().kind,
        AgentEventKind::AgentMessageDelivered
    );
}

#[test]
fn delivered_message_retries_acknowledgement_before_next_delivery() {
    let root = tempdir().expect("temporary directory");
    let backend = Arc::new(FakeTeamBackend::default());
    let coordinator = super::TeamCoordinator::new(
        backend.clone(),
        Arc::new(CapabilityTokenStore::default()),
        "endpoint".into(),
    )
    .with_message_store(SnapshotStore::new(root.path().to_path_buf()))
    .expect("create persistent coordinator");
    let child = coordinator
        .spawn(team_spawn_request())
        .expect("spawn child");
    backend.deliveries.lock().unwrap().clear();
    backend.events.lock().unwrap().clear();

    coordinator
        .send("project-1", &child.agent_id, "First message")
        .expect("queue first message");
    coordinator
        .send("project-1", &child.agent_id, "Second message")
        .expect("queue second message");

    let queue_path = root.path().join("control").join("pending-messages.json");
    let failure_path = queue_path.clone();
    *backend.delivery_hook.lock().unwrap() = Some(Arc::new(move || {
        std::fs::remove_file(&failure_path).expect("remove queue file");
        std::fs::create_dir(&failure_path).expect("block queue replacement");
    }));

    let mut prompt = AgentEventEnvelope::new(
        "ack-failure-prompt".into(),
        "project-1".into(),
        Some(child.agent_id.clone()),
        AgentEventKind::AgentPromptDetected,
        AgentEventPayload::Attention {
            reason: "provider_prompt".into(),
        },
    );
    prompt.source = AgentEventSource::Provider;
    coordinator.handle_event(&prompt);

    assert_eq!(
        backend.deliveries.lock().unwrap().as_slice(),
        &[("terminal-child".into(), "First message".into())]
    );
    assert_eq!(
        coordinator
            .queue_status(Some("project-1"))
            .expect("read queue status")
            .into_iter()
            .find(|status| status.agent_id == child.agent_id)
            .expect("agent queue status")
            .in_flight_count,
        1
    );

    std::fs::remove_dir(&queue_path).expect("restore queue path");
    *backend.delivery_hook.lock().unwrap() = None;
    prompt.event_id = "ack-retry-prompt".into();
    coordinator.handle_event(&prompt);

    assert_eq!(
        backend.deliveries.lock().unwrap().as_slice(),
        &[
            ("terminal-child".into(), "First message".into()),
            ("terminal-child".into(), "Second message".into()),
        ]
    );
    assert_eq!(
        backend
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|event| event.kind == AgentEventKind::AgentMessageDelivered)
            .count(),
        2
    );
}

#[test]
fn failed_delivery_retries_requeue_before_reporting_failure() {
    let root = tempdir().expect("temporary directory");
    let backend = Arc::new(FakeTeamBackend::default());
    let coordinator = super::TeamCoordinator::new(
        backend.clone(),
        Arc::new(CapabilityTokenStore::default()),
        "endpoint".into(),
    )
    .with_message_store(SnapshotStore::new(root.path().to_path_buf()))
    .expect("create persistent coordinator");
    let child = coordinator
        .spawn(team_spawn_request())
        .expect("spawn child");
    backend.deliveries.lock().unwrap().clear();
    backend.events.lock().unwrap().clear();

    coordinator
        .send("project-1", &child.agent_id, "Retry this delivery")
        .expect("queue message");
    backend.fail_delivery.store(true, Ordering::SeqCst);

    let queue_path = root.path().join("control").join("pending-messages.json");
    let failure_path = queue_path.clone();
    *backend.delivery_hook.lock().unwrap() = Some(Arc::new(move || {
        std::fs::remove_file(&failure_path).expect("remove queue file");
        std::fs::create_dir(&failure_path).expect("block queue replacement");
    }));

    let mut prompt = AgentEventEnvelope::new(
        "requeue-failure-prompt".into(),
        "project-1".into(),
        Some(child.agent_id.clone()),
        AgentEventKind::AgentPromptDetected,
        AgentEventPayload::Attention {
            reason: "provider_prompt".into(),
        },
    );
    prompt.source = AgentEventSource::Provider;
    coordinator.handle_event(&prompt);

    assert!(backend.events.lock().unwrap().iter().all(|event| {
        event.kind != AgentEventKind::AgentMessageFailed
    }));
    assert_eq!(
        coordinator
            .queue_status(Some("project-1"))
            .expect("read queue status")
            .into_iter()
            .find(|status| status.agent_id == child.agent_id)
            .expect("agent queue status")
            .in_flight_count,
        1
    );

    std::fs::remove_dir(&queue_path).expect("restore queue path");
    *backend.delivery_hook.lock().unwrap() = None;
    prompt.event_id = "requeue-retry-prompt".into();
    coordinator.handle_event(&prompt);

    assert_eq!(
        backend.deliveries.lock().unwrap().as_slice(),
        &[("terminal-child".into(), "Retry this delivery".into())]
    );
    assert_eq!(
        backend.events.lock().unwrap().last().unwrap().kind,
        AgentEventKind::AgentMessageDelivered
    );
}

#[test]
fn agent_message_inbox_is_fifo_and_bounded_per_agent() {
    let inbox = super::team::AgentMessageInbox::default();
    for index in 0..64 {
        inbox
            .enqueue(super::team::QueuedAgentMessage {
                message_id: format!("message-{index}"),
                project_id: "project-1".into(),
                agent_id: "agent-1".into(),
                terminal_id: "terminal-1".into(),
                body: format!("body-{index}"),
                kind: super::team::QueuedAgentMessageKind::Agent,
            })
            .expect("message should fit in the inbox");
    }
    let error = inbox
        .enqueue(super::team::QueuedAgentMessage {
            message_id: "overflow".into(),
            project_id: "project-1".into(),
            agent_id: "agent-1".into(),
            terminal_id: "terminal-1".into(),
            body: "overflow".into(),
            kind: super::team::QueuedAgentMessageKind::Agent,
        })
        .expect_err("the per-agent inbox must be bounded");

    assert_eq!(error.code, super::ControlErrorCode::AgentInboxFull);
    assert_eq!(inbox.pending_count("agent-1"), 64);
    assert_eq!(inbox.take_next("agent-1").unwrap().unwrap().body, "body-0");
    inbox.ack("agent-1", "message-0").unwrap();
    assert_eq!(inbox.take_next("agent-1").unwrap().unwrap().body, "body-1");
}

#[test]
fn agent_queue_status_is_project_scoped_and_body_free() {
    let inbox = super::team::AgentMessageInbox::default();
    for (project_id, agent_id, message_id) in [
        ("project-1", "agent-1", "message-1"),
        ("project-1", "agent-1", "message-2"),
        ("project-2", "agent-2", "message-3"),
    ] {
        inbox
            .enqueue(super::team::QueuedAgentMessage {
                message_id: message_id.into(),
                project_id: project_id.into(),
                agent_id: agent_id.into(),
                terminal_id: "terminal-1".into(),
                body: "private coordination details".into(),
                kind: super::team::QueuedAgentMessageKind::Agent,
            })
            .expect("message should fit in the inbox");
    }
    inbox
        .take_next("agent-1")
        .expect("start delivery")
        .expect("message exists");

    let scoped = inbox
        .queue_status(Some("project-1"))
        .expect("read scoped queue status");
    assert_eq!(scoped.len(), 1);
    assert_eq!(scoped[0].project_id, "project-1");
    assert_eq!(scoped[0].agent_id, "agent-1");
    assert_eq!(scoped[0].pending_count, 1);
    assert_eq!(scoped[0].in_flight_count, 1);
    assert_eq!(scoped[0].oldest_message_id.as_deref(), Some("message-1"));
    assert!(serde_json::to_value(&scoped[0])
        .expect("serialize queue status")
        .get("body")
        .is_none());

    let all = inbox.queue_status(None).expect("read all queue status");
    assert_eq!(all.len(), 2);
}

#[test]
fn taxchat_delivery_is_project_scoped_bounded_and_evented() {
    let backend = Arc::new(FakeTeamBackend::default());
    let coordinator = super::TeamCoordinator::new(
        backend.clone(),
        Arc::new(CapabilityTokenStore::default()),
        "endpoint".into(),
    );
    let child = coordinator
        .spawn(team_spawn_request())
        .expect("spawn child");
    backend.deliveries.lock().unwrap().clear();

    let result = coordinator
        .send_taxchat(
            "project-1",
            Some("parent-1"),
            "Review the release",
            std::slice::from_ref(&child.agent_id),
        )
        .expect("send TaxChat message");

    assert_eq!(result["queuedIds"], json!([child.agent_id]));
    assert_eq!(result["deliveredIds"], json!([]));
    assert_eq!(result["failedIds"], json!([]));
    let deliveries = backend.deliveries.lock().unwrap();
    assert!(deliveries.is_empty());
    drop(deliveries);
    let queued = backend.events.lock().unwrap().last().cloned().unwrap();
    assert_eq!(queued.kind, AgentEventKind::TaxchatMessageQueued);
    assert_eq!(queued.source, AgentEventSource::Taxchat);

    let mut prompt = AgentEventEnvelope::new(
        "taxchat-prompt-1".into(),
        "project-1".into(),
        Some(child.agent_id.clone()),
        AgentEventKind::AgentPromptDetected,
        AgentEventPayload::Attention {
            reason: "provider_prompt".into(),
        },
    );
    prompt.source = AgentEventSource::Provider;
    coordinator.handle_event(&prompt);

    let deliveries = backend.deliveries.lock().unwrap();
    assert_eq!(deliveries.len(), 1);
    assert!(deliveries[0].1.contains("[TaxChat delivery]"));
    assert!(deliveries[0].1.contains("Review the release"));
    drop(deliveries);
    let delivered = backend.events.lock().unwrap().last().cloned().unwrap();
    assert_eq!(delivered.kind, AgentEventKind::TaxchatMessageDelivered);
    assert_eq!(delivered.source, AgentEventSource::Taxchat);
}

#[test]
fn queued_taxchat_message_is_failed_when_recipient_exits() {
    let backend = Arc::new(FakeTeamBackend::default());
    let coordinator = super::TeamCoordinator::new(
        backend.clone(),
        Arc::new(CapabilityTokenStore::default()),
        "endpoint".into(),
    );
    let child = coordinator
        .spawn(team_spawn_request())
        .expect("spawn child");
    backend.deliveries.lock().unwrap().clear();
    backend.events.lock().unwrap().clear();

    coordinator
        .send_taxchat(
            "project-1",
            None,
            "Do not lose this message",
            std::slice::from_ref(&child.agent_id),
        )
        .expect("queue TaxChat message");

    let exited = AgentEventEnvelope::new(
        "taxchat-exit-1".into(),
        "project-1".into(),
        Some(child.agent_id.clone()),
        AgentEventKind::AgentExited,
        AgentEventPayload::Exit { code: Some(1) },
    );
    coordinator.handle_event(&exited);

    assert!(backend.deliveries.lock().unwrap().is_empty());
    let event = backend.events.lock().unwrap().last().cloned().unwrap();
    assert_eq!(event.kind, AgentEventKind::TaxchatMessageFailed);
    match event.payload {
        AgentEventPayload::Taxchat { failed_ids, .. } => {
            assert_eq!(failed_ids, vec![child.agent_id]);
        }
        payload => panic!("unexpected payload: {payload:?}"),
    }
}

#[test]
fn exited_agent_cleanup_retries_before_a_later_prompt_can_deliver() {
    let backend = Arc::new(FakeTeamBackend::default());
    let coordinator = super::TeamCoordinator::new(
        backend.clone(),
        Arc::new(CapabilityTokenStore::default()),
        "endpoint".into(),
    );
    let child = coordinator
        .spawn(team_spawn_request())
        .expect("spawn child");
    backend.deliveries.lock().unwrap().clear();
    backend.events.lock().unwrap().clear();

    coordinator
        .send("project-1", &child.agent_id, "Do not deliver after exit")
        .expect("queue message");
    coordinator.fail_next_inbox_persist();

    let exited = AgentEventEnvelope::new(
        "exit-retry-1".into(),
        "project-1".into(),
        Some(child.agent_id.clone()),
        AgentEventKind::AgentExited,
        AgentEventPayload::Exit { code: Some(1) },
    );
    coordinator.handle_event(&exited);

    assert!(coordinator
        .queue_status(Some("project-1"))
        .expect("queue status retries cleanup")
        .is_empty());

    let prompt = AgentEventEnvelope::new(
        "exit-retry-prompt".into(),
        "project-1".into(),
        Some(child.agent_id.clone()),
        AgentEventKind::AgentPromptDetected,
        AgentEventPayload::Attention {
            reason: "provider_prompt".into(),
        },
    );
    coordinator.handle_event(&prompt);

    assert!(backend.deliveries.lock().unwrap().is_empty());
    assert!(coordinator
        .queue_status(Some("project-1"))
        .expect("queue status")
        .is_empty());
    assert!(backend
        .events
        .lock()
        .unwrap()
        .iter()
        .any(|event| event.kind == AgentEventKind::AgentMessageFailed));
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
