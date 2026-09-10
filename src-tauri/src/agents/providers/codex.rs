use super::*;
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
    fn parse_output(&self, output: &str) -> Vec<ProviderEvent> {
        common_output_events(output)
    }
    fn detect_resume(&self, output: &str, cwd: &Path) -> Option<ResumeDescriptor> {
        resume_from_marker(self.id(), output, cwd, "session id")
    }
    fn build_resume(
        &self,
        descriptor: &ResumeDescriptor,
    ) -> Result<Option<LaunchPlan>, BackendError> {
        let mut arguments = super::super::runtime_codex_compatibility_args(self.id());
        arguments.push(OsString::from("resume"));
        resume_plan(self, descriptor, arguments)
    }
    fn resume_support(&self) -> ResumeSupport {
        ResumeSupport::Supported
    }
}
