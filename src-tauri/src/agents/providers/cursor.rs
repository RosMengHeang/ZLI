use super::*;
const CANDIDATES: &[&str] = &[
    "cursor-agent",
    "cursor-agent.exe",
    "cursor-agent.cmd",
    "agent",
    "agent.exe",
    "agent.cmd",
    "cursor-agent.ps1",
    "agent.ps1",
];
pub struct CursorAdapter;
impl ProviderAdapter for CursorAdapter {
    fn id(&self) -> &'static str {
        "cursor-agent"
    }
    fn display_name(&self) -> &'static str {
        "Cursor Agent"
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
    fn detect_resume(&self, _output: &str, _cwd: &Path) -> Option<ResumeDescriptor> {
        None
    }
    fn build_resume(
        &self,
        _descriptor: &ResumeDescriptor,
    ) -> Result<Option<LaunchPlan>, BackendError> {
        Ok(None)
    }
    fn resume_support(&self) -> ResumeSupport {
        ResumeSupport::Unsupported
    }
}
