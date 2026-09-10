use crate::control::prompt_detector::AgentOutputNormalizer;
use crate::control::{AgentEventEnvelope, AgentEventKind, AgentEventPayload, AgentEventSource};
use crate::error::BackendError;
use crate::system::{default_cwd, detect_shell};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::thread;
use uuid::Uuid;

const DEFAULT_COLS: u16 = 120;
const DEFAULT_ROWS: u16 = 30;
const MAX_COLS: u16 = 10_000;
const MAX_ROWS: u16 = 10_000;
const MAX_PENDING_AGENT_OUTPUT_BYTES: usize = 8192;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TerminalStatus {
    Running,
    Exited,
    Killed,
    Failed,
}

impl TerminalStatus {
    fn as_u8(&self) -> u8 {
        match self {
            Self::Running => 0,
            Self::Exited => 1,
            Self::Killed => 2,
            Self::Failed => 3,
        }
    }

    fn from_u8(value: u8) -> Self {
        match value {
            1 => Self::Exited,
            2 => Self::Killed,
            3 => Self::Failed,
            _ => Self::Running,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSession {
    pub id: String,
    pub cwd: String,
    pub status: TerminalStatus,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputEvent {
    pub terminal_id: String,
    pub data: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalStatusEvent {
    pub terminal_id: String,
    pub status: TerminalStatus,
}

pub trait EventSink: Send + Sync {
    fn emit_output(&self, event: TerminalOutputEvent);
    fn emit_status(&self, event: TerminalStatusEvent);
    fn emit_control(&self, _event: AgentEventEnvelope) {}
    fn waits_for_agent_binding(&self) -> bool {
        false
    }
}

struct ManagerInner {
    sessions: Mutex<HashMap<Uuid, Arc<SessionHandle>>>,
}

#[derive(Clone)]
pub struct PtyManager {
    inner: Arc<ManagerInner>,
}

struct SessionHandle {
    id: Uuid,
    cwd: PathBuf,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send>>,
    size: Mutex<(u16, u16)>,
    status: AtomicU8,
    sink: Arc<dyn EventSink>,
    agent: Mutex<Option<AgentMapping>>,
    pending_agent_output: Mutex<Vec<u8>>,
}

struct AgentMapping {
    project_id: String,
    agent_id: String,
    provider_id: String,
    output_normalizer: AgentOutputNormalizer,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(ManagerInner {
                sessions: Mutex::new(HashMap::new()),
            }),
        }
    }

    pub fn session_count(&self) -> usize {
        self.inner
            .sessions
            .lock()
            .map(|sessions| sessions.len())
            .unwrap_or_default()
    }

    pub fn create_shell(
        &self,
        requested_cwd: Option<&str>,
        sink: impl EventSink + 'static,
    ) -> Result<TerminalSession, BackendError> {
        self.create_shell_with_size(requested_cwd, DEFAULT_COLS, DEFAULT_ROWS, Arc::new(sink))
    }

    pub fn create_shell_with_size(
        &self,
        requested_cwd: Option<&str>,
        cols: u16,
        rows: u16,
        sink: Arc<dyn EventSink>,
    ) -> Result<TerminalSession, BackendError> {
        let cwd = default_cwd(requested_cwd)?;
        let executable = detect_shell()?;
        self.spawn(executable, Vec::new(), cwd, cols, rows, sink)
    }

    pub fn spawn_agent(
        &self,
        executable: PathBuf,
        requested_cwd: Option<&str>,
        sink: Arc<dyn EventSink>,
    ) -> Result<TerminalSession, BackendError> {
        self.spawn_agent_with_size(executable, requested_cwd, DEFAULT_COLS, DEFAULT_ROWS, sink)
    }

    pub fn spawn_agent_with_size(
        &self,
        executable: PathBuf,
        requested_cwd: Option<&str>,
        cols: u16,
        rows: u16,
        sink: Arc<dyn EventSink>,
    ) -> Result<TerminalSession, BackendError> {
        self.spawn_agent_with_size_args(executable, Vec::new(), requested_cwd, cols, rows, sink)
    }

    pub fn spawn_agent_with_size_args(
        &self,
        executable: PathBuf,
        args: Vec<OsString>,
        requested_cwd: Option<&str>,
        cols: u16,
        rows: u16,
        sink: Arc<dyn EventSink>,
    ) -> Result<TerminalSession, BackendError> {
        let cwd = default_cwd(requested_cwd)?;
        self.spawn(executable, args, cwd, cols, rows, sink)
    }

    fn spawn(
        &self,
        executable: PathBuf,
        args: Vec<OsString>,
        cwd: PathBuf,
        cols: u16,
        rows: u16,
        sink: Arc<dyn EventSink>,
    ) -> Result<TerminalSession, BackendError> {
        validate_dimensions(cols, rows)?;
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| BackendError::Pty(error.to_string()))?;

        let mut command = CommandBuilder::new(&executable);
        command.cwd(&cwd);
        // Keep coding CLIs in their color-capable mode inside the PTY. The
        // frontend's xterm renderer preserves and interprets these ANSI/VT
        // sequences for the terminal grid.
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        command.env("FORCE_COLOR", "1");
        command.args(args);
        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| BackendError::Pty(error.to_string()))?;
        drop(pair.slave);

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| BackendError::Pty(error.to_string()))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| BackendError::Pty(error.to_string()))?;
        let id = Uuid::new_v4();
        let session = Arc::new(SessionHandle {
            id,
            cwd: cwd.clone(),
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            child: Mutex::new(child),
            size: Mutex::new((cols, rows)),
            status: AtomicU8::new(TerminalStatus::Running.as_u8()),
            sink: sink.clone(),
            agent: Mutex::new(None),
            pending_agent_output: Mutex::new(Vec::new()),
        });

