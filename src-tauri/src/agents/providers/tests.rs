use super::*;
use std::path::{Path, PathBuf};

fn launch_request(provider_id: &str) -> ProviderLaunchRequest {
    ProviderLaunchRequest {
        provider_id: provider_id.to_owned(),
        cwd: PathBuf::from("D:/project"),
        executable: Some(PathBuf::from(format!("{provider_id}.exe"))),
        provider_session_hint: Some("session-1".to_owned()),
    }
}

fn available_resume(output: &str) -> ResumeRecord {
    ResumeRecord::from_probe(parse_session_id(output))
}

#[test]
fn every_registered_provider_has_a_launch_plan_and_explicit_resume_support() {
    for adapter in ProviderRegistry::default().all() {
        let plan = adapter
            .build_launch(&launch_request(adapter.id()))
            .expect("launch plan");
        assert!(!plan.program.as_os_str().is_empty());
        let resume = adapter
            .build_resume(
                &available_resume("session id: session-1-token\n"),
                Path::new("D:/project"),
            )
            .expect("resume result");
        assert!(resume.is_some() || adapter.resume_support() == ResumeSupport::Unsupported);
    }
}

#[test]
fn provider_fixtures_probe_resume_without_parse_output() {
    let registry = ProviderRegistry::default();
    let fixtures = [
        ("claude-code", include_str!("fixtures/claude-code.txt")),
        ("codex", include_str!("fixtures/codex.txt")),
        ("cursor-agent", include_str!("fixtures/cursor-agent.txt")),
        ("opencode", include_str!("fixtures/opencode.txt")),
    ];
    for (provider_id, fixture) in fixtures {
        let adapter = registry.get(provider_id).expect("registered provider");
        if matches!(provider_id, "claude-code" | "codex") {
            let resume = ResumeRecord::from_probe(adapter.probe_resume(fixture, Path::new("D:/project")));
            match resume {
                ResumeRecord::Available { id, .. } => {
                    assert!(id.as_str().len() >= 8);
                }
                other => panic!("{provider_id} should parse a session id, got {other:?}"),
            }
            assert_eq!(adapter.delivery_kind(), DeliveryKind::MintedSlots);
        } else {
            assert_eq!(adapter.resume_support(), ResumeSupport::Unsupported);
            assert!(matches!(
                adapter.probe_resume(fixture, Path::new("D:/project")),
                ResumeProbe::Unsupported
            ));
            assert_eq!(adapter.delivery_kind(), DeliveryKind::ExplicitPull);
        }
    }
}

#[test]
fn capability_report_flags_are_independent_of_installation() {
    let registry = ProviderRegistry::default();
    let cursor = registry
        .capability_report("cursor-agent", true)
        .expect("cursor report");
    assert_eq!(cursor.delivery, DeliveryKind::ExplicitPull);
    assert!(!cursor.readiness_reliable);
    assert!(!cursor.acknowledgement_available);
    assert!(!cursor.exact_resume_available);
    assert!(!cursor.mcp_configured);
    assert!(cursor.shell_tools_available);
    assert_eq!(
        cursor.executable_verified,
        matches!(cursor.identity, IdentityVerdict::Verified { .. })
    );

    let codex = registry
        .capability_report("codex", false)
        .expect("codex report");
    assert_eq!(codex.delivery, DeliveryKind::MintedSlots);
    assert!(codex.readiness_reliable);
    assert!(codex.acknowledgement_available);
    assert!(codex.exact_resume_available);
    assert!(!codex.shell_tools_available);
}

#[test]
fn launch_plans_do_not_copy_the_parent_environment() {
    for adapter in ProviderRegistry::default().all() {
        let plan = adapter
            .build_launch(&launch_request(adapter.id()))
            .expect("launch plan");
        assert!(plan.environment.is_empty());
    }
}

#[test]
fn registry_preserves_existing_provider_ids_and_display_names() {
    let registry = ProviderRegistry::default();
    let registered = registry
        .all()
        .into_iter()
        .map(|adapter| (adapter.id(), adapter.display_name()))
        .collect::<Vec<_>>();
    let existing = super::super::provider_specs()
        .into_iter()
        .map(|provider| (provider.id, provider.display_name))
        .collect::<Vec<_>>();
    assert_eq!(registered, existing);
    assert_eq!(
        registry.get("claude").map(ProviderAdapter::id),
        Some("claude-code")
    );
    assert_eq!(
        registry.get("cursor").map(ProviderAdapter::id),
        Some("cursor-agent")
    );
}

#[test]
fn cursor_candidates_exclude_the_bare_agent_alias() {
    let adapter = CursorAdapter;
    assert!(adapter.candidates().contains(&"cursor-agent"));
    assert!(!adapter.candidates().iter().any(|name| *name == "agent"
        || *name == "agent.exe"
        || *name == "agent.cmd"
        || *name == "agent.ps1"));
}

#[test]
fn cursor_named_binary_is_verified_without_running_a_probe() {
    let path = PathBuf::from("D:/tools/cursor-agent.exe");
    assert!(matches!(
        CursorAdapter.verify_executable(&path),
        IdentityVerdict::Verified { product, .. } if product == "Cursor Agent"
    ));
}

#[cfg(windows)]
#[test]
fn cursor_alias_probe_rejects_an_unrelated_agent_script() {
    let directory = tempfile::tempdir().expect("temp dir");
    let path = directory.path().join("agent.cmd");
    std::fs::write(&path, "@echo Python 3.12\r\n").expect("write decoy");
    assert!(matches!(
        probe_cursor_identity(&path),
        IdentityVerdict::Rejected { .. }
    ));
}

#[cfg(windows)]
#[test]
fn cursor_alias_probe_accepts_cursor_agent_output() {
    let directory = tempfile::tempdir().expect("temp dir");
    let path = directory.path().join("agent.cmd");
    std::fs::write(&path, "@echo Cursor Agent 1.2.3\r\n").expect("write cursor alias");
    assert!(matches!(
        probe_cursor_identity(&path),
        IdentityVerdict::Verified { .. }
    ));
}
