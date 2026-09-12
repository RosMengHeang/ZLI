use super::commands::{
    BrowserCapability, BrowserCommand, BrowserResult, BrowserWaitCondition, NavigationPhase,
    BROWSER_LIMITS,
};
use super::{BrowserExecutor, BrowserManager};
use crate::control::{
    AgentEventKind, AgentEventSource, CallerIdentity, Capability, ControlError, ControlErrorCode,
    ControlResponse, MAX_CONTROL_FRAME_BYTES,
};
use serde_json::json;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

fn identity(
    project_id: &str,
    agent_id: Option<&str>,
    capabilities: Vec<Capability>,
) -> CallerIdentity {
    CallerIdentity {
        caller_id: agent_id.unwrap_or("user").to_owned(),
        project_id: project_id.to_owned(),
        agent_id: agent_id.map(str::to_owned),
        parent_agent_id: None,
        capabilities,
        expires_at: None,
    }
}

fn snapshot(surface_id: &str) -> BrowserCommand {
    BrowserCommand::Snapshot {
        surface_id: surface_id.to_owned(),
        selector: None,
        max_depth: None,
    }
}

#[test]
fn browser_protocol_rejects_interaction_commands_without_a_surface() {
    let error = BrowserCommand::decode(json!({ "kind": "click", "selector": "#submit" }))
        .expect_err("surface is required");

    assert_eq!(error.code, ControlErrorCode::BrowserInvalidCommand);
    assert!(error.message.contains("surfaceId"));
}

#[test]
fn browser_protocol_limits_unsafe_urls_and_unbounded_commands() {
    for url in [
        "file:///C:/secret.txt",
        "javascript:alert(1)",
        "data:text/html,secret",
        "about:config",
        "https://user:password@example.com",
        "https://:",
    ] {
        assert!(BrowserCommand::decode(json!({ "kind": "open", "url": url })).is_err());
    }
    assert!(
        BrowserCommand::decode(json!({ "kind": "open", "url": "https://example.com" })).is_ok()
    );
    assert!(BrowserCommand::decode(json!({ "kind": "open", "url": "about:blank" })).is_ok());

    for command in [
        json!({ "kind": "click", "surfaceId": "surface-1", "selector": " " }),
        json!({ "kind": "press", "surfaceId": "surface-1", "key": "LaunchCalculator" }),
        json!({ "kind": "eval", "surfaceId": "surface-1", "script": "x".repeat(BROWSER_LIMITS.max_script_characters + 1) }),
        json!({ "kind": "snapshot", "surfaceId": "surface-1", "maxDepth": BROWSER_LIMITS.max_snapshot_depth + 1 }),
        json!({
            "kind": "wait",
            "surfaceId": "surface-1",
            "condition": { "kind": "selector", "selector": "#ready", "state": "visible" },
            "timeoutMs": BROWSER_LIMITS.max_command_timeout_ms + 1,
        }),
    ] {
        assert_eq!(
            BrowserCommand::decode(command)
                .expect_err("command must be bounded")
                .code,
            ControlErrorCode::BrowserInvalidCommand
        );
    }
}

#[test]
fn browser_protocol_uses_control_wire_names() {
    let wait = BrowserCommand::Wait {
        surface_id: "surface-1".into(),
        condition: BrowserWaitCondition::Selector {
            selector: "#ready".into(),
            state: Some(super::commands::SelectorState::Visible),
        },
        timeout_ms: 5_000,
    };
    assert_eq!(
        serde_json::to_value(wait).expect("serialize wait"),
        json!({
            "kind": "wait",
            "surfaceId": "surface-1",
            "condition": { "kind": "selector", "selector": "#ready", "state": "visible" },
            "timeoutMs": 5000,
        })
    );

    let results = [
        (
            BrowserResult::Surface {
                surface_id: "surface-1".into(),
                project_id: "project-1".into(),
                agent_id: None,
                url: "about:blank".into(),
                profile_id: "profile-1".into(),
            },
            "surface",
        ),
        (
            BrowserResult::Navigation {
                surface_id: "surface-1".into(),
                url: "https://example.com/".into(),
                phase: NavigationPhase::Finished,
            },
            "navigation",
        ),
        (
            BrowserResult::Action {
                surface_id: "surface-1".into(),
                action: super::commands::BrowserAction::Click,
            },
            "action",
        ),
        (
            BrowserResult::Evaluation {
                surface_id: "surface-1".into(),
                value: json!({ "ready": true }),
                truncated: false,
            },
            "evaluation",
        ),
        (
            BrowserResult::Snapshot {
                surface_id: "surface-1".into(),
                content: "<main />".into(),
                truncated: false,
            },
            "snapshot",
        ),
        (
            BrowserResult::ConsoleEntries {
                surface_id: "surface-1".into(),
                entries: vec![],
                truncated: false,
            },
            "consoleEntries",
        ),
        (
            BrowserResult::PageErrors {
                surface_id: "surface-1".into(),
                errors: vec![],
                truncated: false,
            },
            "pageErrors",
        ),
        (
            BrowserResult::Screenshot {
                surface_id: "surface-1".into(),
                data_url: "data:image/png;base64,AA==".into(),
                width: 1,
                height: 1,
            },
            "screenshot",
        ),
    ];
    for (result, kind) in results {
        assert_eq!(serde_json::to_value(result).unwrap()["kind"], kind);
    }
}

