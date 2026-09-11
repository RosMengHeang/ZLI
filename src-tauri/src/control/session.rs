use crate::agents::providers::ResumeDescriptor;
use crate::error::BackendError;
use crate::pty::{EventSink, PtyManager, TerminalOutputEvent, TerminalStatusEvent};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

#[cfg(test)]
const DEFAULT_SCROLLBACK_BYTES: usize = 256 * 1024;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDescriptor {
    pub session_id: String,
    pub project_id: String,
    pub agent_id: String,
    #[serde(default)]
    pub parent_agent_id: Option<String>,
    #[serde(default)]
    pub name: String,
    pub provider_id: String,
    pub terminal_id: String,
    #[serde(default)]
    pub working_directory: String,
    #[serde(default)]
    pub branch: String,
    #[serde(default)]
    pub worktree_path: Option<String>,
    pub resume: Option<ResumeDescriptor>,
    pub attached: bool,
}

pub struct RuntimeSession {
    descriptor: Mutex<SessionDescriptor>,
    pty: PtyManager,
    sink: Arc<RuntimeSessionSink>,
}

impl RuntimeSession {
    pub fn new(
        mut descriptor: SessionDescriptor,
        pty: PtyManager,
        initial_sink: Option<Arc<dyn EventSink>>,
        scrollback_limit: usize,
    ) -> Self {
        descriptor.attached = initial_sink.is_some() || descriptor.attached;
        Self {
            descriptor: Mutex::new(descriptor),
            pty,
            sink: Arc::new(RuntimeSessionSink::new(
                initial_sink,
                scrollback_limit.max(1),
            )),
        }
    }

    pub(crate) fn with_sink(
        descriptor: SessionDescriptor,
        pty: PtyManager,
        sink: Arc<RuntimeSessionSink>,
    ) -> Self {
        Self {
            descriptor: Mutex::new(descriptor),
            pty,
            sink,
        }
    }

    #[cfg(test)]
    pub(crate) fn detached_for_test(
        session_id: String,
        project_id: String,
        agent_id: String,
        provider_id: String,
        terminal_id: String,
    ) -> Self {
        Self::new(
            SessionDescriptor {
                session_id,
                project_id,
                agent_id,
                parent_agent_id: None,
                name: String::new(),
                provider_id,
                terminal_id,
                working_directory: String::new(),
                branch: String::new(),
                worktree_path: None,
                resume: None,
                attached: false,
            },
            PtyManager::new(),
            None,
            DEFAULT_SCROLLBACK_BYTES,
        )
    }

    pub fn event_sink(&self) -> Arc<dyn EventSink> {
        self.sink.clone()
    }

    pub fn descriptor(&self) -> Result<SessionDescriptor, BackendError> {
        self.descriptor
            .lock()
            .map(|descriptor| descriptor.clone())
            .map_err(|_| BackendError::Internal("runtime session lock poisoned".into()))
    }

    pub fn attach(
        &self,
        sink: Option<Arc<dyn EventSink>>,
    ) -> Result<SessionDescriptor, BackendError> {
        if let Some(sink) = sink {
            self.sink.attach(sink)?;
        }
        let mut descriptor = self
            .descriptor
            .lock()
            .map_err(|_| BackendError::Internal("runtime session lock poisoned".into()))?;
        descriptor.attached = true;
        Ok(descriptor.clone())
    }

    pub fn detach(&self) -> Result<SessionDescriptor, BackendError> {
        self.sink.detach()?;
        let mut descriptor = self
            .descriptor
            .lock()
            .map_err(|_| BackendError::Internal("runtime session lock poisoned".into()))?;
        descriptor.attached = false;
        Ok(descriptor.clone())
    }

    pub fn scrollback(&self) -> Result<String, BackendError> {
        self.sink.scrollback()
    }

    pub fn restore_scrollback(&self, scrollback: &str) {
        self.sink.append_scrollback(scrollback.as_bytes());
    }

    pub fn set_terminal_id(&self, terminal_id: String) -> Result<(), BackendError> {
        self.descriptor
            .lock()
            .map_err(|_| BackendError::Internal("runtime session lock poisoned".into()))?
            .terminal_id = terminal_id;
        Ok(())
    }

