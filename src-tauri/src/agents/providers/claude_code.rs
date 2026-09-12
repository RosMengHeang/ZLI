use super::*;
use std::path::Path;

const CANDIDATES: &[&str] = &["claude", "claude.exe", "claude.cmd", "claude.ps1"];
pub struct ClaudeCodeAdapter;
impl ProviderAdapter for ClaudeCodeAdapter {
    fn id(&self) -> &'static str {
        "claude-code"
    }
    fn display_name(&self) -> &'static str {
        "Claude Code"
    }
    fn candidates(&self) -> &'static [&'static str] {
        CANDIDATES
    }
    fn build_launch(&self, request: &ProviderLaunchRequest) -> Result<LaunchPlan, BackendError> {
        base_launch_plan(self.id(), request, CANDIDATES, Vec::new())
    }
    fn probe_resume(&self, output: &str, cwd: &Path) -> ResumeProbe {
        let _ = cwd;
        parse_session_id(output)
    }
    fn build_resume(
        &self,
        record: &ResumeRecord,
        cwd: &Path,
    ) -> Result<Option<LaunchPlan>, BackendError> {
        resume_plan_from_record(self, record, cwd, [OsString::from("--resume")])
    }
    fn resume_support(&self) -> ResumeSupport {
        ResumeSupport::Supported
    }
    fn delivery_kind(&self) -> DeliveryKind {
        DeliveryKind::MintedSlots
    }
}
