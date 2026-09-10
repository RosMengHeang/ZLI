use super::*;
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
        resume_plan(self, descriptor, [OsString::from("--resume")])
    }
    fn resume_support(&self) -> ResumeSupport {
        ResumeSupport::Supported
    }
}