    pub fn set_resume(
        &self,
        resume: crate::agents::providers::ResumeDescriptor,
    ) -> Result<(), BackendError> {
        self.descriptor
            .lock()
            .map_err(|_| BackendError::Internal("runtime session lock poisoned".into()))?
            .resume = Some(resume);
        Ok(())
    }

    pub fn stop(&self) -> Result<(), BackendError> {
        self.pty.kill(&self.descriptor()?.terminal_id)
    }
}

#[derive(Default)]
pub struct SessionRegistry {
    sessions: Mutex<HashMap<String, Arc<RuntimeSession>>>,
}

impl SessionRegistry {
    pub fn insert(&self, session: RuntimeSession) -> Arc<RuntimeSession> {
        let session = Arc::new(session);
        if let Ok(descriptor) = session.descriptor() {
            self.sessions
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .insert(descriptor.session_id, session.clone());
        }
        session
    }

    pub fn get(&self, session_id: &str) -> Result<Arc<RuntimeSession>, BackendError> {
        self.sessions
            .lock()
            .map_err(|_| BackendError::Internal("session registry lock poisoned".into()))?
            .get(session_id)
            .cloned()
            .ok_or_else(|| BackendError::SessionNotFound(session_id.to_owned()))
    }

    pub fn attach(&self, session_id: &str) -> Result<SessionDescriptor, BackendError> {
        self.get(session_id)?.attach(None)
    }

    pub fn attach_sink(
        &self,
        session_id: &str,
        sink: Arc<dyn EventSink>,
    ) -> Result<SessionDescriptor, BackendError> {
        self.get(session_id)?.attach(Some(sink))
    }

    pub fn detach(&self, session_id: &str) -> Result<SessionDescriptor, BackendError> {
        self.get(session_id)?.detach()
    }

    pub fn list(&self) -> Result<Vec<Arc<RuntimeSession>>, BackendError> {
        self.sessions
            .lock()
            .map(|sessions| sessions.values().cloned().collect())
            .map_err(|_| BackendError::Internal("session registry lock poisoned".into()))
    }
}

pub(crate) struct RuntimeSessionSink {
    target: Mutex<Option<Arc<dyn EventSink>>>,
    scrollback: Mutex<VecDeque<u8>>,
    scrollback_limit: usize,
}

impl RuntimeSessionSink {
    pub(crate) fn new(target: Option<Arc<dyn EventSink>>, scrollback_limit: usize) -> Self {
        Self {
            target: Mutex::new(target),
            scrollback: Mutex::new(VecDeque::with_capacity(scrollback_limit)),
            scrollback_limit,
        }
    }

    fn attach(&self, target: Arc<dyn EventSink>) -> Result<(), BackendError> {
        *self
            .target
            .lock()
            .map_err(|_| BackendError::Internal("session sink lock poisoned".into()))? =
            Some(target);
        Ok(())
    }

    fn detach(&self) -> Result<(), BackendError> {
        self.target
            .lock()
            .map_err(|_| BackendError::Internal("session sink lock poisoned".into()))?
            .take();
        Ok(())
    }

    fn scrollback(&self) -> Result<String, BackendError> {
        let bytes = self
            .scrollback
            .lock()
            .map_err(|_| BackendError::Internal("session scrollback lock poisoned".into()))?
            .iter()
            .copied()
            .collect::<Vec<_>>();
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }

    fn append_scrollback(&self, bytes: &[u8]) {
        if let Ok(mut scrollback) = self.scrollback.lock() {
            scrollback.extend(bytes);
            while scrollback.len() > self.scrollback_limit {
                scrollback.pop_front();
            }
        }
    }

    fn target(&self) -> Option<Arc<dyn EventSink>> {
        self.target
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }
}

impl EventSink for RuntimeSessionSink {
    fn emit_output(&self, event: TerminalOutputEvent) {
        self.append_scrollback(event.data.as_bytes());
        if let Some(target) = self.target() {
            target.emit_output(event);
        }
    }

    fn emit_status(&self, event: TerminalStatusEvent) {
        if let Some(target) = self.target() {
            target.emit_status(event);
        }
    }

    fn emit_control(&self, event: crate::control::AgentEventEnvelope) {
        if let Some(target) = self.target() {
            target.emit_control(event);
        }
    }

    fn waits_for_agent_binding(&self) -> bool {
        true
    }
}