#[test]
fn browser_permissions_default_to_denied_and_are_command_specific() {
    let manager = BrowserManager::default();
    let surface = manager
        .register(
            "project-1",
            Some("agent-1".into()),
            "browser-panel-1",
            "about:blank",
            "profile-1",
        )
        .expect("register surface");
    let caller = identity(
        "project-1",
        Some("agent-1"),
        vec![Capability::BrowserRead, Capability::BrowserControl],
    );

    assert_eq!(
        manager
            .authorize(&caller, &surface.surface_id, &snapshot(&surface.surface_id))
            .expect_err("surface starts with no grants")
            .code,
        ControlErrorCode::BrowserPermissionRequired
    );
    manager
        .grant(&surface.surface_id, BrowserCapability::Read)
        .expect("grant read");
    assert!(manager
        .authorize(&caller, &surface.surface_id, &snapshot(&surface.surface_id))
        .is_ok());
    let click = BrowserCommand::Click {
        surface_id: surface.surface_id.clone(),
        selector: "#submit".into(),
    };
    assert_eq!(
        manager
            .authorize(&caller, &surface.surface_id, &click)
            .expect_err("read does not permit interaction")
            .code,
        ControlErrorCode::BrowserPermissionRequired
    );
}

#[test]
fn browser_authorization_rejects_cross_project_and_cross_agent_before_grants() {
    let manager = BrowserManager::default();
    let surface = manager
        .register(
            "project-2",
            Some("agent-2".into()),
            "browser-panel-2",
            "about:blank",
            "profile-2",
        )
        .expect("register surface");
    let command = snapshot(&surface.surface_id);

    for caller in [
        identity("project-1", Some("agent-2"), vec![Capability::BrowserRead]),
        identity("project-2", Some("agent-1"), vec![Capability::BrowserRead]),
    ] {
        assert_eq!(
            manager
                .authorize(&caller, &surface.surface_id, &command)
                .expect_err("foreign surfaces are forbidden")
                .code,
            ControlErrorCode::BrowserSurfaceForbidden
        );
    }
}

#[test]
fn browser_dispatch_enforces_deadlines_and_utf8_safe_output_limits() {
    let manager = BrowserManager::default();
    let surface = manager
        .register(
            "project-1",
            None,
            "browser-panel-1",
            "about:blank",
            "profile-1",
        )
        .expect("register surface");
    manager
        .grant(&surface.surface_id, BrowserCapability::Read)
        .expect("grant read");
    let caller = identity("project-1", None, vec![Capability::BrowserRead]);
    let command = snapshot(&surface.surface_id);

    let result = manager
        .dispatch(&caller, command.clone(), 1_000, |_, _| {
            Ok(BrowserResult::Snapshot {
                surface_id: surface.surface_id.clone(),
                content: "🙂".repeat(BROWSER_LIMITS.max_snapshot_characters + 1),
                truncated: false,
            })
        })
        .expect("bounded snapshot");
    let BrowserResult::Snapshot {
        content, truncated, ..
    } = result
    else {
        panic!("expected snapshot")
    };
    assert_eq!(
        content.chars().count(),
        BROWSER_LIMITS.max_snapshot_characters
    );
    assert!(truncated);

    let error = manager
        .dispatch(&caller, command, 100, |_, _| {
            thread::sleep(Duration::from_millis(110));
            Ok(BrowserResult::Snapshot {
                surface_id: surface.surface_id.clone(),
                content: String::new(),
                truncated: false,
            })
        })
        .expect_err("late command must fail");
    assert_eq!(error.code, ControlErrorCode::BrowserCommandTimeout);
}

