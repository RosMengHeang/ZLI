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

fn resume_descriptor(provider_id: &str) -> ResumeDescriptor {
    ResumeDescriptor {
        provider_id: provider_id.to_owned(),
        provider_session_id: Some("session-1".to_owned()),
        resume_command_kind: Some("session_id".to_owned()),
        working_directory: PathBuf::from("D:/project"),
        last_checkpoint_at: None,
        availability: ResumeAvailability::Available,
    }
}

#[test]
fn every_registered_provider_has_a_launch_plan_and_explicit_resume_support() {
    for adapter in ProviderRegistry::default().all() {
        let plan = adapter
            .build_launch(&launch_request(adapter.id()))
            .expect("launch plan");
        assert!(!plan.program.as_os_str().is_empty());
        let resume = adapter
            .build_resume(&resume_descriptor(adapter.id()))
            .expect("resume result");
        assert!(resume.is_some() || adapter.resume_support() == ResumeSupport::Unsupported);
    }
}

#[test]
fn provider_fixtures_emit_lifecycle_events_and_honest_resume_descriptors() {
    let registry = ProviderRegistry::default();
    let fixtures = [
        ("claude-code", include_str!("fixtures/claude-code.txt")),
        ("codex", include_str!("fixtures/codex.txt")),
        ("cursor-agent", include_str!("fixtures/cursor-agent.txt")),
        ("opencode", include_str!("fixtures/opencode.txt")),
    ];
    for (provider_id, fixture) in fixtures {
        let adapter = registry.get(provider_id).expect("registered provider");
        let events = adapter.parse_output(fixture);
        assert!(events.contains(&ProviderEvent::Started));
        assert!(events.contains(&ProviderEvent::Completed));
        if matches!(provider_id, "claude-code" | "codex") {
            assert!(events.contains(&ProviderEvent::Waiting));
            let descriptor = adapter
                .detect_resume(fixture, Path::new("D:/project"))
                .expect("supported resume marker");
            assert_eq!(descriptor.availability, ResumeAvailability::Available);
            assert!(descriptor.provider_session_id.is_some());
        } else {
            assert_eq!(adapter.resume_support(), ResumeSupport::Unsupported);
            assert!(adapter
                .detect_resume(fixture, Path::new("D:/project"))
                .is_none());
        }
    }
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