        self.inner
            .sessions
            .lock()
            .map_err(|_| BackendError::Internal("PTY session lock poisoned".into()))?
            .insert(id, session.clone());

        let reader_manager = Arc::downgrade(&self.inner);
        if let Err(error) = spawn_reader(reader_manager, session.clone(), reader) {
            self.remove_if_current(id, &session);
            session.mark_failed();
            session.terminate();
            return Err(error);
        }

        let result = session.snapshot();
        sink.emit_status(TerminalStatusEvent {
            terminal_id: id.to_string(),
            status: TerminalStatus::Running,
        });
        Ok(result)
    }

    pub fn write(&self, id: &str, data: &str) -> Result<(), BackendError> {
        let session = self.session(id)?;
        if session.status() != TerminalStatus::Running {
            return Err(BackendError::SessionNotFound(id.to_owned()));
        }
        write_agent_input(&session.agent, &session.writer, data.as_bytes())
    }

    pub fn bind_agent(
        &self,
        terminal_id: &str,
        project_id: String,
        agent_id: String,
        provider_id: String,
    ) -> Result<(), BackendError> {
        let session = self.session(terminal_id)?;
        let mapping = AgentMapping {
            output_normalizer: AgentOutputNormalizer::new(&project_id, &agent_id, &provider_id),
            project_id,
            agent_id,
            provider_id,
        };
        let status;
        {
            let mut agent = session
                .agent
                .lock()
                .map_err(|_| BackendError::Internal("PTY agent mapping lock poisoned".into()))?;
            if let Some(existing) = agent.as_ref() {
                if existing.project_id == mapping.project_id
                    && existing.agent_id == mapping.agent_id
                    && existing.provider_id == mapping.provider_id
                {
                    return Ok(());
                }
                return Err(BackendError::InvalidInput(
                    "terminal is already bound to another agent".into(),
                ));
            }
            status = session.status();
            let pending = if status == TerminalStatus::Running {
                session.take_pending_agent_output()?
            } else {
                session.clear_pending_agent_output();
                Vec::new()
            };
            *agent = Some(mapping);
            let mapping = agent.as_mut().expect("agent mapping was just installed");
            let event = TerminalStatusEvent {
                terminal_id: terminal_id.to_owned(),
                status: status.clone(),
            };
            session
                .sink
                .emit_control(Self::agent_status_event_for_mapping(mapping, &event));
            if status == TerminalStatus::Running {
                if !pending.is_empty() {
                    for event in mapping.output_normalizer.accept_output(&pending) {
                        session.sink.emit_control(event);
                    }
                }
            } else {
                mapping.output_normalizer.clear();
            }
        }
        if status != TerminalStatus::Running {
            self.remove_if_current(session.id, &session);
        }
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn agent_output_event(
        project_id: &str,
        agent_id: &str,
        event: &TerminalOutputEvent,
    ) -> AgentEventEnvelope {
        Self::agent_event(
            project_id,
            agent_id,
            AgentEventKind::AgentOutput,
            AgentEventPayload::Text {
                text: event.data.clone(),
            },
        )
    }

    pub(crate) fn agent_status_event(
        project_id: &str,
        agent_id: &str,
        event: &TerminalStatusEvent,
    ) -> AgentEventEnvelope {
        let (kind, payload) = match event.status {
            TerminalStatus::Running => (AgentEventKind::AgentStarted, AgentEventPayload::Empty),
            TerminalStatus::Exited | TerminalStatus::Killed => (
                AgentEventKind::AgentExited,
                AgentEventPayload::Exit { code: None },
            ),
            TerminalStatus::Failed => (
                AgentEventKind::AgentFailed,
                AgentEventPayload::Attention {
                    reason: "PTY reader stopped unexpectedly".to_owned(),
                },
            ),
        };
        Self::agent_event(project_id, agent_id, kind, payload)
    }

    fn agent_event(
        project_id: &str,
        agent_id: &str,
        kind: AgentEventKind,
        payload: AgentEventPayload,
    ) -> AgentEventEnvelope {
        let mut event = AgentEventEnvelope::new(
            Uuid::new_v4().to_string(),
            project_id.to_owned(),
            Some(agent_id.to_owned()),
            kind,
            payload,
        );
        event.source = AgentEventSource::Pty;
        event
    }

    fn agent_status_event_for_mapping(
        mapping: &AgentMapping,
        event: &TerminalStatusEvent,
    ) -> AgentEventEnvelope {
        Self::agent_status_event(&mapping.project_id, &mapping.agent_id, event)
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), BackendError> {
        validate_dimensions(cols, rows)?;
        let session = self.session(id)?;
        if session.status() != TerminalStatus::Running {
            return Err(BackendError::SessionNotFound(id.to_owned()));
        }
        let master = session
            .master
            .lock()
            .map_err(|_| BackendError::Internal("PTY master lock poisoned".into()))?;
        master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| BackendError::Pty(error.to_string()))?;
        *session
            .size
            .lock()
            .map_err(|_| BackendError::Internal("PTY size lock poisoned".into()))? = (cols, rows);
        Ok(())
    }

    pub fn kill(&self, id: &str) -> Result<(), BackendError> {
        let id = Uuid::parse_str(id).map_err(|_| BackendError::SessionNotFound(id.to_owned()))?;
        let session = self
            .inner
            .sessions
            .lock()
            .map_err(|_| BackendError::Internal("PTY session lock poisoned".into()))?
            .get(&id)
            .cloned()
            .ok_or_else(|| BackendError::SessionNotFound(id.to_string()))?;

        let (transitioned, control_event) = session.transition_status(TerminalStatus::Killed);
        if transitioned {
            session.terminate();
            let event = TerminalStatusEvent {
                terminal_id: id.to_string(),
                status: TerminalStatus::Killed,
            };
            session.sink.emit_status(event.clone());
            if let Some(control_event) = control_event {
                session.sink.emit_control(control_event);
            }
        }
        if !session.retain_until_agent_binding() {
            self.remove_if_current(id, &session);
        }
        Ok(())
    }

    fn session(&self, id: &str) -> Result<Arc<SessionHandle>, BackendError> {
        let id = Uuid::parse_str(id).map_err(|_| BackendError::SessionNotFound(id.to_owned()))?;
        self.inner
            .sessions
            .lock()
            .map_err(|_| BackendError::Internal("PTY session lock poisoned".into()))?
            .get(&id)
            .cloned()
            .ok_or_else(|| BackendError::SessionNotFound(id.to_string()))
    }

    pub fn session_status(&self, id: &str) -> Result<TerminalStatus, BackendError> {
        Ok(self.session(id)?.status())
    }

    #[cfg(test)]
    pub fn session_size(&self, id: &str) -> Result<(u16, u16), BackendError> {
        self.session(id).and_then(|session| {
            session
                .size
                .lock()
                .map(|size| *size)
                .map_err(|_| BackendError::Internal("PTY size lock poisoned".into()))
        })
    }

    fn remove_if_current(&self, id: Uuid, session: &Arc<SessionHandle>) {
        if let Ok(mut sessions) = self.inner.sessions.lock() {
            if sessions
                .get(&id)
                .is_some_and(|current| Arc::ptr_eq(current, session))
            {
                sessions.remove(&id);
            }
        }
    }
}

