use super::commands::{
    BrowserCommand, BrowserResult, BrowserWaitCondition, NavigationPhase, BROWSER_LIMITS,
};
use crate::control::ControlErrorCode;
use serde_json::json;

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
