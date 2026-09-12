use super::events::utc_rfc3339_now;
use super::{
    AgentEventEnvelope, AgentEventKind, AgentEventPayload, AgentEventSource, ManagedLaunch,
    OwnershipLedger, OwnershipLedgerError, ProjectSnapshot, ReconcileReport, RuntimeOwnershipRecord,
    RuntimeSession, SessionDescriptor, SessionManager, SessionRegistry, SnapshotStore,
    SnapshotStoreError,
};
use crate::agents::providers::{ProviderRegistry, ResumeRecord, ResumeSupport};
use crate::error::BackendError;
use crate::event_hub::{EventHub, EventHubHealth};
use crate::pty::{
    inspect_process, terminate_process, EventSink, ProcessInspection, ProcessTermination,
    PtyManager, TerminalStatus,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

pub const SUPERVISOR_PROTOCOL_VERSION: u16 = 1;
const RESTORED_SCROLLBACK_LIMIT: usize = 256 * 1024;

#[derive(Debug, Serialize)]
#[serde(tag = "code", content = "message", rename_all = "snake_case")]
pub enum SessionCommandError {
    MissingSession(String),
    ResumeUnsupported(String),
    ProtocolMismatch(String),
    Snapshot(String),
    Ownership(String),
    Runtime(String),
}

impl From<BackendError> for SessionCommandError {
    fn from(error: BackendError) -> Self {
        match error {
            BackendError::SessionNotFound(id) => Self::MissingSession(id),
            other => Self::Runtime(other.to_string()),
        }
    }
}

impl From<SnapshotStoreError> for SessionCommandError {
    fn from(error: SnapshotStoreError) -> Self {
        Self::Snapshot(error.to_string())
    }
}

impl From<OwnershipLedgerError> for SessionCommandError {
    fn from(error: OwnershipLedgerError) -> Self {
        Self::Ownership(error.to_string())
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconnectResult {
    pub protocol_version: u16,
    pub current_sequence: u64,
    pub events: Vec<AgentEventEnvelope>,
    pub sessions: Vec<SessionDescriptor>,
    pub reconciliation: ReconcileReport,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    pub snapshot: Option<ProjectSnapshot>,
    pub session_ids: Vec<String>,
    pub created_session_ids: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHealth {
    pub total: usize,
    pub running: usize,
    pub exited: usize,
    pub killed: usize,
    pub failed: usize,
    pub unknown: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeHealth {
    pub project_id: Option<String>,
    pub event_hub: EventHubHealth,
    pub sessions: SessionHealth,
    pub agent_limit: usize,
    pub active_agents: usize,
    pub reserved_agent_slots: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub available_agent_slots: Option<usize>,
}

pub struct Supervisor {
    started: AtomicBool,
    pty: PtyManager,
    registry: Arc<SessionRegistry>,
    sessions: Arc<SessionManager>,
    store: SnapshotStore,
    ownership: OwnershipLedger,
    providers: ProviderRegistry,
    events: EventHub,
    resume_lock: Mutex<()>,
    launch_reservations: Mutex<HashMap<String, usize>>,
}

impl Supervisor {
    pub fn new(app_data_dir: std::path::PathBuf, pty: PtyManager, events: EventHub) -> Self {
        let registry = Arc::new(SessionRegistry::default());
        let store = SnapshotStore::new(app_data_dir.clone());
        let sessions = Arc::new(SessionManager::new(registry.clone(), store.clone()));
        Self {
            started: AtomicBool::new(false),
            pty,
            registry,
            sessions,
            store,
            ownership: OwnershipLedger::new(app_data_dir.clone()),
            providers: ProviderRegistry::default(),
            events,
            resume_lock: Mutex::new(()),
            launch_reservations: Mutex::new(HashMap::new()),
        }
    }

    /// Reserve a project agent slot before creating a worktree or process.
    /// The reservation closes the race between concurrent launch requests;
    /// callers must release it when their launch transaction ends.
    pub(crate) fn reserve_agent_slot(
        &self,
        project_id: &str,
    ) -> Result<bool, SessionCommandError> {
        let mut reservations = self
            .launch_reservations
            .lock()
            .map_err(|_| SessionCommandError::Runtime("launch limit lock poisoned".into()))?;
        let active = self
            .registry
            .list()?
            .into_iter()
            .filter_map(|session| session.descriptor().ok())
            .filter(|descriptor| {
                descriptor.project_id == project_id
                    && self
                        .pty
                        .session_status(&descriptor.terminal_id)
                        .is_ok_and(|status| status == TerminalStatus::Running)
            })
            .count();
        let reserved = reservations.get(project_id).copied().unwrap_or_default();
        if active + reserved >= super::team::MAX_TEAM_AGENTS {
            return Ok(false);
        }
        *reservations.entry(project_id.to_owned()).or_default() += 1;
        Ok(true)
    }

    pub(crate) fn release_agent_slot(&self, project_id: &str) {
        let Ok(mut reservations) = self.launch_reservations.lock() else {
            return;
        };
        let remove = if let Some(count) = reservations.get_mut(project_id) {
            *count = count.saturating_sub(1);
            *count == 0
        } else {
            false
        };
        if remove {
            reservations.remove(project_id);
        }
    }

    pub fn start_or_connect(&self) -> Result<bool, SessionCommandError> {
        Ok(!self.started.swap(true, Ordering::AcqRel))
    }

    pub fn reconnect(
        &self,
        protocol_version: u16,
        cursor: u64,
    ) -> Result<ReconnectResult, SessionCommandError> {
        if protocol_version != SUPERVISOR_PROTOCOL_VERSION {
            return Err(SessionCommandError::ProtocolMismatch(format!(
                "client {protocol_version}, supervisor {SUPERVISOR_PROTOCOL_VERSION}"
            )));
        }
        self.start_or_connect()?;
        let reconciliation = self.reconcile()?;
        let sessions = self
            .registry
            .list()?
            .into_iter()
            .map(|session| session.descriptor())
            .collect::<Result<Vec<_>, _>>()?;
        Ok(ReconnectResult {
            protocol_version: SUPERVISOR_PROTOCOL_VERSION,
            current_sequence: self.events.latest_sequence(),
            events: self.events.subscribe_after(cursor),
            sessions,
            reconciliation,
        })
    }

    /// Return read-only runtime metrics without reconciling or mutating any
    /// session, process, worktree, or ownership state.
    pub fn health(&self, project_id: Option<&str>) -> Result<RuntimeHealth, SessionCommandError> {
        let reserved_agent_slots = self
            .launch_reservations
            .lock()
            .map_err(|_| SessionCommandError::Runtime("launch limit lock poisoned".into()))
            .map(|reservations| {
                project_id.map_or_else(
                    || reservations.values().sum(),
                    |project| reservations.get(project).copied().unwrap_or_default(),
                )
            })?;
        let sessions = self.registry.list()?;
        let mut session_health = SessionHealth::default();
        for session in sessions {
            let descriptor = session.descriptor()?;
            if project_id.is_some_and(|project| descriptor.project_id != project) {
                continue;
            }
            session_health.total += 1;
            match self.pty.session_status(&descriptor.terminal_id) {
                Ok(TerminalStatus::Running) => session_health.running += 1,
                Ok(TerminalStatus::Exited) => session_health.exited += 1,
                Ok(TerminalStatus::Killed) => session_health.killed += 1,
                Ok(TerminalStatus::Failed) => session_health.failed += 1,
                Err(_) => session_health.unknown += 1,
            }
        }
        let active_agents = session_health.running;
        let available_agent_slots = project_id.map(|_| {
            super::team::MAX_TEAM_AGENTS.saturating_sub(active_agents + reserved_agent_slots)
        });
        Ok(RuntimeHealth {
            project_id: project_id.map(str::to_owned),
            event_hub: self.events.health(),
            sessions: session_health,
            agent_limit: super::team::MAX_TEAM_AGENTS,
            active_agents,
            reserved_agent_slots,
            available_agent_slots,
        })
    }

    pub fn restore_project(&self, project_id: &str) -> Result<RestoreResult, SessionCommandError> {
        self.start_or_connect()?;
        let snapshot = self.store.load(project_id)?;
        let mut session_ids = Vec::new();
        let mut created_session_ids = Vec::new();
        if let Some(snapshot) = snapshot.as_ref() {
            for value in &snapshot.agents {
                let stored: StoredRuntimeSession = match serde_json::from_value(value.clone()) {
                    Ok(stored) => stored,
                    Err(_) => continue,
                };
                let session_id = stored.descriptor.session_id.clone();
                session_ids.push(session_id.clone());
                if self.registry.get(&session_id).is_ok() {
                    continue;
                }
                let mut descriptor = stored.descriptor;
                descriptor.attached = true;
                let session = RuntimeSession::new(
                    descriptor,
                    self.pty.clone(),
                    None,
                    RESTORED_SCROLLBACK_LIMIT,
                );
                session.restore_scrollback(&stored.scrollback);
                self.registry.insert(session);
                created_session_ids.push(session_id);
            }
        }
        Ok(RestoreResult {
            snapshot,
            session_ids,
            created_session_ids,
        })
    }

    pub fn forget_session(
        &self,
        project_id: &str,
        session_id: &str,
    ) -> Result<bool, SessionCommandError> {
        let session = match self.registry.get(session_id) {
            Ok(session) => session,
            Err(BackendError::SessionNotFound(_)) => return Ok(false),
            Err(error) => return Err(error.into()),
        };
        let descriptor = session.descriptor()?;
        if descriptor.project_id != project_id {
            return Err(SessionCommandError::Runtime(
                "session belongs to a different project".into(),
            ));
        }
        if !descriptor.terminal_id.trim().is_empty()
            && self
                .pty
                .session_status(&descriptor.terminal_id)
                .is_ok_and(|status| status == TerminalStatus::Running)
        {
            return Err(SessionCommandError::Runtime(
                "session is still running; stop it before forgetting".into(),
            ));
        }
        let removed = self.registry.remove_if_current(session_id, &session)?;
        if !removed && self.registry.get(session_id).is_ok() {
            return Err(SessionCommandError::Runtime(
                "session changed while forgetting; retry the cleanup".into(),
            ));
        }
        if removed {
            self.ownership.remove(session_id)?;
        }
        Ok(removed)
    }

    pub fn checkpoint(
        &self,
        project_id: &str,
        pane_tree: serde_json::Value,
        browser: Vec<serde_json::Value>,
        tax_chat_room: Option<serde_json::Value>,
        last_event_sequence: u64,
    ) -> Result<ProjectSnapshot, SessionCommandError> {
        self.discover_resume_descriptors(project_id)?;
        Ok(self.sessions.checkpoint(
            project_id,
            pane_tree,
            browser,
            tax_chat_room,
            last_event_sequence,
        )?)
    }

    pub(crate) fn runtime_sink(
        &self,
        target: Arc<dyn EventSink>,
    ) -> Arc<super::session::RuntimeSessionSink> {
        Arc::new(super::session::RuntimeSessionSink::new(
            Some(target),
            RESTORED_SCROLLBACK_LIMIT,
        ))
    }

    pub(crate) fn register_agent(
        &self,
        agent: &crate::agents::Agent,
        project_id: String,
        sink: Arc<super::session::RuntimeSessionSink>,
    ) -> Result<SessionDescriptor, SessionCommandError> {
        self.register_agent_with_parent(agent, project_id, None, sink)
    }

    pub(crate) fn register_agent_with_parent(
        &self,
        agent: &crate::agents::Agent,
        project_id: String,
        parent_agent_id: Option<String>,
        sink: Arc<super::session::RuntimeSessionSink>,
    ) -> Result<SessionDescriptor, SessionCommandError> {
        let descriptor = SessionDescriptor {
            session_id: agent.id.clone(),
            project_id,
            agent_id: agent.id.clone(),
            parent_agent_id,
            name: agent.name.clone(),
            provider_id: agent.provider.clone(),
            terminal_id: agent.terminal_id.clone(),
            working_directory: agent.cwd.clone(),
            branch: agent.branch.clone(),
            worktree_path: agent.worktree_path.clone(),
            resume: None,
            attached: true,
        };
        let session = RuntimeSession::with_sink(descriptor, self.pty.clone(), sink);
        let result = session.descriptor()?;
        self.record_ownership(&result)?;
        self.registry.insert(session);
        Ok(result)
    }

    fn record_ownership(&self, descriptor: &SessionDescriptor) -> Result<(), SessionCommandError> {
        if let Some(process) = self.pty.process_identity(&descriptor.terminal_id)? {
            self.ownership.record(RuntimeOwnershipRecord {
                session_id: descriptor.session_id.clone(),
                agent_id: descriptor.agent_id.clone(),
                project_id: descriptor.project_id.clone(),
                terminal_id: descriptor.terminal_id.clone(),
                worktree_path: descriptor.worktree_path.clone(),
                process,
                recorded_at: utc_rfc3339_now(),
            })?;
        }
        Ok(())
    }

    pub fn shutdown(&self) -> Result<(), SessionCommandError> {
        let terminal_ids = self
            .registry
            .list()?
            .into_iter()
            .filter_map(|session| session.descriptor().ok())
            .map(|descriptor| descriptor.terminal_id)
            .filter(|terminal_id| !terminal_id.trim().is_empty())
            .collect::<Vec<_>>();
        self.ownership.remove_for_terminals(&terminal_ids)?;
        Ok(())
    }

    pub fn resume(
        &self,
        session_id: &str,
        launch: ManagedLaunch,
        tools: &super::ProviderTools,
    ) -> Result<SessionDescriptor, SessionCommandError> {
        let _resume_guard = self
            .resume_lock
            .lock()
            .map_err(|_| SessionCommandError::Runtime("resume lock poisoned".into()))?;
        let existing = self.registry.get(session_id)?;
        let descriptor = existing.descriptor()?;
        if self
            .pty
            .session_status(&descriptor.terminal_id)
            .is_ok_and(|status| status == TerminalStatus::Running)
        {
            let attached = existing.attach(Some(launch.sink()))?;
            drop(launch);
            return Ok(attached);
        }
        let adapter = self.providers.get(&descriptor.provider_id).ok_or_else(|| {
            SessionCommandError::ResumeUnsupported(descriptor.provider_id.clone())
        })?;
        if adapter.resume_support() == ResumeSupport::Unsupported {
            return Err(SessionCommandError::ResumeUnsupported(
                descriptor.provider_id.clone(),
            ));
        }
        let resume = descriptor.resume.as_ref().ok_or_else(|| {
            SessionCommandError::ResumeUnsupported("provider session ID is unavailable".into())
        })?;
        if !matches!(resume, ResumeRecord::Available { .. }) {
            return Err(SessionCommandError::ResumeUnsupported(
                descriptor.provider_id.clone(),
            ));
        }
        let plan = adapter
            .build_resume(resume, std::path::Path::new(&descriptor.working_directory))?
            .ok_or_else(|| {
                SessionCommandError::ResumeUnsupported(descriptor.provider_id.clone())
            })?;
        let program = adapter
            .detect_installation()
            .unwrap_or_else(|| std::path::PathBuf::from(adapter.candidates()[0]));
        let plan = super::ToolBindContext {
            tools,
            agent: launch.agent(),
            sidecars: launch.sidecars(),
        }
        .apply(plan, &program)
        .map_err(|error| SessionCommandError::Runtime(error.to_string()))?;
        let mut resumed_descriptor = descriptor.clone();
        resumed_descriptor.terminal_id.clear();
        let resumed = Arc::new(RuntimeSession::new(
            resumed_descriptor,
            self.pty.clone(),
            Some(launch.sink()),
            RESTORED_SCROLLBACK_LIMIT,
        ));
        resumed.restore_scrollback(&existing.scrollback()?);
        let terminal = self.pty.spawn_agent_with_size_args_env(
            plan.program,
            plan.arguments,
            Some(plan.cwd.to_string_lossy().as_ref()),
            120,
            30,
            launch.environment().merge_provider(&plan.environment),
            resumed.event_sink(),
        )?;
        if let Err(error) = resumed.set_terminal_id(terminal.id.clone()) {
            let _ = self.pty.abort(&terminal.id);
            return Err(error.into());
        }
        if let Err(error) = self.pty.bind_agent(
            &terminal.id,
            descriptor.project_id.clone(),
            descriptor.agent_id.clone(),
            descriptor.provider_id.clone(),
        ) {
            let _ = self.pty.abort(&terminal.id);
            return Err(error.into());
        }
        let result = match resumed.descriptor() {
            Ok(result) => result,
            Err(error) => {
                let _ = self.pty.abort(&terminal.id);
                return Err(error.into());
            }
        };
        if !self
            .registry
            .replace_if_current(session_id, &existing, resumed.clone())?
        {
            let _ = self.pty.abort(&terminal.id);
            return Err(SessionCommandError::Runtime(
                "session changed while resuming; retry the resume".into(),
            ));
        }
        if let Err(error) = self.record_ownership(&result) {
            let _ = self
                .registry
                .replace_if_current(session_id, &resumed, existing.clone());
            let _ = self.pty.abort(&terminal.id);
            return Err(error);
        }
        launch.commit();
        Ok(result)
    }

    pub fn read_session(
        &self,
        session_id: &str,
    ) -> Result<(SessionDescriptor, String), SessionCommandError> {
        let session = self.registry.get(session_id)?;
        Ok((session.descriptor()?, session.scrollback()?))
    }

    pub fn reconcile(&self) -> Result<ReconcileReport, SessionCommandError> {
        self.reconcile_project(None)
    }

    pub fn reconcile_project(
        &self,
        project_id: Option<&str>,
    ) -> Result<ReconcileReport, SessionCommandError> {
        let mut report = ReconcileReport::default();
        self.reconcile_ownership(project_id, &mut report)?;
        for session in self.registry.list()? {
            let descriptor = session.descriptor()?;
            if project_id.is_some_and(|project| descriptor.project_id != project) {
                continue;
            }
            let missing_worktree = if let Some(worktree_path) = descriptor
                .worktree_path
                .as_deref()
                .filter(|path| !path.trim().is_empty())
            {
                let path = std::path::Path::new(worktree_path);
                let missing = !path.is_dir();
                if missing
                    && !report
                        .retained_missing_worktrees
                        .iter()
                        .any(|existing| existing == worktree_path)
                {
                    report
                        .retained_missing_worktrees
                        .push(worktree_path.to_owned());
                }
                missing
            } else {
                false
            };
            if !descriptor.attached {
                continue;
            }
            let live = self
                .pty
                .session_status(&descriptor.terminal_id)
                .is_ok_and(|status| status == TerminalStatus::Running);
            if live && !missing_worktree {
                continue;
            }
            let _ = session.detach();
            report
                .offline_session_ids
                .push(descriptor.session_id.clone());
            let mut event = AgentEventEnvelope::new(
                format!(
                    "reconcile-offline-{}-{}",
                    descriptor.session_id, descriptor.terminal_id
                ),
                descriptor.project_id,
                Some(descriptor.agent_id),
                AgentEventKind::AgentStopped,
                AgentEventPayload::Empty,
            );
            event.source = AgentEventSource::Runtime;
            let _ = self.events.publish(event);
        }
        Ok(report)
    }

    fn reconcile_ownership(
        &self,
        project_id: Option<&str>,
        report: &mut ReconcileReport,
    ) -> Result<(), SessionCommandError> {
        for record in self.ownership.records()? {
            if project_id.is_some_and(|project| record.project_id != project) {
                continue;
            }
            if self
                .pty
                .session_status(&record.terminal_id)
                .is_ok_and(|status| status == TerminalStatus::Running)
            {
                continue;
            }
            match inspect_process(&record.process) {
                ProcessInspection::Matching => {
                    let process_id = record.process.pid.to_string();
                    report.orphaned_owned_process_ids.push(process_id.clone());
                    match terminate_process(&record.process) {
                        ProcessTermination::Terminated => {
                            report.stopped_owned_process_ids.push(process_id);
                            self.ownership.remove(&record.session_id)?;
                            report
                                .cleared_ownership_record_ids
                                .push(record.session_id.clone());
                        }
                        ProcessTermination::NotRunning => {
                            self.ownership.remove(&record.session_id)?;
                            report
                                .cleared_ownership_record_ids
                                .push(record.session_id.clone());
                        }
                        ProcessTermination::Mismatch | ProcessTermination::Unknown => {
                            report.unknown_process_ids.push(process_id);
                        }
                    }
                }
                ProcessInspection::NotRunning => {
                    self.ownership.remove(&record.session_id)?;
                    report
                        .cleared_ownership_record_ids
                        .push(record.session_id.clone());
                }
                ProcessInspection::Mismatch | ProcessInspection::Unknown => {
                    report
                        .unknown_process_ids
                        .push(record.process.pid.to_string());
                }
            }
        }
        Ok(())
    }

    fn discover_resume_descriptors(&self, project_id: &str) -> Result<(), SessionCommandError> {
        for session in self.registry.list()? {
            let descriptor = session.descriptor()?;
            if descriptor.project_id != project_id {
                continue;
            }
            let Some(adapter) = self.providers.get(&descriptor.provider_id) else {
                continue;
            };
            if adapter.resume_support() == ResumeSupport::Unsupported {
                if !matches!(descriptor.resume, Some(ResumeRecord::Unsupported)) {
                    session.set_resume(ResumeRecord::Unsupported)?;
                }
                continue;
            }
            if descriptor
                .resume
                .as_ref()
                .is_some_and(|resume| !resume.needs_probe())
            {
                continue;
            }
            let probe = adapter.probe_resume(
                &session.scrollback()?,
                std::path::Path::new(&descriptor.working_directory),
            );
            session.set_resume(ResumeRecord::from_probe(probe))?;
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredRuntimeSession {
    descriptor: SessionDescriptor,
    #[serde(default)]
    scrollback: String,
}