fn write_agent_input(
    agent: &Mutex<Option<AgentMapping>>,
    writer: &Mutex<Box<dyn Write + Send>>,
    data: &[u8],
) -> Result<(), BackendError> {
    {
        let mut writer = writer
            .lock()
            .map_err(|_| BackendError::Internal("PTY writer lock poisoned".into()))?;
        writer.write_all(data)?;
        writer.flush()?;
    }
    let mut agent = agent
        .lock()
        .map_err(|_| BackendError::Internal("PTY agent mapping lock poisoned".into()))?;
    if let Some(mapping) = agent.as_mut() {
        mapping.output_normalizer.accept_input(data);
    }
    Ok(())
}

fn validate_dimensions(cols: u16, rows: u16) -> Result<(), BackendError> {
    if cols == 0 || rows == 0 || cols > MAX_COLS || rows > MAX_ROWS {
        return Err(BackendError::InvalidInput(format!(
            "terminal dimensions must be between 1 and {MAX_COLS} columns and 1 and {MAX_ROWS} rows"
        )));
    }
    Ok(())
}

impl Default for PtyManager {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionHandle {
    fn snapshot(&self) -> TerminalSession {
        TerminalSession {
            id: self.id.to_string(),
            cwd: self.cwd.to_string_lossy().into_owned(),
            status: self.status(),
        }
    }

