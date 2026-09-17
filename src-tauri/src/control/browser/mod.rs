pub mod catalog;
pub mod commands;
pub mod gateway;
pub mod settings;
mod executor;
mod security;

pub use executor::{instrumentation_script, BrowserExecutor, TauriBrowserExecutor};
pub use settings::{clean_profile_data_dir, BrowserControlSettingsStore, CLEAN_PROFILE_ID};

use self::commands::{
    BrowserCapability, BrowserCommand, BrowserConsoleEntry, BrowserPageError, BrowserResult,
    BROWSER_LIMITS,
};
use crate::control::events::utc_rfc3339_now;
use crate::control::{
    AgentEventEnvelope, AgentEventKind, AgentEventPayload, AgentEventSource, CallerIdentity,
    ControlError, ControlErrorCode,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};
use uuid::Uuid;

type EventPublisher = Arc<dyn Fn(AgentEventEnvelope) + Send + Sync>;

#[derive(Clone, Debug)]
pub enum OpenOutcome {
    Pending,
    Rejected(ControlError),
    Bound { surface_id: String },
}

#[derive(Clone, Debug)]
struct OpenTicket {
    project_id: String,
    agent_id: Option<String>,
    outcome: OpenOutcome,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSurfaceRecord {
    pub surface_id: String,
    pub project_id: String,
    pub agent_id: Option<String>,
    pub url: String,
    pub profile_id: String,
    pub capabilities: Vec<BrowserCapability>,
    pub created_at: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserControlStatus {
    pub profile_id: String,
    pub enabled: bool,
    pub surface_count: usize,
}

#[derive(Clone, Debug)]
struct BrowserSurface {
    record: BrowserSurfaceRecord,
    webview_label: String,
}

#[derive(Default)]
struct BrowserState {
    surfaces: HashMap<String, BrowserSurface>,
    profile_capabilities: HashMap<(String, String), Vec<BrowserCapability>>,
    open_tickets: HashMap<String, OpenTicket>,
    surface_locks: HashMap<String, Arc<Mutex<()>>>,
}

#[derive(Clone)]
pub struct BrowserManager {
    state: Arc<Mutex<BrowserState>>,
    publish: EventPublisher,
    settings: Option<Arc<BrowserControlSettingsStore>>,
}

impl BrowserManager {
    pub fn new(publish: EventPublisher) -> Self {
        Self {
            state: Arc::new(Mutex::new(BrowserState::default())),
            publish,
            settings: None,
        }
    }

    pub fn with_settings(
        publish: EventPublisher,
        settings: Arc<BrowserControlSettingsStore>,
    ) -> Self {
        Self {
            state: Arc::new(Mutex::new(BrowserState::default())),
            publish,
            settings: Some(settings),
        }
    }

    pub fn register(
        &self,
        project_id: impl Into<String>,
        agent_id: Option<String>,
        webview_label: impl Into<String>,
        url: impl Into<String>,
        profile_id: impl Into<String>,
    ) -> Result<BrowserSurfaceRecord, ControlError> {
        let project_id = project_id.into();
        let webview_label = webview_label.into();
        let url = url.into();
        let profile_id = profile_id.into();
        if project_id.trim().is_empty()
            || webview_label.trim().is_empty()
            || profile_id.trim().is_empty()
        {
            return Err(ControlError::new(
                ControlErrorCode::BrowserInvalidCommand,
                "Project, webview label, and profile are required",
            ));
        }
        BrowserCommand::Open { url: url.clone() }.validate()?;
        let capabilities = match self
            .state()
            .profile_capabilities
            .get(&(project_id.clone(), profile_id.clone()))
            .cloned()
        {
            Some(capabilities) => capabilities,
            None if self
                .settings
                .as_ref()
                .is_some_and(|settings| settings.is_enabled(&profile_id).unwrap_or(false)) =>
            {
                vec![BrowserCapability::Read, BrowserCapability::Control]
            }
            None => Vec::new(),
        };
        let record = BrowserSurfaceRecord {
            surface_id: Uuid::new_v4().to_string(),
            project_id,
            agent_id,
            url,
            profile_id,
            capabilities,
            created_at: utc_rfc3339_now(),
        };
        self.state().surfaces.insert(
            record.surface_id.clone(),
            BrowserSurface {
                record: record.clone(),
                webview_label,
            },
        );
        self.emit(&record, AgentEventKind::BrowserSurfaceCreated, &record.url);
        Ok(record)
    }

    pub fn bind_open(
        &self,
        request_id: &str,
        surface_id: &str,
    ) -> Result<BrowserSurfaceRecord, ControlError> {
        let mut state = self.state();
        let record = state
            .surfaces
            .get(surface_id)
            .map(|surface| surface.record.clone())
            .ok_or_else(not_found)?;
        let ticket = state.open_tickets.get_mut(request_id).ok_or_else(|| {
            ControlError::new(
                ControlErrorCode::BrowserInvalidCommand,
                "Browser open request is no longer pending",
            )
        })?;
        if ticket.project_id != record.project_id || ticket.agent_id != record.agent_id {
            return Err(ControlError::new(
                ControlErrorCode::BrowserSurfaceForbidden,
                "Browser surface owner does not match the open request",
            ));
        }
        if matches!(ticket.outcome, OpenOutcome::Pending) {
            ticket.outcome = OpenOutcome::Bound {
                surface_id: surface_id.to_owned(),
            };
        }
        Ok(record)
    }

    pub fn reject_open(&self, request_id: &str, error: ControlError) {
        let mut state = self.state();
        if let Some(ticket) = state.open_tickets.get_mut(request_id) {
            if matches!(ticket.outcome, OpenOutcome::Pending) {
                ticket.outcome = OpenOutcome::Rejected(error);
            }
        }
    }

    pub fn surface(&self, surface_id: &str) -> Result<BrowserSurfaceRecord, ControlError> {
        self.state()
            .surfaces
            .get(surface_id)
            .map(|surface| surface.record.clone())
            .ok_or_else(not_found)
    }

    pub fn find_owned_url(
        &self,
        project_id: &str,
        agent_id: Option<&str>,
        url: &str,
    ) -> Option<BrowserSurfaceRecord> {
        self.state()
            .surfaces
            .values()
            .find(|surface| {
                surface.record.project_id == project_id
                    && surface.record.agent_id.as_deref() == agent_id
                    && surface.record.url == url
            })
            .map(|surface| surface.record.clone())
    }

    pub fn open_and_wait(
        &self,
        executor: &dyn BrowserExecutor,
        request_id: &str,
        project_id: &str,
        agent_id: Option<&str>,
        url: &str,
        timeout: Duration,
    ) -> Result<BrowserSurfaceRecord, ControlError> {
        if let Some(existing) = self.find_owned_url(project_id, agent_id, url) {
            return Ok(existing);
        }
        {
            let mut state = self.state();
            state.open_tickets.insert(
                request_id.to_owned(),
                OpenTicket {
                    project_id: project_id.to_owned(),
                    agent_id: agent_id.map(str::to_owned),
                    outcome: OpenOutcome::Pending,
                },
            );
        }
        executor.request_open(request_id, project_id, agent_id, url)?;
        let started = Instant::now();
        loop {
            let outcome = {
                let state = self.state();
                state
                    .open_tickets
                    .get(request_id)
                    .map(|ticket| ticket.outcome.clone())
                    .unwrap_or(OpenOutcome::Pending)
            };
            match outcome {
                OpenOutcome::Bound { surface_id } => {
                    self.forget_open(request_id);
                    return self.surface(&surface_id).map_err(|_| {
                        ControlError::new(
                            ControlErrorCode::BrowserSurfaceNotFound,
                            "Browser pane was closed",
                        )
                    });
                }
                OpenOutcome::Rejected(error) => {
                    self.forget_open(request_id);
                    return Err(error);
                }
                OpenOutcome::Pending => {
                    if started.elapsed() >= timeout {
                        self.forget_open(request_id);
                        return Err(ControlError::new(
                            ControlErrorCode::BrowserCommandTimeout,
                            "Browser pane did not open before the deadline",
                        ));
                    }
                    thread::sleep(Duration::from_millis(50));
                }
            }
        }
    }

    fn forget_open(&self, request_id: &str) {
        self.state().open_tickets.remove(request_id);
    }

    fn surface_lock(&self, surface_id: &str) -> Arc<Mutex<()>> {
        self.state()
            .surface_locks
            .entry(surface_id.to_owned())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    pub fn list(&self, identity: &CallerIdentity) -> Vec<BrowserSurfaceRecord> {
        self.state()
            .surfaces
            .values()
            .filter(|surface| {
                (identity.project_id == "*" || surface.record.project_id == identity.project_id)
                    && identity.agent_id.as_ref().is_none_or(|agent_id| {
                        surface.record.agent_id.as_ref() == Some(agent_id)
                    })
            })
            .map(|surface| surface.record.clone())
            .collect()
    }

    pub fn grant(
        &self,
        surface_id: &str,
        capability: BrowserCapability,
    ) -> Result<BrowserSurfaceRecord, ControlError> {
        let mut state = self.state();
        let record = {
            let surface = state.surfaces.get_mut(surface_id).ok_or_else(not_found)?;
            if !surface.record.capabilities.contains(&capability) {
                surface.record.capabilities.push(capability);
            }
            surface.record.clone()
        };
        let key = (record.project_id.clone(), record.profile_id.clone());
        state
            .profile_capabilities
            .insert(key, record.capabilities.clone());
        Ok(record)
    }

    pub fn revoke(
        &self,
        surface_id: &str,
        capability: BrowserCapability,
    ) -> Result<BrowserSurfaceRecord, ControlError> {
        let mut state = self.state();
        let record = {
            let surface = state.surfaces.get_mut(surface_id).ok_or_else(not_found)?;
            surface
                .record
                .capabilities
                .retain(|value| *value != capability);
            surface.record.clone()
        };
        let key = (record.project_id.clone(), record.profile_id.clone());
        state
            .profile_capabilities
            .insert(key, record.capabilities.clone());
        Ok(record)
    }

    pub fn update_navigation(
        &self,
        surface_id: &str,
        url: impl Into<String>,
    ) -> Result<BrowserSurfaceRecord, ControlError> {
        let url = url.into();
        let record = {
            let mut state = self.state();
            let surface = state.surfaces.get_mut(surface_id).ok_or_else(not_found)?;
            surface.record.url.clone_from(&url);
            surface.record.clone()
        };
        self.emit(&record, AgentEventKind::BrowserNavigationChanged, &url);
        Ok(record)
    }

    pub fn webview_label(&self, surface_id: &str) -> Result<String, ControlError> {
        self.state()
            .surfaces
            .get(surface_id)
            .map(|surface| surface.webview_label.clone())
            .ok_or_else(not_found)
    }

    pub fn authorize(
        &self,
        identity: &CallerIdentity,
        surface_id: &str,
        command: &BrowserCommand,
    ) -> Result<BrowserSurfaceRecord, ControlError> {
        let record = self
            .state()
            .surfaces
            .get(surface_id)
            .map(|surface| surface.record.clone())
            .ok_or_else(not_found)?;
        if identity.project_id != "*" && identity.project_id != record.project_id {
            return Err(ControlError::new(
                ControlErrorCode::BrowserSurfaceForbidden,
                "Browser surface belongs to another project",
            ));
        }
        if identity.agent_id.as_deref().is_some_and(|caller_agent| {
            record.agent_id.as_deref() != Some(caller_agent)
        }) {
            return Err(ControlError::new(
                ControlErrorCode::BrowserSurfaceForbidden,
                "Browser surface belongs to another agent or to the user",
            ));
        }
        if self.settings.is_some() && !self.control_enabled(&record.profile_id)? {
            return Err(ControlError::new(
                ControlErrorCode::BrowserControlDisabled,
                "Built-in browser control is disabled for this profile",
            ));
        }
        security::authorize_surface(identity, &record, command.kind())?;
        Ok(record)
    }

    pub fn control_status(&self, profile_id: &str) -> Result<BrowserControlStatus, ControlError> {
        let enabled = self.control_enabled(profile_id)?;
        let surface_count = self
            .state()
            .surfaces
            .values()
            .filter(|surface| surface.record.profile_id == profile_id)
            .count();
        Ok(BrowserControlStatus {
            profile_id: profile_id.to_owned(),
            enabled,
            surface_count,
        })
    }

    pub fn set_control_enabled(
        &self,
        profile_id: &str,
        enabled: bool,
    ) -> Result<BrowserControlStatus, ControlError> {
        let settings = self.settings.as_ref().ok_or_else(|| {
            ControlError::new(
                ControlErrorCode::ControlRuntimeError,
                "Browser settings store is unavailable",
            )
        })?;
        settings.set_enabled(profile_id, enabled).map_err(|error| {
            ControlError::new(
                ControlErrorCode::ControlRuntimeError,
                format!("save browser control setting: {error}"),
            )
        })?;
        self.control_status(profile_id)
    }

    pub fn authorize_project(
        &self,
        identity: &CallerIdentity,
        project_id: &str,
        capability: BrowserCapability,
    ) -> Result<(), ControlError> {
        if identity.project_id != "*" && identity.project_id != project_id {
            return Err(ControlError::new(
                ControlErrorCode::BrowserSurfaceForbidden,
                "Browser project is outside the caller scope",
            ));
        }
        if self.settings.is_some() && !self.control_enabled("clean")? {
            return Err(ControlError::new(
                ControlErrorCode::BrowserControlDisabled,
                "Built-in browser control is disabled for this profile",
            ));
        }
        let (_, caller_capability) =
            security::required_capability(commands::BrowserCommandKind::Open);
        let granted =
            self.state()
                .profile_capabilities
                .iter()
                .any(|((project, _), capabilities)| {
                    project == project_id && capabilities.contains(&capability)
                }) || (self.settings.is_some()
                    && capability == BrowserCapability::Control
                    && self
                        .state()
                        .profile_capabilities
                        .keys()
                        .all(|(project, _)| project != project_id));
        if !identity.allows(caller_capability) || !granted {
            return Err(ControlError::new(
                ControlErrorCode::BrowserPermissionRequired,
                "Browser control must be granted for this project",
            ));
        }
        Ok(())
    }

    pub fn dispatch<F>(
        &self,
        identity: &CallerIdentity,
        command: BrowserCommand,
        timeout_ms: u64,
        execute: F,
    ) -> Result<BrowserResult, ControlError>
    where
        F: FnOnce(&BrowserSurfaceRecord, &BrowserCommand) -> Result<BrowserResult, ControlError>,
    {
        command.validate()?;
        let surface_id = command.surface_id().ok_or_else(|| {
            ControlError::new(
                ControlErrorCode::BrowserInvalidCommand,
                "Open commands require the browser surface creation flow",
            )
        })?;
        let lock = self.surface_lock(surface_id);
        let _op_guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let started = Instant::now();
        let record = match self.authorize(identity, surface_id, &command) {
            Ok(record) => record,
            Err(error) => {
                if let Some(record) = self
                    .state()
                    .surfaces
                    .get(surface_id)
                    .map(|surface| surface.record.clone())
                {
                    self.emit(
                        &record,
                        AgentEventKind::BrowserCommandFailed,
                        "Browser command denied",
                    );
                }
                return Err(error);
            }
        };
        let budget = Duration::from_millis(command_timeout(&command, timeout_ms));
        if started.elapsed() >= budget {
            return Err(timeout());
        }
        let operation = format!("{:?}", command.kind()).to_ascii_lowercase();
        self.emit(&record, AgentEventKind::BrowserCommandStarted, &operation);
        let result = execute(&record, &command).inspect_err(|_| {
            self.emit(
                &record,
                AgentEventKind::BrowserCommandFailed,
                "Browser command failed",
            );
        })?;
        if started.elapsed() > budget {
            self.emit(
                &record,
                AgentEventKind::BrowserCommandFailed,
                "Browser command timed out",
            );
            return Err(timeout());
        }
        let result = bound_result(result).inspect_err(|_| {
            self.emit(
                &record,
                AgentEventKind::BrowserCommandFailed,
                "Browser result exceeded its safety limit",
            );
        })?;
        self.emit(&record, AgentEventKind::BrowserCommandCompleted, &operation);
        Ok(result)
    }

    pub fn close(&self, surface_id: &str) -> Result<BrowserSurfaceRecord, ControlError> {
        let mut state = self.state();
        state.surface_locks.remove(surface_id);
        state
            .surfaces
            .remove(surface_id)
            .map(|surface| surface.record)
            .ok_or_else(not_found)
    }

    fn emit(&self, record: &BrowserSurfaceRecord, kind: AgentEventKind, text: &str) {
        let mut event = AgentEventEnvelope::new(
            Uuid::new_v4().to_string(),
            record.project_id.clone(),
            record.agent_id.clone(),
            kind,
            AgentEventPayload::Text {
                text: text.to_owned(),
            },
        );
        event.source = AgentEventSource::Browser;
        (self.publish)(event);
    }

    fn state(&self) -> MutexGuard<'_, BrowserState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn control_enabled(&self, profile_id: &str) -> Result<bool, ControlError> {
        self.settings
            .as_ref()
            .map(|settings| {
                settings.is_enabled(profile_id).map_err(|error| {
                    ControlError::new(
                        ControlErrorCode::ControlRuntimeError,
                        format!("read browser control setting: {error}"),
                    )
                })
            })
            .transpose()
            .map(|value| value.unwrap_or(true))
    }
}

impl Default for BrowserManager {
    fn default() -> Self {
        Self::new(Arc::new(|_| {}))
    }
}

fn command_timeout(command: &BrowserCommand, request_timeout_ms: u64) -> u64 {
    let command_timeout = match command {
        BrowserCommand::Wait { timeout_ms, .. } => *timeout_ms,
        _ => BROWSER_LIMITS.max_command_timeout_ms,
    };
    request_timeout_ms.min(command_timeout)
}

fn bound_result(result: BrowserResult) -> Result<BrowserResult, ControlError> {
    Ok(match result {
        BrowserResult::Snapshot {
            surface_id,
            content,
            truncated,
        } => {
            let (content, was_truncated) =
                truncate_chars(content, BROWSER_LIMITS.max_snapshot_characters);
            BrowserResult::Snapshot {
                surface_id,
                content,
                truncated: truncated || was_truncated,
            }
        }
        BrowserResult::ConsoleEntries {
            surface_id,
            mut entries,
            truncated,
        } => {
            let was_truncated = entries.len() > BROWSER_LIMITS.max_console_entries;
            entries.truncate(BROWSER_LIMITS.max_console_entries);
            let entries = entries.into_iter().map(bound_console_entry).collect();
            BrowserResult::ConsoleEntries {
                surface_id,
                entries,
                truncated: truncated || was_truncated,
            }
        }
        BrowserResult::PageErrors {
            surface_id,
            mut errors,
            truncated,
        } => {
            let was_truncated = errors.len() > BROWSER_LIMITS.max_page_errors;
            errors.truncate(BROWSER_LIMITS.max_page_errors);
            let errors = errors.into_iter().map(bound_page_error).collect();
            BrowserResult::PageErrors {
                surface_id,
                errors,
                truncated: truncated || was_truncated,
            }
        }
        BrowserResult::Screenshot { ref data_url, .. }
            if data_url.chars().count() > BROWSER_LIMITS.max_screenshot_characters =>
        {
            return Err(ControlError::new(
                ControlErrorCode::BrowserResultTooLarge,
                "Browser screenshot exceeds the result limit",
            ));
        }
        BrowserResult::Evaluation { ref value, .. }
            if serde_json::to_string(value)
                .map(|encoded| encoded.chars().count() > BROWSER_LIMITS.max_snapshot_characters)
                .unwrap_or(true) =>
        {
            return Err(ControlError::new(
                ControlErrorCode::BrowserResultTooLarge,
                "Browser evaluation exceeds the result limit",
            ));
        }
        other => other,
    })
}

fn bound_console_entry(mut entry: BrowserConsoleEntry) -> BrowserConsoleEntry {
    entry.message = truncate_chars(entry.message, 10_000).0;
    entry
}

fn bound_page_error(mut error: BrowserPageError) -> BrowserPageError {
    error.message = truncate_chars(error.message, 10_000).0;
    error.source = error.source.map(|value| truncate_chars(value, 4_096).0);
    error
}

fn truncate_chars(value: String, maximum: usize) -> (String, bool) {
    if value.chars().count() <= maximum {
        return (value, false);
    }
    (value.chars().take(maximum).collect(), true)
}

fn not_found() -> ControlError {
    ControlError::new(
        ControlErrorCode::BrowserSurfaceNotFound,
        "Browser surface was not found",
    )
}

fn timeout() -> ControlError {
    ControlError::new(
        ControlErrorCode::BrowserCommandTimeout,
        "Browser command timed out",
    )
}

#[cfg(test)]
mod tests;
