mod claude_code;
mod codex;
mod contract;
mod cursor;
mod opencode;

use crate::error::BackendError;
use crate::system::find_executable;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub use claude_code::ClaudeCodeAdapter;
pub use codex::CodexAdapter;
pub use contract::{
    named_cursor_identity, parse_session_id, path_looks_like_agent_alias,
    path_looks_like_cursor_agent, probe_cursor_identity, provider_contract_flags, DeliveryKind,
    IdentityVerdict, ParsedSessionId, ProviderCapabilityReport, ProviderContractFlags, ResumeProbe,
    ResumeRecord, SessionProvenance,
};
pub use cursor::{CursorAdapter, CURSOR_ALIAS, CURSOR_CANDIDATES};
pub use opencode::OpenCodeAdapter;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderLaunchRequest {
    pub provider_id: String,
    pub cwd: PathBuf,
    pub executable: Option<PathBuf>,
    pub provider_session_hint: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LaunchPlan {
    pub program: PathBuf,
    pub arguments: Vec<OsString>,
    pub cwd: PathBuf,
    pub environment: BTreeMap<OsString, OsString>,
    pub provider_session_hint: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ResumeSupport {
    Supported,
    Unsupported,
}

pub trait ProviderAdapter: Send + Sync {
    fn id(&self) -> &'static str;
    fn display_name(&self) -> &'static str;
    fn candidates(&self) -> &'static [&'static str];
    fn detect_installation(&self) -> Option<PathBuf> {
        find_executable(self.candidates())
    }
    fn build_launch(&self, request: &ProviderLaunchRequest) -> Result<LaunchPlan, BackendError>;
    fn probe_resume(&self, output: &str, cwd: &Path) -> ResumeProbe {
        let _ = (output, cwd);
        ResumeProbe::Unsupported
    }
    fn build_resume(
        &self,
        record: &ResumeRecord,
        cwd: &Path,
    ) -> Result<Option<LaunchPlan>, BackendError> {
        let _ = (record, cwd);
        Ok(None)
    }
    fn resume_support(&self) -> ResumeSupport;
    fn delivery_kind(&self) -> DeliveryKind {
        provider_contract_flags(self.id()).delivery
    }
    fn verify_executable(&self, path: &Path) -> IdentityVerdict {
        IdentityVerdict::Verified {
            path: path.to_path_buf(),
            product: self.display_name().to_owned(),
            version: None,
        }
    }
}

pub struct ProviderRegistry {
    adapters: Vec<Arc<dyn ProviderAdapter>>,
}

impl ProviderRegistry {
    pub fn all(&self) -> Vec<&dyn ProviderAdapter> {
        self.adapters.iter().map(Arc::as_ref).collect()
    }

    pub fn get(&self, provider_id: &str) -> Option<&dyn ProviderAdapter> {
        let canonical = match provider_id {
            "claude" => "claude-code",
            "cursor" => "cursor-agent",
            "gemini-cli" => "gemini",
            other => other,
        };
        self.adapters
            .iter()
            .find(|adapter| adapter.id() == canonical)
            .map(Arc::as_ref)
    }

    pub fn capability_report(
        &self,
        provider_id: &str,
        shell_tools_available: bool,
    ) -> Option<ProviderCapabilityReport> {
        let adapter = self.get(provider_id)?;
        let flags = provider_contract_flags(adapter.id());
        let path = adapter.detect_installation();
        let identity = match &path {
            Some(path) => adapter.verify_executable(path),
            None => IdentityVerdict::Missing,
        };
        let executable_verified = matches!(identity, IdentityVerdict::Verified { .. });
        let executable_path = match &identity {
            IdentityVerdict::Verified { path, .. } | IdentityVerdict::Rejected { path, .. } => {
                Some(path.clone())
            }
            IdentityVerdict::Missing => None,
        };
        Some(ProviderCapabilityReport {
            provider_id: adapter.id().to_owned(),
            display_name: adapter.display_name().to_owned(),
            executable_verified,
            mcp_configured: false,
            shell_tools_available,
            readiness_reliable: flags.readiness_reliable,
            acknowledgement_available: flags.acknowledgement_available,
            exact_resume_available: flags.exact_resume_available,
            delivery: adapter.delivery_kind(),
            executable_path,
            identity,
        })
    }
}

impl Default for ProviderRegistry {
    fn default() -> Self {
        Self {
            adapters: vec![
                Arc::new(ClaudeCodeAdapter),
                Arc::new(CodexAdapter),
                Arc::new(CursorAdapter),
                Arc::new(OpenCodeAdapter),
                Arc::new(UnsupportedAdapter::new(
                    "gemini",
                    "Gemini CLI",
                    &["gemini", "gemini.exe", "gemini.cmd", "gemini.ps1"],
                )),
                Arc::new(UnsupportedAdapter::new(
                    "aider",
                    "Aider",
                    &["aider", "aider.exe", "aider.cmd", "aider.ps1"],
                )),
                Arc::new(UnsupportedAdapter::new(
                    "goose",
                    "Goose",
                    &["goose", "goose.exe", "goose.cmd", "goose.ps1"],
                )),
            ],
        }
    }
}

struct UnsupportedAdapter {
    id: &'static str,
    display_name: &'static str,
    candidates: &'static [&'static str],
}
impl UnsupportedAdapter {
    const fn new(
        id: &'static str,
        display_name: &'static str,
        candidates: &'static [&'static str],
    ) -> Self {
        Self {
            id,
            display_name,
            candidates,
        }
    }
}
impl ProviderAdapter for UnsupportedAdapter {
    fn id(&self) -> &'static str {
        self.id
    }
    fn display_name(&self) -> &'static str {
        self.display_name
    }
    fn candidates(&self) -> &'static [&'static str] {
        self.candidates
    }
    fn build_launch(&self, request: &ProviderLaunchRequest) -> Result<LaunchPlan, BackendError> {
        base_launch_plan(self.id, request, self.candidates, Vec::new())
    }
    fn resume_support(&self) -> ResumeSupport {
        ResumeSupport::Unsupported
    }
}

