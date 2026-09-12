use super::*;
use std::path::Path;

const CANDIDATES: &[&str] = &["codex", "codex.exe", "codex.cmd", "codex.ps1"];
pub struct CodexAdapter;
impl ProviderAdapter for CodexAdapter {
    fn id(&self) -> &'static str {
        "codex"
    }
    fn display_name(&self) -> &'static str {
        "Codex"
    }
    fn candidates(&self) -> &'static [&'static str] {
        CANDIDATES
    }
    fn build_launch(&self, request: &ProviderLaunchRequest) -> Result<LaunchPlan, BackendError> {
        base_launch_plan(
            self.id(),
            request,
            CANDIDATES,
            super::super::runtime_codex_compatibility_args(self.id()),
        )
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
        let mut arguments = super::super::runtime_codex_compatibility_args(self.id());
        arguments.push(OsString::from("resume"));
        resume_plan_from_record(self, record, cwd, arguments)
    }
    fn resume_support(&self) -> ResumeSupport {
        ResumeSupport::Supported
    }
    fn delivery_kind(&self) -> DeliveryKind {
        DeliveryKind::MintedSlots
    }
}