    fn status(&self) -> TerminalStatus {
        TerminalStatus::from_u8(self.status.load(Ordering::Acquire))
    }

    fn mark_killed(&self) -> bool {
        self.status
            .compare_exchange(
                TerminalStatus::Running.as_u8(),
                TerminalStatus::Killed.as_u8(),
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok()
    }

    fn mark_failed(&self) -> bool {
        self.status
            .compare_exchange(
                TerminalStatus::Running.as_u8(),
                TerminalStatus::Failed.as_u8(),
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok()
    }

    fn mark_exited(&self) -> bool {
        self.status
            .compare_exchange(
                TerminalStatus::Running.as_u8(),
                TerminalStatus::Exited.as_u8(),
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok()
    }

    fn terminate(&self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    fn has_agent_mapping(&self) -> bool {
        self.agent
            .lock()
            .map(|mapping| mapping.is_some())
            .unwrap_or(false)
    }

    fn emit_agent_output(&self, bytes: &[u8]) {
        let events = {
            let mut agent = self
                .agent
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(mapping) = agent.as_mut() {
                mapping.output_normalizer.accept_output(bytes)
            } else {
                if self.sink.waits_for_agent_binding() {
                    self.append_pending_agent_output(bytes);
                }
                Vec::new()
            }
        };
        for event in events {
            self.sink.emit_control(event);
        }
    }

    fn transition_status(&self, status: TerminalStatus) -> (bool, Option<AgentEventEnvelope>) {
        let mut agent = self
            .agent
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let transitioned = match status {
            TerminalStatus::Exited => self.mark_exited(),
            TerminalStatus::Killed => self.mark_killed(),
            TerminalStatus::Failed => self.mark_failed(),
            TerminalStatus::Running => false,
        };
        if !transitioned {
            return (false, None);
        }
        if let Some(mapping) = agent.as_mut() {
            mapping.output_normalizer.clear();
        } else {
            self.clear_pending_agent_output();
        }

        let event = TerminalStatusEvent {
            terminal_id: self.id.to_string(),
            status,
        };
        let control_event = agent
            .as_ref()
            .map(|mapping| PtyManager::agent_status_event_for_mapping(mapping, &event));
        (true, control_event)
    }

    fn retain_until_agent_binding(&self) -> bool {
        self.sink.waits_for_agent_binding() && !self.has_agent_mapping()
    }

    fn append_pending_agent_output(&self, bytes: &[u8]) {
        if let Ok(mut pending) = self.pending_agent_output.lock() {
            pending.extend_from_slice(bytes);
            if pending.len() > MAX_PENDING_AGENT_OUTPUT_BYTES {
                let overflow = pending.len() - MAX_PENDING_AGENT_OUTPUT_BYTES;
                pending.drain(..overflow);
            }
        }
    }

    fn take_pending_agent_output(&self) -> Result<Vec<u8>, BackendError> {
        self.pending_agent_output
            .lock()
            .map(|mut pending| std::mem::take(&mut *pending))
            .map_err(|_| BackendError::Internal("PTY pending output lock poisoned".into()))
    }

    fn clear_pending_agent_output(&self) {
        if let Ok(mut pending) = self.pending_agent_output.lock() {
            pending.clear();
        }
    }
}

fn spawn_reader(
    manager: Weak<ManagerInner>,
    session: Arc<SessionHandle>,
    mut reader: Box<dyn Read + Send>,
) -> Result<(), BackendError> {
    thread::Builder::new()
        .name(format!("pty-reader-{}", session.id))
        .spawn(move || {
            let mut buffer = [0_u8; 8192];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(size) => {
                        let event = TerminalOutputEvent {
                            terminal_id: session.id.to_string(),
                            data: String::from_utf8_lossy(&buffer[..size]).into_owned(),
                        };
                        session.sink.emit_output(event.clone());
                        session.emit_agent_output(&buffer[..size]);
                    }
                    Err(_) => {
                        let (transitioned, control_event) =
                            session.transition_status(TerminalStatus::Failed);
                        if transitioned {
                            let event = TerminalStatusEvent {
                                terminal_id: session.id.to_string(),
                                status: TerminalStatus::Failed,
                            };
                            session.sink.emit_status(event.clone());
                            if let Some(control_event) = control_event {
                                session.sink.emit_control(control_event);
                            }
                        }
                        break;
                    }
                }
            }

            let (transitioned, control_event) = session.transition_status(TerminalStatus::Exited);
            if transitioned {
                let event = TerminalStatusEvent {
                    terminal_id: session.id.to_string(),
                    status: TerminalStatus::Exited,
                };
                session.sink.emit_status(event.clone());
                if let Some(control_event) = control_event {
                    session.sink.emit_control(control_event);
                }
            }

            if !session.retain_until_agent_binding() {
                if let Some(manager) = manager.upgrade() {
                    if let Ok(mut sessions) = manager.sessions.lock() {
                        if sessions
                            .get(&session.id)
                            .is_some_and(|current| Arc::ptr_eq(current, &session))
                        {
                            sessions.remove(&session.id);
                        }
                    }
                }
            }

            if let Ok(mut child) = session.child.lock() {
                let _ = child.wait();
            }
        })
        .map(|_| ())
        .map_err(|error| BackendError::Internal(format!("failed to start PTY reader: {error}")))
}

#[cfg(test)]
#[derive(Clone, Default)]
pub struct MemoryEventSink {
    outputs: Arc<Mutex<Vec<TerminalOutputEvent>>>,
    statuses: Arc<Mutex<Vec<TerminalStatusEvent>>>,
    control_events: Arc<Mutex<Vec<AgentEventEnvelope>>>,
    waits_for_agent_binding: bool,
}

#[cfg(test)]
impl MemoryEventSink {
    pub fn awaiting_agent_binding() -> Self {
        Self {
            waits_for_agent_binding: true,
            ..Self::default()
        }
    }

    pub fn contains(&self, terminal_id: &str, marker: &str) -> bool {
        self.outputs
            .lock()
            .map(|events| {
                events
                    .iter()
                    .any(|event| event.terminal_id == terminal_id && event.data.contains(marker))
            })
            .unwrap_or(false)
    }

    pub fn statuses(&self) -> Vec<TerminalStatusEvent> {
        self.statuses
            .lock()
            .map(|items| items.clone())
            .unwrap_or_default()
    }

    pub fn control_events(&self) -> Vec<AgentEventEnvelope> {
        self.control_events
            .lock()
            .map(|items| items.clone())
            .unwrap_or_default()
    }
}

#[cfg(test)]
impl EventSink for MemoryEventSink {
    fn emit_output(&self, event: TerminalOutputEvent) {
        if let Ok(mut events) = self.outputs.lock() {
            events.push(event);
        }
    }

    fn emit_status(&self, event: TerminalStatusEvent) {
        if let Ok(mut events) = self.statuses.lock() {
            events.push(event);
        }
    }

    fn emit_control(&self, event: AgentEventEnvelope) {
        if let Ok(mut events) = self.control_events.lock() {
            events.push(event);
        }
    }

    fn waits_for_agent_binding(&self) -> bool {
        self.waits_for_agent_binding
    }
}

#[cfg(test)]
mod lock_scope_tests {
    use super::*;
    use std::io;
    use std::sync::mpsc::{sync_channel, Receiver, SyncSender};
    use std::time::Duration;

    struct BlockingWriter {
        entered: SyncSender<()>,
        release: Receiver<()>,
    }

    impl Write for BlockingWriter {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            self.entered
                .send(())
                .map_err(|error| io::Error::other(error.to_string()))?;
            self.release
                .recv()
                .map_err(|error| io::Error::other(error.to_string()))?;
            Ok(buffer.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn blocked_writer_does_not_hold_agent_mapping_lock() {
        let agent = Arc::new(Mutex::new(Some(AgentMapping {
            project_id: "project-1".into(),
            agent_id: "agent-1".into(),
            provider_id: "codex".into(),
            output_normalizer: AgentOutputNormalizer::new("project-1", "agent-1", "codex"),
        })));
        let (entered_tx, entered_rx) = sync_channel(0);
        let (release_tx, release_rx) = sync_channel(0);
        let writer: Arc<Mutex<Box<dyn Write + Send>>> =
            Arc::new(Mutex::new(Box::new(BlockingWriter {
                entered: entered_tx,
                release: release_rx,
            })));

        let write_agent = agent.clone();
        let write_writer = writer.clone();
        let write = thread::spawn(move || write_agent_input(&write_agent, &write_writer, b"run\r"));

        entered_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("writer entered blocking write");
        let mut reader_lock = agent
            .try_lock()
            .expect("reader can acquire agent state while writer is blocked");
        let output = reader_lock
            .as_mut()
            .expect("agent mapping")
            .output_normalizer
            .accept_output(b"working\r\n");
        assert_eq!(output.len(), 1);
        assert_eq!(output[0].kind, AgentEventKind::AgentOutput);
        drop(reader_lock);
        release_tx.send(()).expect("release writer");
        write.join().expect("join writer").expect("write input");
    }
}