pub(super) fn resume_plan_from_record(
    adapter: &dyn ProviderAdapter,
    record: &ResumeRecord,
    cwd: &Path,
    arguments: impl IntoIterator<Item = OsString>,
) -> Result<Option<LaunchPlan>, BackendError> {
    let ResumeRecord::Available { id, .. } = record else {
        return Ok(None);
    };
    if cwd.as_os_str().is_empty() {
        return Err(BackendError::InvalidWorkingDirectory(String::new()));
    }
    let executable = adapter
        .detect_installation()
        .unwrap_or_else(|| PathBuf::from(adapter.candidates()[0]));
    let (program, mut command_arguments) = super::launcher_for_executable(executable)?;
    command_arguments.extend(arguments);
    command_arguments.push(OsString::from(id.as_str()));
    Ok(Some(LaunchPlan {
        program,
        arguments: command_arguments,
        cwd: cwd.to_path_buf(),
        environment: BTreeMap::new(),
        provider_session_hint: Some(id.as_str().to_owned()),
    }))
}

pub(super) fn base_launch_plan(
    expected_provider_id: &str,
    request: &ProviderLaunchRequest,
    candidates: &'static [&'static str],
    extra_arguments: Vec<OsString>,
) -> Result<LaunchPlan, BackendError> {
    if request.provider_id != expected_provider_id {
        return Err(BackendError::ProviderNotFound(request.provider_id.clone()));
    }
    if request.cwd.as_os_str().is_empty() {
        return Err(BackendError::InvalidWorkingDirectory(String::new()));
    }
    let executable = request
        .executable
        .clone()
        .or_else(|| find_executable(candidates))
        .unwrap_or_else(|| PathBuf::from(candidates[0]));
    let (program, mut arguments) = super::launcher_for_executable(executable)?;
    arguments.extend(extra_arguments);
    Ok(LaunchPlan {
        program,
        arguments,
        cwd: request.cwd.clone(),
        environment: BTreeMap::new(),
        provider_session_hint: request.provider_session_hint.clone(),
    })
}

#[cfg(test)]
mod tests;
