use super::commands::{
    BrowserCapability, BrowserCommand, BrowserResult, BrowserWaitCondition, NavigationPhase,
    BROWSER_LIMITS,
};
use super::BrowserManager;
use crate::control::{
    AgentEventKind, AgentEventSource, CallerIdentity, Capability, ControlErrorCode,
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
