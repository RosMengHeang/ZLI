mod claude_code;
mod codex;
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
pub use cursor::CursorAdapter;
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

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ResumeAvailability {
    Available,
    Unsupported,
    Unknown,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeDescriptor {
    pub provider_id: String,
    pub provider_session_id: Option<String>,
    pub resume_command_kind: Option<String>,
    pub working_directory: PathBuf,
    pub last_checkpoint_at: Option<String>,
    pub availability: ResumeAvailability,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProviderEvent {
    Started,
    Waiting,
    Completed,
}

pub trait ProviderAdapter: Send + Sync {
    fn id(&self) -> &'static str;
    fn display_name(&self) -> &'static str;
    fn candidates(&self) -> &'static [&'static str];
    fn detect_installation(&self) -> Option<PathBuf> {
        find_executable(self.candidates())
    }
    fn build_launch(&self, request: &ProviderLaunchRequest) -> Result<LaunchPlan, BackendError>;
    fn parse_output(&self, output: &str) -> Vec<ProviderEvent>;
    fn detect_resume(&self, output: &str, cwd: &Path) -> Option<ResumeDescriptor>;
    fn build_resume(
        &self,
        descriptor: &ResumeDescriptor,
    ) -> Result<Option<LaunchPlan>, BackendError>;
    fn resume_support(&self) -> ResumeSupport;
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

pub(super) fn resume_plan(
    adapter: &dyn ProviderAdapter,
    descriptor: &ResumeDescriptor,
    arguments: impl IntoIterator<Item = OsString>,
) -> Result<Option<LaunchPlan>, BackendError> {
    if descriptor.provider_id != adapter.id()
        || descriptor.availability != ResumeAvailability::Available
    {
        return Ok(None);
    }
    let Some(session_id) = descriptor
        .provider_session_id
        .as_ref()
        .filter(|id| !id.trim().is_empty())
    else {
        return Ok(None);
    };
    if descriptor.working_directory.as_os_str().is_empty() {
        return Err(BackendError::InvalidWorkingDirectory(String::new()));
    }
    let executable = adapter
        .detect_installation()
        .unwrap_or_else(|| PathBuf::from(adapter.candidates()[0]));
    let (program, mut command_arguments) = super::launcher_for_executable(executable)?;
    command_arguments.extend(arguments);
    command_arguments.push(OsString::from(session_id));
    Ok(Some(LaunchPlan {
        program,
        arguments: command_arguments,
        cwd: descriptor.working_directory.clone(),
        environment: BTreeMap::new(),
        provider_session_hint: Some(session_id.clone()),
    }))
}

pub(super) fn common_output_events(output: &str) -> Vec<ProviderEvent> {
    let lowered = output.to_ascii_lowercase();
    let mut events = Vec::new();
    if lowered.contains("session") || lowered.contains("ready") {
        events.push(ProviderEvent::Started);
    }
    if lowered.contains("ask codex") || lowered.contains("type help") || lowered.contains('❯') {
        events.push(ProviderEvent::Waiting);
    }
    if lowered.contains("completed") || lowered.contains("tests passed") {
        events.push(ProviderEvent::Completed);
    }
    events
}

pub(super) fn resume_from_marker(
    provider_id: &str,
    output: &str,
    cwd: &Path,
    marker: &str,
) -> Option<ResumeDescriptor> {
    let marker = marker.to_ascii_lowercase();
    let (line, marker_offset) = output.lines().find_map(|line| {
        line.to_ascii_lowercase()
            .find(&marker)
            .map(|offset| (line, offset))
    })?;
    let session_id = line[marker_offset + marker.len()..]
        .trim_start_matches([':', ' ', '\t'])
        .trim();
    if session_id.is_empty() {
        return None;
    }
    Some(ResumeDescriptor {
        provider_id: provider_id.to_owned(),
        provider_session_id: Some(session_id.to_owned()),
        resume_command_kind: Some("session_id".to_owned()),
        working_directory: cwd.to_path_buf(),
        last_checkpoint_at: None,
        availability: ResumeAvailability::Available,
    })
}

#[cfg(test)]
mod tests;
