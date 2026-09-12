use super::*;

const CANDIDATES: &[&str] = &["opencode", "opencode.exe", "opencode.cmd", "opencode.ps1"];
pub struct OpenCodeAdapter;
impl ProviderAdapter for OpenCodeAdapter {
    fn id(&self) -> &'static str {
        "opencode"
    }
    fn display_name(&self) -> &'static str {
        "OpenCode"
    }
    fn candidates(&self) -> &'static [&'static str] {
        CANDIDATES
    }
    fn build_launch(&self, request: &ProviderLaunchRequest) -> Result<LaunchPlan, BackendError> {
        base_launch_plan(self.id(), request, CANDIDATES, Vec::new())
    }
    fn resume_support(&self) -> ResumeSupport {
        ResumeSupport::Unsupported
    }
    fn delivery_kind(&self) -> DeliveryKind {
        DeliveryKind::ExplicitPull
    }
}
