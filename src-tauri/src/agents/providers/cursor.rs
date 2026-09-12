use super::*;
use crate::system::find_executable;
use std::path::{Path, PathBuf};

pub const CURSOR_CANDIDATES: &[&str] = &[
    "cursor-agent",
    "cursor-agent.exe",
    "cursor-agent.cmd",
    "cursor-agent.ps1",
];

pub const CURSOR_ALIAS: &[&str] = &["agent", "agent.exe", "agent.cmd", "agent.ps1"];

pub struct CursorAdapter;
impl ProviderAdapter for CursorAdapter {
    fn id(&self) -> &'static str {
        "cursor-agent"
    }
    fn display_name(&self) -> &'static str {
        "Cursor Agent"
    }
    fn candidates(&self) -> &'static [&'static str] {
        CURSOR_CANDIDATES
    }
    fn detect_installation(&self) -> Option<PathBuf> {
        if let Some(path) = find_executable(CURSOR_CANDIDATES) {
            return Some(path);
        }
        let alias = find_executable(CURSOR_ALIAS)?;
        match probe_cursor_identity(&alias) {
            IdentityVerdict::Verified { path, .. } => Some(path),
            _ => None,
        }
    }
    fn build_launch(&self, request: &ProviderLaunchRequest) -> Result<LaunchPlan, BackendError> {
        base_launch_plan(self.id(), request, CURSOR_CANDIDATES, Vec::new())
    }
    fn resume_support(&self) -> ResumeSupport {
        ResumeSupport::Unsupported
    }
    fn delivery_kind(&self) -> DeliveryKind {
        DeliveryKind::ExplicitPull
    }
    fn verify_executable(&self, path: &Path) -> IdentityVerdict {
        if path_looks_like_cursor_agent(path) {
            named_cursor_identity(path)
        } else if path_looks_like_agent_alias(path) {
            probe_cursor_identity(path)
        } else {
            IdentityVerdict::Rejected {
                path: path.to_path_buf(),
                reason: "executable is not Cursor Agent".into(),
            }
        }
    }
}
