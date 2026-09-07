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
        let mut writer = session
            .writer
            .lock()
            .map_err(|_| BackendError::Internal("PTY writer lock poisoned".into()))?;
        writer.write_all(data.as_bytes())?;
        writer.flush()?;
        Ok(())
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
            .remove(&id)
            .ok_or_else(|| BackendError::SessionNotFound(id.to_string()))?;

        if session.mark_killed() {
            session.terminate();
            session.sink.emit_status(TerminalStatusEvent {
                terminal_id: id.to_string(),
                status: TerminalStatus::Killed,
            });
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
                    Ok(size) => session.sink.emit_output(TerminalOutputEvent {
                        terminal_id: session.id.to_string(),
                        data: String::from_utf8_lossy(&buffer[..size]).into_owned(),
                    }),
                    Err(_) => {
                        if session.mark_failed() {
                            session.sink.emit_status(TerminalStatusEvent {
                                terminal_id: session.id.to_string(),
                                status: TerminalStatus::Failed,
                            });
                        }
                        break;
                    }
                }
            }

            if session.mark_exited() {
                session.sink.emit_status(TerminalStatusEvent {
                    terminal_id: session.id.to_string(),
                    status: TerminalStatus::Exited,
                });
            }

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
}

#[cfg(test)]
impl MemoryEventSink {
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

    #[allow(dead_code)]
    pub fn statuses(&self) -> Vec<TerminalStatusEvent> {
        self.statuses
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
}