#[test]
fn browser_events_are_project_scoped_and_do_not_expose_grants() {
    let events = Arc::new(Mutex::new(Vec::new()));
    let captured = events.clone();
    let manager = BrowserManager::new(Arc::new(move |event| {
        captured.lock().expect("events lock").push(event);
    }));
    let surface = manager
        .register(
            "project-1",
            Some("agent-1".into()),
            "browser-panel-1",
            "https://example.com",
            "profile-1",
        )
        .expect("register surface");
    manager
        .grant(&surface.surface_id, BrowserCapability::Read)
        .expect("grant read");

    let events = events.lock().expect("events lock");
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].project_id, "project-1");
    assert_eq!(events[0].agent_id.as_deref(), Some("agent-1"));
    assert_eq!(events[0].source, AgentEventSource::Browser);
    assert_eq!(events[0].kind, AgentEventKind::BrowserSurfaceCreated);
    assert!(!serde_json::to_string(&events[0])
        .expect("serialize event")
        .contains("browser.read"));
}

#[test]
fn browser_profile_grants_survive_surface_replacement_in_memory() {
    let manager = BrowserManager::default();
    let caller = identity("project-1", None, vec![Capability::BrowserControl]);
    let first = manager
        .register(
            "project-1",
            None,
            "browser-panel-1",
            "about:blank",
            "default",
        )
        .expect("register first surface");
    manager
        .grant(&first.surface_id, BrowserCapability::Control)
        .expect("grant browser control");
    manager
        .close(&first.surface_id)
        .expect("close first surface");
    manager
        .authorize_project(&caller, "project-1", BrowserCapability::Control)
        .expect("project profile stays granted");

    let replacement = manager
        .register(
            "project-1",
            None,
            "browser-panel-2",
            "https://example.com",
            "default",
        )
        .expect("register replacement");
    assert_eq!(replacement.capabilities, vec![BrowserCapability::Control]);
}

#[test]
fn browser_checkpoint_keeps_safe_state_and_drops_secrets() {
    let checkpoint = crate::control::persistence::sanitize_browser_checkpoint(json!({
        "surfaceId": "surface-1",
        "url": "https://localhost:3000",
        "open": true,
        "profileId": "default",
        "capabilities": ["browser.read", "browser.download"],
        "cookies": "secret-cookie",
        "storage": { "token": "secret-token" },
        "authorization": "Bearer secret",
    }))
    .expect("safe checkpoint");
    assert_eq!(checkpoint["url"], "https://localhost:3000");
    assert_eq!(checkpoint["capabilities"], json!(["browser.read"]));
    let encoded = serde_json::to_string(&checkpoint).expect("serialize checkpoint");
    assert!(!encoded.contains("secret"));
    assert!(!encoded.contains("cookie"));
    assert!(!encoded.contains("storage"));
    assert!(!encoded.contains("authorization"));
}

struct NoopExecutor;

impl BrowserExecutor for NoopExecutor {
    fn request_open(
        &self,
        _request_id: &str,
        _project_id: &str,
        _url: &str,
    ) -> Result<(), ControlError> {
        Ok(())
    }

    fn execute(
        &self,
        _webview_label: &str,
        _command: &BrowserCommand,
        _timeout: Duration,
    ) -> Result<BrowserResult, ControlError> {
        Err(ControlError::new(
            ControlErrorCode::MethodNotImplemented,
            "Noop executor does not run commands",
        ))
    }
}

struct NotifyExecutor {
    started: std::sync::mpsc::SyncSender<()>,
}

impl BrowserExecutor for NotifyExecutor {
    fn request_open(
        &self,
        _request_id: &str,
        _project_id: &str,
        _url: &str,
    ) -> Result<(), ControlError> {
        let _ = self.started.send(());
        Ok(())
    }

    fn execute(
        &self,
        _webview_label: &str,
        _command: &BrowserCommand,
        _timeout: Duration,
    ) -> Result<BrowserResult, ControlError> {
        Err(ControlError::new(
            ControlErrorCode::MethodNotImplemented,
            "Notify executor does not run commands",
        ))
    }
}

#[test]
fn browser_open_completes_by_request_id_after_redirect() {
    let manager = Arc::new(BrowserManager::default());
    let (started_tx, started_rx) = std::sync::mpsc::sync_channel(1);
    let waiter = {
        let manager = manager.clone();
        thread::spawn(move || {
            manager.open_and_wait(
                &NotifyExecutor {
                    started: started_tx,
                },
                "open-1",
                "project-1",
                "https://example.com/start",
                Duration::from_secs(2),
            )
        })
    };
    started_rx.recv_timeout(Duration::from_secs(1)).expect("open started");
    let surface = manager
        .register(
            "project-1",
            None,
            "browser-panel-1",
            "https://example.com/final",
            "clean",
        )
        .expect("register redirected surface");
    manager
        .bind_open("open-1", &surface.surface_id)
        .expect("bind open request");
    let opened = waiter.join().expect("open waiter").expect("open completed");
    assert_eq!(opened.surface_id, surface.surface_id);
    assert_eq!(opened.url, "https://example.com/final");
    assert_ne!(opened.url, "https://example.com/start");
}

#[test]
fn browser_open_inactive_project_returns_explicit_error() {
    let manager = Arc::new(BrowserManager::default());
    let (started_tx, started_rx) = std::sync::mpsc::sync_channel(1);
    let waiter = {
        let manager = manager.clone();
        thread::spawn(move || {
            manager.open_and_wait(
                &NotifyExecutor {
                    started: started_tx,
                },
                "open-inactive",
                "project-1",
                "https://example.com",
                Duration::from_secs(2),
            )
        })
    };
    started_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("open started");
    manager.reject_open(
        "open-inactive",
        ControlError::new(
            ControlErrorCode::BrowserProjectInactive,
            "The browser project is not the active workspace",
        ),
    );
    let error = waiter
        .join()
        .expect("open waiter")
        .expect_err("inactive project must fail");
    assert_eq!(error.code, ControlErrorCode::BrowserProjectInactive);
    assert_eq!(
        error.message,
        "The browser project is not the active workspace"
    );
}

#[test]
fn browser_open_returns_existing_surface_for_the_same_url() {
    let manager = BrowserManager::default();
    let existing = manager
        .register(
            "project-1",
            None,
            "browser-panel-1",
            "https://example.com/",
            "clean",
        )
        .expect("register");
    let opened = manager
        .open_and_wait(
            &NoopExecutor,
            "open-existing",
            "project-1",
            "https://example.com/",
            Duration::from_secs(1),
        )
        .expect("existing surface");
    assert_eq!(opened.surface_id, existing.surface_id);
}

#[test]
fn browser_dispatch_serializes_operations_on_one_surface() {
    let manager = Arc::new(BrowserManager::default());
    let surface = manager
        .register(
            "project-1",
            None,
            "browser-panel-1",
            "about:blank",
            "profile-1",
        )
        .expect("register");
    manager
        .grant(&surface.surface_id, BrowserCapability::Read)
        .expect("grant");
    let caller = identity("project-1", None, vec![Capability::BrowserRead]);
    let order = Arc::new(Mutex::new(Vec::new()));
    let first = {
        let manager = manager.clone();
        let caller = caller.clone();
        let command = snapshot(&surface.surface_id);
        let order = order.clone();
        thread::spawn(move || {
            manager.dispatch(&caller, command, 1_000, |_, _| {
                thread::sleep(Duration::from_millis(80));
                order.lock().expect("order").push(1);
                Ok(BrowserResult::Snapshot {
                    surface_id: "surface".into(),
                    content: String::new(),
                    truncated: false,
                })
            })
        })
    };
    thread::sleep(Duration::from_millis(20));
    let second = {
        let manager = manager.clone();
        let command = snapshot(&surface.surface_id);
        let order = order.clone();
        thread::spawn(move || {
            manager.dispatch(&caller, command, 1_000, |_, _| {
                order.lock().expect("order").push(2);
                Ok(BrowserResult::Snapshot {
                    surface_id: "surface".into(),
                    content: String::new(),
                    truncated: false,
                })
            })
        })
    };
    first.join().expect("first").expect("first dispatch");
    second.join().expect("second").expect("second dispatch");
    assert_eq!(*order.lock().expect("order"), vec![1, 2]);
}

#[test]
fn screenshot_at_character_limit_fits_the_control_frame() {
    let data_url = "a".repeat(BROWSER_LIMITS.max_screenshot_characters);
    let result = BrowserResult::Screenshot {
        surface_id: "surface-1".into(),
        data_url,
        width: 1,
        height: 1,
    };
    let response =
        ControlResponse::success("shot-1", serde_json::to_value(result).expect("encode result"));
    let encoded = serde_json::to_vec(&response).expect("encode envelope");
    assert!(encoded.len() <= MAX_CONTROL_FRAME_BYTES);
}
