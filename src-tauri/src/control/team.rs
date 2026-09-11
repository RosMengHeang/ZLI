use super::{
    AgentEventEnvelope, AgentEventKind, AgentEventPayload, AgentEventSource, CallerIdentity,
    Capability, CapabilityTokenStore, ControlError, ControlErrorCode, SnapshotStore, Supervisor,
    SUPERVISOR_PROTOCOL_VERSION,
};
use crate::agents::{self, Agent, AgentManager, LaunchAgentRequest};
use crate::git::worktree::{self, CreateWorktreeRequest, RemoveWorktreeRequest};
use crate::pty::{EventSink, PtyManager, TerminalStatus};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::env;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use uuid::Uuid;

pub const MAX_TEAM_AGENTS: usize = 12;
const MAX_TASK_BYTES: usize = 16 * 1024;
const MAX_READ_BYTES: usize = 64 * 1024;
const MAX_PENDING_MESSAGES_PER_AGENT: usize = 64;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnAgentRequest {
    #[serde(default)]
    pub project_id: String,
    pub parent_agent_id: Option<String>,
    pub provider_id: String,
    pub task: String,
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamAgent {
    pub agent_id: String,
    pub parent_agent_id: Option<String>,
    pub project_id: String,
    pub provider_id: String,
    pub name: String,
    pub terminal_id: String,
    pub branch: String,
    pub worktree_path: String,
    pub paused: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedAgentMessage {
    pub message_id: String,
    pub project_id: String,
    pub agent_id: String,
    pub terminal_id: String,
    pub body: String,
    pub kind: QueuedAgentMessageKind,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum QueuedAgentMessageKind {
    Agent,
    Taxchat {
        message_id: String,
        sender_agent_id: Option<String>,
        body: String,
        recipient_ids: Vec<String>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentQueueStatus {
    pub project_id: String,
    pub agent_id: String,
    pub pending_count: usize,
    pub in_flight_count: usize,
    pub oldest_message_id: Option<String>,
}

#[derive(Clone, Default)]
pub struct AgentMessageInbox {
    pending: Arc<Mutex<HashMap<String, VecDeque<QueuedAgentMessage>>>>,
    in_flight: Arc<Mutex<HashMap<(String, String), QueuedAgentMessage>>>,
    store: Option<SnapshotStore>,
}

impl AgentMessageInbox {
    pub fn with_store(store: SnapshotStore) -> Result<Self, ControlError> {
        let values = store.load_pending_messages().map_err(persistence_error)?;
        if values.len() > MAX_TEAM_AGENTS * MAX_PENDING_MESSAGES_PER_AGENT {
            return Err(queue_data_error(
                "Pending message queue exceeds the supported capacity",
            ));
        }
        let mut pending = HashMap::<String, VecDeque<QueuedAgentMessage>>::new();
        for value in values {
            let message: QueuedAgentMessage =
                serde_json::from_value(value).map_err(|error| queue_data_error(error.to_string()))?;
            validate_queued_message(&message)?;
            let queue = pending.entry(message.agent_id.clone()).or_default();
            if queue.len() >= MAX_PENDING_MESSAGES_PER_AGENT {
                return Err(queue_data_error(
                    "Pending message queue exceeds the per-agent capacity",
                ));
            }
            queue.push_back(message);
        }
        Ok(Self {
            pending: Arc::new(Mutex::new(pending)),
            in_flight: Arc::new(Mutex::new(HashMap::new())),
            store: Some(store),
        })
    }

    pub fn enqueue(&self, message: QueuedAgentMessage) -> Result<(), ControlError> {
        let mut pending = self.pending.lock().map_err(lock_error)?;
        let agent_id = message.agent_id.clone();
        let queue_len = pending.get(&agent_id).map(VecDeque::len).unwrap_or_default();
        let in_flight = self.in_flight.lock().map_err(lock_error)?;
        let in_flight_count = in_flight
            .keys()
            .filter(|(queued_agent_id, _)| queued_agent_id == &agent_id)
            .count();
        if queue_len + in_flight_count >= MAX_PENDING_MESSAGES_PER_AGENT {
            return Err(ControlError::new(
                ControlErrorCode::AgentInboxFull,
                "Agent message inbox is full; wait for delivery before sending more",
            ));
        }
        pending
            .entry(agent_id.clone())
            .or_default()
            .push_back(message.clone());
        if let Err(error) = self.persist_locked(&pending, &in_flight) {
            let remove_queue = if let Some(queue) = pending.get_mut(&agent_id) {
                queue.pop_back();
                queue.is_empty()
            } else {
                false
            };
            if remove_queue {
                pending.remove(&agent_id);
            }
            return Err(error);
        }
        Ok(())
    }

    pub fn take_next(&self, agent_id: &str) -> Result<Option<QueuedAgentMessage>, ControlError> {
        let mut pending = self.pending.lock().map_err(lock_error)?;
        let mut in_flight = self.in_flight.lock().map_err(lock_error)?;
        if in_flight.keys().any(|(queued_agent_id, _)| queued_agent_id == agent_id) {
            return Ok(None);
        }
        let message = match pending.get_mut(agent_id).and_then(VecDeque::pop_front) {
            Some(message) => message,
            None => return Ok(None),
        };
        if pending.get(agent_id).is_some_and(VecDeque::is_empty) {
            pending.remove(agent_id);
        }
        let key = (agent_id.to_owned(), message.message_id.clone());
        in_flight.insert(key.clone(), message.clone());
        if let Err(error) = self.persist_locked(&pending, &in_flight) {
            in_flight.remove(&key);
            pending
                .entry(agent_id.to_owned())
                .or_default()
                .push_front(message);
            return Err(error);
        }
        Ok(Some(message))
    }

    pub fn ack(&self, agent_id: &str, message_id: &str) -> Result<(), ControlError> {
        let pending = self.pending.lock().map_err(lock_error)?;
        let mut in_flight = self.in_flight.lock().map_err(lock_error)?;
        let key = (agent_id.to_owned(), message_id.to_owned());
        let Some(message) = in_flight.remove(&key) else {
            return Ok(());
        };
        if let Err(error) = self.persist_locked(&pending, &in_flight) {
            in_flight.insert(key, message);
            return Err(error);
        }
        Ok(())
    }

    pub fn requeue(&self, agent_id: &str, message_id: &str) -> Result<bool, ControlError> {
        let mut pending = self.pending.lock().map_err(lock_error)?;
        let mut in_flight = self.in_flight.lock().map_err(lock_error)?;
        let key = (agent_id.to_owned(), message_id.to_owned());
        let Some(message) = in_flight.remove(&key) else {
            return Ok(false);
        };
        pending
            .entry(agent_id.to_owned())
            .or_default()
            .push_front(message.clone());
        if let Err(error) = self.persist_locked(&pending, &in_flight) {
            let queue = pending
                .get_mut(agent_id)
                .expect("requeued message must have a queue");
            let removed = queue.pop_front();
            debug_assert_eq!(removed.as_ref(), Some(&message));
            if queue.is_empty() {
                pending.remove(agent_id);
            }
            in_flight.insert(key, message);
            return Err(error);
        }
        Ok(true)
    }

    pub fn drain(&self, agent_id: &str) -> Result<Vec<QueuedAgentMessage>, ControlError> {
        let mut pending = self.pending.lock().map_err(lock_error)?;
        let mut in_flight = self.in_flight.lock().map_err(lock_error)?;
        let queued = pending.remove(agent_id).unwrap_or_default();
        let in_flight_keys = in_flight
            .keys()
            .filter(|(queued_agent_id, _)| queued_agent_id == agent_id)
            .cloned()
            .collect::<Vec<_>>();
        let mut removed_in_flight = Vec::with_capacity(in_flight_keys.len());
        for key in &in_flight_keys {
            if let Some(message) = in_flight.remove(key) {
                removed_in_flight.push(message);
            }
        }
        let mut removed = removed_in_flight.clone();
        removed.extend(queued.iter().cloned());
        if let Err(error) = self.persist_locked(&pending, &in_flight) {
            if !queued.is_empty() {
                pending.insert(agent_id.to_owned(), queued);
            }
            for message in removed_in_flight {
                in_flight.insert(
                    (message.agent_id.clone(), message.message_id.clone()),
                    message,
                );
            }
            return Err(error);
        }
        Ok(removed)
    }

    pub fn queue_status(
        &self,
        project_id: Option<&str>,
    ) -> Result<Vec<AgentQueueStatus>, ControlError> {
        let pending = self.pending.lock().map_err(lock_error)?;
        let in_flight = self.in_flight.lock().map_err(lock_error)?;
        let mut statuses = BTreeMap::<(String, String), AgentQueueStatus>::new();

        for message in in_flight.values() {
            if project_id.is_some_and(|requested| requested != message.project_id) {
                continue;
            }
            let key = (message.project_id.clone(), message.agent_id.clone());
            let status = statuses.entry(key).or_insert_with(|| AgentQueueStatus {
                project_id: message.project_id.clone(),
                agent_id: message.agent_id.clone(),
                pending_count: 0,
                in_flight_count: 0,
                oldest_message_id: None,
            });
            status.in_flight_count += 1;
            if status.oldest_message_id.is_none() {
                status.oldest_message_id = Some(message.message_id.clone());
            }
        }

        for queue in pending.values() {
            for message in queue {
                if project_id.is_some_and(|requested| requested != message.project_id) {
                    continue;
                }
                let key = (message.project_id.clone(), message.agent_id.clone());
                let status = statuses.entry(key).or_insert_with(|| AgentQueueStatus {
                    project_id: message.project_id.clone(),
                    agent_id: message.agent_id.clone(),
                    pending_count: 0,
                    in_flight_count: 0,
                    oldest_message_id: None,
                });
                status.pending_count += 1;
                if status.oldest_message_id.is_none() {
                    status.oldest_message_id = Some(message.message_id.clone());
                }
            }
        }

        Ok(statuses.into_values().collect())
    }

    #[cfg(test)]
    pub fn pending_count(&self, agent_id: &str) -> usize {
        let pending = self.pending.lock().ok();
        let in_flight = self.in_flight.lock().ok();
        pending
            .as_ref()
            .and_then(|pending| pending.get(agent_id).map(VecDeque::len))
            .unwrap_or_default()
            + in_flight
                .as_ref()
                .map(|in_flight| {
                    in_flight
                        .keys()
                        .filter(|(queued_agent_id, _)| queued_agent_id == agent_id)
                        .count()
                })
                .unwrap_or_default()
    }
}

impl AgentMessageInbox {
    fn persist_locked(
        &self,
        pending: &HashMap<String, VecDeque<QueuedAgentMessage>>,
        in_flight: &HashMap<(String, String), QueuedAgentMessage>,
    ) -> Result<(), ControlError> {
        let Some(store) = self.store.as_ref() else {
            return Ok(());
        };
        let mut agent_ids = pending.keys().cloned().collect::<Vec<_>>();
        agent_ids.extend(in_flight.keys().map(|(agent_id, _)| agent_id.clone()));
        agent_ids.sort();
        agent_ids.dedup();
        let mut messages = Vec::new();
        for agent_id in agent_ids {
            let mut in_flight_messages = in_flight
                .iter()
                .filter(|((queued_agent_id, _), _)| queued_agent_id == &agent_id)
                .map(|(_, message)| message.clone())
                .collect::<Vec<_>>();
            in_flight_messages.sort_by(|left, right| left.message_id.cmp(&right.message_id));
            messages.extend(in_flight_messages);
            if let Some(queue) = pending.get(&agent_id) {
                messages.extend(queue.iter().cloned());
            }
        }
        let values = messages
            .into_iter()
            .map(|message| serde_json::to_value(message).map_err(|error| queue_data_error(error.to_string())))
            .collect::<Result<Vec<_>, _>>()?;
        store.save_pending_messages(&values).map_err(persistence_error)
    }
}

fn validate_queued_message(message: &QueuedAgentMessage) -> Result<(), ControlError> {
    if message.project_id.trim().is_empty()
        || message.agent_id.trim().is_empty()
        || message.terminal_id.trim().is_empty()
        || message.body.trim().is_empty()
        || message.body.len() > MAX_TASK_BYTES
    {
        return Err(queue_data_error("Pending message contains invalid fields"));
    }
    match &message.kind {
        QueuedAgentMessageKind::Agent => Ok(()),
        QueuedAgentMessageKind::Taxchat {
            message_id,
            body,
            recipient_ids,
            ..
        } if message_id == &message.message_id
            && !body.trim().is_empty()
            && body.len() <= MAX_TASK_BYTES
            && !recipient_ids.is_empty()
            && recipient_ids.len() <= MAX_TEAM_AGENTS => Ok(()),
        QueuedAgentMessageKind::Taxchat { .. } => {
            Err(queue_data_error("Pending TaxChat message contains invalid fields"))
        }
    }
}

#[derive(Clone, Debug)]
pub struct PreparedWorktree {
    pub branch: String,
    pub path: String,
}

#[derive(Clone, Debug)]
pub struct ChildLaunch {
    pub agent_id: String,
    pub parent_agent_id: Option<String>,
    pub project_id: String,
    pub provider_id: String,
    pub name: String,
    pub worktree: PreparedWorktree,
    pub environment: HashMap<OsString, OsString>,
}

pub trait TeamBackend: Send + Sync {
    fn active_agent_count(&self, project_id: &str) -> Result<usize, ControlError>;
    fn agent_exists(&self, project_id: &str, agent_id: &str) -> Result<bool, ControlError>;
    fn recover_agent(
        &self,
        project_id: &str,
        agent_id: &str,
    ) -> Result<Option<TeamAgent>, ControlError>;
    fn provider_installed(&self, provider_id: &str) -> bool;
    fn create_worktree(
        &self,
        project_id: &str,
        provider_id: &str,
    ) -> Result<PreparedWorktree, ControlError>;
    fn launch_child(&self, launch: ChildLaunch) -> Result<Agent, ControlError>;
    fn deliver(&self, terminal_id: &str, body: &str) -> Result<(), ControlError>;
    fn read(&self, agent_id: &str) -> Result<(String, String), ControlError>;
    fn stop(&self, agent_id: &str) -> Result<(), ControlError>;
    fn cleanup_worktree(&self, project_id: &str, path: &str) -> Result<(), ControlError>;
    fn emit(&self, event: AgentEventEnvelope);
}

pub struct TeamCoordinator {
    backend: Arc<dyn TeamBackend>,
    tokens: Arc<CapabilityTokenStore>,
    endpoint: String,
    control_executable: Option<PathBuf>,
    records: Mutex<HashMap<String, TeamAgent>>,
    child_tokens: Mutex<HashMap<String, String>>,
    inbox: AgentMessageInbox,
    delivery_ack_pending: Mutex<HashMap<(String, String), QueuedAgentMessage>>,
}

impl TeamCoordinator {
    pub fn new(
        backend: Arc<dyn TeamBackend>,
        tokens: Arc<CapabilityTokenStore>,
        endpoint: String,
    ) -> Self {
        Self {
            backend,
            tokens,
            endpoint,
            control_executable: None,
            records: Mutex::new(HashMap::new()),
            child_tokens: Mutex::new(HashMap::new()),
            inbox: AgentMessageInbox::default(),
            delivery_ack_pending: Mutex::new(HashMap::new()),
        }
    }

    pub fn with_control_executable(mut self, executable: Option<PathBuf>) -> Self {
        self.control_executable = executable;
        self
    }

    pub fn with_message_store(mut self, store: SnapshotStore) -> Result<Self, ControlError> {
        self.inbox = AgentMessageInbox::with_store(store)?;
        Ok(self)
    }

    pub fn queue_status(
        &self,
        project_id: Option<&str>,
    ) -> Result<Vec<AgentQueueStatus>, ControlError> {
        self.inbox.queue_status(project_id)
    }

    pub fn spawn(&self, request: SpawnAgentRequest) -> Result<TeamAgent, ControlError> {
        validate_spawn(&request)?;
        if self.backend.active_agent_count(&request.project_id)? >= MAX_TEAM_AGENTS {
            return Err(ControlError::new(
                ControlErrorCode::AgentLimitReached,
                "This project already has 12 agents",
            ));
        }
        if let Some(parent) = request.parent_agent_id.as_deref() {
            if !self.backend.agent_exists(&request.project_id, parent)? {
                return Err(ControlError::new(
                    ControlErrorCode::ParentAgentNotFound,
                    "Parent agent was not found in this project",
                ));
            }
        }
        if !self.backend.provider_installed(&request.provider_id) {
            return Err(ControlError::new(
                ControlErrorCode::ProviderNotInstalled,
                "The selected provider is not installed",
            ));
        }

        let worktree = self
            .backend
            .create_worktree(&request.project_id, &request.provider_id)?;
        let agent_id = Uuid::new_v4().to_string();
        let issued = self.tokens.issue(
            child_identity(&request, &agent_id),
            Duration::from_secs(12 * 60 * 60),
        );
        let environment = control_environment(
            &request,
            &agent_id,
            &self.endpoint,
            &issued.token,
            self.control_executable.as_deref(),
        );
        let launch = ChildLaunch {
            agent_id: agent_id.clone(),
            parent_agent_id: request.parent_agent_id.clone(),
            project_id: request.project_id.clone(),
            provider_id: request.provider_id.clone(),
            name: request
                .name
                .clone()
                .unwrap_or_else(|| format!("{} child", request.provider_id)),
            worktree: worktree.clone(),
            environment,
        };
        let agent = match self.backend.launch_child(launch) {
            Ok(agent) => agent,
            Err(error) => {
                self.tokens.revoke(&issued.token);
                let _ = self
                    .backend
                    .cleanup_worktree(&request.project_id, &worktree.path);
                return Err(error);
            }
        };
        if let Err(error) = self.backend.deliver(&agent.terminal_id, &request.task) {
            let _ = self.backend.stop(&agent.id);
            self.tokens.revoke(&issued.token);
            let _ = self
                .backend
                .cleanup_worktree(&request.project_id, &worktree.path);
            return Err(error);
        }

        let child = TeamAgent {
            agent_id: agent.id.clone(),
            parent_agent_id: request.parent_agent_id.clone(),
            project_id: request.project_id.clone(),
            provider_id: agent.provider,
            name: agent.name,
            terminal_id: agent.terminal_id,
            branch: agent.branch,
            worktree_path: worktree.path,
            paused: false,
        };
        self.records
            .lock()
            .map_err(lock_error)?
            .insert(child.agent_id.clone(), child.clone());
        self.child_tokens
            .lock()
            .map_err(lock_error)?
            .insert(child.agent_id.clone(), issued.token);
        self.emit(
            &child,
            AgentEventKind::AgentStarted,
            AgentEventPayload::Agent {
                name: child.name.clone(),
                provider_id: child.provider_id.clone(),
                terminal_id: child.terminal_id.clone(),
                branch: child.branch.clone(),
                worktree_path: child.worktree_path.clone(),
                paused: child.paused,
            },
        );
        Ok(child)
    }

    pub fn send(
        &self,
        project_id: &str,
        agent_id: &str,
        body: &str,
    ) -> Result<Value, ControlError> {
        if body.trim().is_empty() || body.len() > MAX_TASK_BYTES {
            return Err(ControlError::new(
                ControlErrorCode::InvalidControlRequest,
                "Message must be between 1 and 16384 bytes",
            ));
        }
        let record = self.record(project_id, agent_id)?;
        if record.paused {
            return Err(ControlError::new(
                ControlErrorCode::CapabilityDenied,
                "Agent is paused",
            ));
        }
        let message_id = Uuid::new_v4().to_string();
        self.inbox.enqueue(QueuedAgentMessage {
            message_id: message_id.clone(),
            project_id: record.project_id.clone(),
            agent_id: record.agent_id.clone(),
            terminal_id: record.terminal_id.clone(),
            body: body.to_owned(),
            kind: QueuedAgentMessageKind::Agent,
        })?;
        self.emit(
            &record,
            AgentEventKind::AgentMessageQueued,
            AgentEventPayload::Message {
                message_id: message_id.clone(),
            },
        );
        Ok(json!({ "messageId": message_id, "queued": true }))
    }

    pub fn handle_event(&self, event: &AgentEventEnvelope) {
        let Some(agent_id) = event.agent_id.as_deref() else {
            return;
        };
        if matches!(
            event.kind,
            AgentEventKind::AgentExited | AgentEventKind::AgentFailed
        ) {
            let messages = match self.inbox.drain(agent_id) {
                Ok(messages) => messages,
                Err(_) => return,
            };
            self.clear_pending_delivery_acks(agent_id);
            for message in messages {
                self.fail_queued_message(message);
            }
            return;
        }
        if event.kind != AgentEventKind::AgentPromptDetected {
            return;
        }
        let Ok(record) = self.record(&event.project_id, agent_id) else {
            return;
        };
        if record.paused {
            return;
        }
        self.retry_pending_delivery_ack(agent_id);
        let message = match self.inbox.take_next(agent_id) {
            Ok(Some(message)) => message,
            Ok(None) | Err(_) => return,
        };
        if message.project_id != record.project_id {
            let _ = self.inbox.ack(&record.agent_id, &message.message_id);
            self.fail_queued_message(message);
            return;
        }
        let result = self.backend.deliver(&record.terminal_id, &message.body);
        if result.is_err() {
            if self
                .inbox
                .requeue(&record.agent_id, &message.message_id)
                .is_ok_and(|requeued| requeued)
            {
                return;
            }
        } else if self
            .inbox
            .ack(&record.agent_id, &message.message_id)
            .is_err()
        {
            if let Ok(mut pending) = self.delivery_ack_pending.lock() {
                pending.insert(
                    (record.agent_id.clone(), message.message_id.clone()),
                    message,
                );
            }
            return;
        }
        self.emit_delivery_result(&record, message, result.is_ok());
    }

    fn emit_delivery_result(&self, record: &TeamAgent, message: QueuedAgentMessage, delivered: bool) {
        match message.kind {
            QueuedAgentMessageKind::Agent => {
                let kind = if delivered {
                    AgentEventKind::AgentMessageDelivered
                } else {
                    AgentEventKind::AgentMessageFailed
                };
                self.emit(
                    &record,
                    kind,
                    AgentEventPayload::Message {
                        message_id: message.message_id,
                    },
                );
            }
            QueuedAgentMessageKind::Taxchat {
                message_id,
                sender_agent_id,
                body,
                recipient_ids,
            } => {
                self.emit_taxchat_event(
                    &record.project_id,
                    sender_agent_id,
                    if delivered {
                        AgentEventKind::TaxchatMessageDelivered
                    } else {
                        AgentEventKind::TaxchatMessageFailed
                    },
                    message_id,
                    body,
                    recipient_ids,
                    Vec::new(),
                    if delivered {
                        vec![record.agent_id.clone()]
                    } else {
                        Vec::new()
                    },
                    if !delivered {
                        vec![record.agent_id.clone()]
                    } else {
                        Vec::new()
                    },
                );
            }
        }
    }

    fn retry_pending_delivery_ack(&self, agent_id: &str) {
        let key = self
            .delivery_ack_pending
            .lock()
            .ok()
            .and_then(|pending| {
                pending
                    .keys()
                    .find(|(queued_agent_id, _)| queued_agent_id == agent_id)
                    .cloned()
            });
        let Some((queued_agent_id, message_id)) = key else {
            return;
        };
        let message = self
            .delivery_ack_pending
            .lock()
            .ok()
            .and_then(|mut pending| pending.remove(&(queued_agent_id.clone(), message_id.clone())));
        let Some(message) = message else {
            return;
        };
        if self.inbox.ack(&queued_agent_id, &message_id).is_err() {
            if let Ok(mut pending) = self.delivery_ack_pending.lock() {
                pending.insert((queued_agent_id, message_id), message);
            }
            return;
        }
        if let Ok(record) = self.record(&message.project_id, &message.agent_id) {
            self.emit_delivery_result(&record, message, true);
        }
    }

    fn clear_pending_delivery_acks(&self, agent_id: &str) {
        if let Ok(mut pending) = self.delivery_ack_pending.lock() {
            pending.retain(|(queued_agent_id, _), _| queued_agent_id != agent_id);
        }
    }

    fn fail_queued_message(&self, message: QueuedAgentMessage) {
        match message.kind {
            QueuedAgentMessageKind::Agent => {
                if let Ok(record) = self.record(&message.project_id, &message.agent_id) {
                    self.emit(
                        &record,
                        AgentEventKind::AgentMessageFailed,
                        AgentEventPayload::Message {
                            message_id: message.message_id,
                        },
                    );
                }
            }
            QueuedAgentMessageKind::Taxchat {
                message_id,
                sender_agent_id,
                body,
                recipient_ids,
            } => self.emit_taxchat_event(
                &message.project_id,
                sender_agent_id,
                AgentEventKind::TaxchatMessageFailed,
                message_id,
                body,
                recipient_ids,
                Vec::new(),
                Vec::new(),
                vec![message.agent_id],
            ),
        }
    }

    fn emit_taxchat_event(
        &self,
        project_id: &str,
        sender_agent_id: Option<String>,
        kind: AgentEventKind,
        message_id: String,
        body: String,
        recipient_ids: Vec<String>,
        queued_ids: Vec<String>,
        delivered_ids: Vec<String>,
        failed_ids: Vec<String>,
    ) {
        let mut event = AgentEventEnvelope::new(
            Uuid::new_v4().to_string(),
            project_id.to_owned(),
            sender_agent_id,
            kind,
            AgentEventPayload::Taxchat {
                message_id,
                body,
                recipient_ids,
                queued_ids,
                delivered_ids,
                failed_ids,
            },
        );
        event.source = AgentEventSource::Taxchat;
        self.backend.emit(event);
    }

    pub fn send_taxchat(
        &self,
        project_id: &str,
        sender_agent_id: Option<&str>,
        body: &str,
        recipient_ids: &[String],
    ) -> Result<Value, ControlError> {
        if project_id.trim().is_empty() || project_id == "*" {
            return Err(ControlError::new(
                ControlErrorCode::InvalidControlRequest,
                "TaxChat requires one project",
            ));
        }
        if body.trim().is_empty() || body.len() > MAX_TASK_BYTES {
            return Err(ControlError::new(
                ControlErrorCode::InvalidControlRequest,
                "TaxChat message must be between 1 and 16384 bytes",
            ));
        }
        let mut seen = HashSet::new();
        let recipients: Vec<String> = recipient_ids
            .iter()
            .filter(|id| !id.trim().is_empty() && id.len() <= 128 && seen.insert((*id).clone()))
            .cloned()
            .take(MAX_TEAM_AGENTS + 1)
            .collect();
        if recipients.is_empty() || recipients.len() > MAX_TEAM_AGENTS {
            return Err(ControlError::new(
                ControlErrorCode::InvalidControlRequest,
                "TaxChat requires between 1 and 12 unique recipients",
            ));
        }

        let message_id = Uuid::new_v4().to_string();
        let sender = sender_agent_id.unwrap_or("user");
        let delivery = format_taxchat_delivery(sender, &recipients, body);
        let mut queued_ids = Vec::new();
        let mut failed_ids = Vec::new();
        for agent_id in &recipients {
            let result = self.record(project_id, agent_id).and_then(|record| {
                if record.paused {
                    return Err(ControlError::new(
                        ControlErrorCode::CapabilityDenied,
                        "Agent is paused",
                    ));
                }
                self.inbox.enqueue(QueuedAgentMessage {
                    message_id: message_id.clone(),
                    project_id: record.project_id.clone(),
                    agent_id: record.agent_id.clone(),
                    terminal_id: record.terminal_id.clone(),
                    body: delivery.clone(),
                    kind: QueuedAgentMessageKind::Taxchat {
                        message_id: message_id.clone(),
                        sender_agent_id: sender_agent_id.map(str::to_owned),
                        body: body.trim().to_owned(),
                        recipient_ids: recipients.clone(),
                    },
                })
            });
            if result.is_ok() {
                queued_ids.push(agent_id.clone());
            } else {
                failed_ids.push(agent_id.clone());
            }
        }

        let kind = if queued_ids.is_empty() {
            AgentEventKind::TaxchatMessageFailed
        } else {
            AgentEventKind::TaxchatMessageQueued
        };
        self.emit_taxchat_event(
            project_id,
            sender_agent_id.map(str::to_owned),
            kind,
            message_id.clone(),
            body.trim().to_owned(),
            recipients.clone(),
            queued_ids.clone(),
            Vec::new(),
            failed_ids.clone(),
        );
        Ok(json!({
            "messageId": message_id,
            "recipientIds": recipients,
            "queuedIds": queued_ids,
            "deliveredIds": [],
            "failedIds": failed_ids,
        }))
    }

    pub fn read(&self, project_id: &str, agent_id: &str) -> Result<Value, ControlError> {
        self.record(project_id, agent_id)?;
        let (status, output) = self.backend.read(agent_id)?;
        let mut start = output.len().saturating_sub(MAX_READ_BYTES);
        while start < output.len() && !output.is_char_boundary(start) {
            start += 1;
        }
        Ok(json!({ "agentId": agent_id, "status": status, "output": &output[start..] }))
    }

    pub fn pause(&self, project_id: &str, agent_id: &str) -> Result<Value, ControlError> {
        self.record(project_id, agent_id)?;
        let mut records = self.records.lock().map_err(lock_error)?;
        let record = records
            .get_mut(agent_id)
            .filter(|record| record.project_id == project_id)
            .ok_or_else(session_not_found)?;
        record.paused = true;
        let copy = record.clone();
        drop(records);
        self.emit(&copy, AgentEventKind::AgentPaused, AgentEventPayload::Empty);
        Ok(json!({ "agentId": agent_id, "paused": true }))
    }

    pub fn focus(&self, project_id: &str, agent_id: &str) -> Result<Value, ControlError> {
        let record = self.record(project_id, agent_id)?;
        self.emit(
            &record,
            AgentEventKind::AgentFocusRequested,
            AgentEventPayload::Empty,
        );
        Ok(json!({ "agentId": agent_id, "requested": true }))
    }

    pub fn stop(&self, project_id: &str, agent_id: &str) -> Result<Value, ControlError> {
        let record = self.record(project_id, agent_id)?;
        self.backend.stop(agent_id)?;
        let drained = self.inbox.drain(agent_id)?;
        self.clear_pending_delivery_acks(agent_id);
        for message in drained {
            self.fail_queued_message(message);
        }
        if let Some(token) = self
            .child_tokens
            .lock()
            .map_err(lock_error)?
            .remove(agent_id)
        {
            self.tokens.revoke(&token);
        }
        self.emit(
            &record,
            AgentEventKind::AgentStopped,
            AgentEventPayload::Empty,
        );
        Ok(json!({ "agentId": agent_id, "stopped": true }))
    }

    pub fn list(&self, project_id: &str) -> Result<Vec<TeamAgent>, ControlError> {
        Ok(self
            .records
            .lock()
            .map_err(lock_error)?
            .values()
            .filter(|record| project_id == "*" || record.project_id == project_id)
            .cloned()
            .collect())
    }

    fn record(&self, project_id: &str, agent_id: &str) -> Result<TeamAgent, ControlError> {
        if let Some(record) = self
            .records
            .lock()
            .map_err(lock_error)?
            .get(agent_id)
            .filter(|record| project_id == "*" || record.project_id == project_id)
            .cloned()
        {
            return Ok(record);
        }
        let recovered = self
            .backend
            .recover_agent(project_id, agent_id)?
            .ok_or_else(session_not_found)?;
        self.records
            .lock()
            .map_err(lock_error)?
            .insert(agent_id.to_owned(), recovered.clone());
        Ok(recovered)
    }

    fn emit(&self, child: &TeamAgent, kind: AgentEventKind, payload: AgentEventPayload) {
        let mut event = AgentEventEnvelope::new(
            Uuid::new_v4().to_string(),
            child.project_id.clone(),
            Some(child.agent_id.clone()),
            kind,
            payload,
        );
        event.parent_agent_id = child.parent_agent_id.clone();
        event.source = AgentEventSource::Api;
        self.backend.emit(event);
    }
}

pub struct RuntimeTeamBackend {
    pty: PtyManager,
    agents: AgentManager,
    supervisor: Arc<Supervisor>,
    sink: Arc<dyn EventSink>,
}

impl RuntimeTeamBackend {
    pub fn new(
        pty: PtyManager,
        agents: AgentManager,
        supervisor: Arc<Supervisor>,
        sink: Arc<dyn EventSink>,
    ) -> Self {
        Self {
            pty,
            agents,
            supervisor,
            sink,
        }
    }
}

impl TeamBackend for RuntimeTeamBackend {
    fn active_agent_count(&self, project_id: &str) -> Result<usize, ControlError> {
        let sessions = self
            .supervisor
            .reconnect(SUPERVISOR_PROTOCOL_VERSION, 0)
            .map_err(control_runtime)?
            .sessions;
        Ok(sessions
            .into_iter()
            .filter(|session| {
                session.project_id == project_id
                    && self
                        .pty
                        .session_status(&session.terminal_id)
                        .is_ok_and(|status| status == TerminalStatus::Running)
            })
            .count())
    }

    fn agent_exists(&self, project_id: &str, agent_id: &str) -> Result<bool, ControlError> {
        Ok(self
            .supervisor
            .reconnect(SUPERVISOR_PROTOCOL_VERSION, 0)
            .map_err(control_runtime)?
            .sessions
            .iter()
            .any(|session| session.project_id == project_id && session.agent_id == agent_id))
    }

    fn recover_agent(
        &self,
        project_id: &str,
        agent_id: &str,
    ) -> Result<Option<TeamAgent>, ControlError> {
        let descriptor = match self.supervisor.read_session(agent_id) {
            Ok((descriptor, _)) => descriptor,
            Err(_) => return Ok(None),
        };
        if project_id != "*" && descriptor.project_id != project_id {
            return Ok(None);
        }
        Ok(Some(TeamAgent {
            agent_id: descriptor.agent_id,
            parent_agent_id: descriptor.parent_agent_id,
            project_id: descriptor.project_id,
            provider_id: descriptor.provider_id,
            name: descriptor.name,
            terminal_id: descriptor.terminal_id,
            branch: descriptor.branch,
            worktree_path: descriptor
                .worktree_path
                .unwrap_or(descriptor.working_directory),
            paused: false,
        }))
    }

    fn provider_installed(&self, provider_id: &str) -> bool {
        agents::resolve_provider(provider_id).is_ok()
    }

    fn create_worktree(
        &self,
        project_id: &str,
        provider_id: &str,
    ) -> Result<PreparedWorktree, ControlError> {
        let created = worktree::create_worktree(CreateWorktreeRequest {
            repository_root: project_id.to_owned(),
            provider: provider_id.to_owned(),
            base_branch: None,
        })
        .map_err(|error| {
            ControlError::new(ControlErrorCode::WorktreeCreateFailed, error.to_string())
        })?;
        Ok(PreparedWorktree {
            branch: created.branch,
            path: created.worktree_path,
        })
    }

    fn launch_child(&self, launch: ChildLaunch) -> Result<Agent, ControlError> {
        let runtime_sink = self.supervisor.runtime_sink(self.sink.clone());
        let agent = self
            .agents
            .launch_scoped(
                LaunchAgentRequest {
                    name: launch.name,
                    provider: launch.provider_id,
                    cwd: launch.worktree.path.clone(),
                    create_worktree: false,
                    cols: Some(120),
                    rows: Some(30),
                },
                &self.pty,
                runtime_sink.clone(),
                launch.environment,
                Some(launch.agent_id),
            )
            .map_err(control_runtime)?;
        let agent = self
            .agents
            .set_worktree_metadata(&agent.id, launch.worktree.branch, launch.worktree.path)
            .map_err(|error| {
                let _ = self.agents.abort(&agent.id, &self.pty);
                control_runtime(error)
            })?;
        if let Err(error) = self.pty.bind_agent(
            &agent.terminal_id,
            launch.project_id.clone(),
            agent.id.clone(),
            agent.provider.clone(),
        ) {
            let _ = self.agents.abort(&agent.id, &self.pty);
            return Err(control_runtime(error));
        }
        if let Err(error) = self.supervisor.register_agent_with_parent(
            &agent,
            launch.project_id,
            launch.parent_agent_id,
            runtime_sink,
        ) {
            let _ = self.agents.abort(&agent.id, &self.pty);
            return Err(control_runtime(error));
        }
        Ok(agent)
    }

    fn deliver(&self, terminal_id: &str, body: &str) -> Result<(), ControlError> {
        self.pty
            .write(terminal_id, &format!("{body}\r"))
            .map_err(control_runtime)
    }

    fn read(&self, agent_id: &str) -> Result<(String, String), ControlError> {
        let (_, output) = self
            .supervisor
            .read_session(agent_id)
            .map_err(control_runtime)?;
        let status = self
            .agents
            .list(&self.pty)
            .map_err(control_runtime)?
            .into_iter()
            .find(|agent| agent.id == agent_id)
            .map(|agent| format!("{:?}", agent.status).to_lowercase())
            .unwrap_or_else(|| "offline".into());
        Ok((status, output))
    }

    fn stop(&self, agent_id: &str) -> Result<(), ControlError> {
        self.agents
            .stop(agent_id, &self.pty)
            .map_err(control_runtime)
    }

    fn cleanup_worktree(&self, project_id: &str, path: &str) -> Result<(), ControlError> {
        let target = crate::git::paths::canonical_dir(path).map_err(|error| {
            ControlError::new(ControlErrorCode::WorktreeCleanupFailed, error.to_string())
        })?;
        if let Some(terminal_id) = self
            .pty
            .running_session_at(&target)
            .map_err(|error| {
                ControlError::new(ControlErrorCode::WorktreeCleanupFailed, error.to_string())
            })?
        {
            return Err(ControlError::new(
                ControlErrorCode::WorktreeCleanupFailed,
                format!(
                    "worktree at '{path}' is still in use by terminal '{terminal_id}'; stop it before removing the worktree"
                ),
            ));
        }
        worktree::remove_worktree(RemoveWorktreeRequest {
            repository_root: project_id.to_owned(),
            worktree_path: path.to_owned(),
            force: false,
        })
        .map(|_| ())
        .map_err(|error| {
            ControlError::new(ControlErrorCode::WorktreeCleanupFailed, error.to_string())
        })
    }

    fn emit(&self, event: AgentEventEnvelope) {
        self.sink.emit_control(event);
    }
}

fn validate_spawn(request: &SpawnAgentRequest) -> Result<(), ControlError> {
    if request.project_id.trim().is_empty()
        || request.provider_id.trim().is_empty()
        || request.task.trim().is_empty()
        || request.task.len() > MAX_TASK_BYTES
    {
        return Err(ControlError::new(
            ControlErrorCode::InvalidControlRequest,
            "Project, provider, and a task up to 16384 bytes are required",
        ));
    }
    Ok(())
}

fn child_identity(request: &SpawnAgentRequest, agent_id: &str) -> CallerIdentity {
    CallerIdentity {
        caller_id: agent_id.to_owned(),
        project_id: request.project_id.clone(),
        agent_id: Some(agent_id.to_owned()),
        parent_agent_id: request.parent_agent_id.clone(),
        capabilities: vec![
            Capability::AgentList,
            Capability::AgentSpawn,
            Capability::AgentSend,
            Capability::AgentRead,
            Capability::AttentionRead,
            Capability::AttentionAck,
            Capability::SessionRead,
            Capability::BrowserRead,
            Capability::BrowserControl,
            Capability::TaxChatSend,
        ],
        expires_at: None,
    }
}

fn control_environment(
    request: &SpawnAgentRequest,
    agent_id: &str,
    endpoint: &str,
    token: &str,
    control_executable: Option<&Path>,
) -> HashMap<OsString, OsString> {
    let mut environment = HashMap::new();
    for (key, value) in [
        ("ZLI_PROJECT_ID", request.project_id.as_str()),
        ("ZLI_AGENT_ID", agent_id),
        (
            "ZLI_PARENT_AGENT_ID",
            request.parent_agent_id.as_deref().unwrap_or(""),
        ),
        ("ZLI_CONTROL_ENDPOINT", endpoint),
        ("ZLI_CONTROL_TOKEN", token),
    ] {
        environment.insert(OsString::from(key), OsString::from(value));
    }
    if let Some(executable) = control_executable {
        environment.insert("ZLI_COMMAND".into(), executable.as_os_str().to_owned());
        if let Some(directory) = executable.parent() {
            let inherited: Vec<PathBuf> = env::var_os("PATH")
                .map(|value| env::split_paths(&value).collect())
                .unwrap_or_default();
            let paths = std::iter::once(directory.to_path_buf()).chain(inherited);
            if let Ok(path) = env::join_paths(paths) {
                environment.insert("PATH".into(), path);
            }
        }
    }
    environment
}

fn format_taxchat_delivery(sender: &str, recipients: &[String], body: &str) -> String {
    format!(
        "\n[TaxChat delivery]\nFrom: {sender}\nTo: {}\n\n{}\n\nTo reply, emit:\n[[TAXCHAT:to=user]]\nYour message\n[[/TAXCHAT]]\n",
        recipients.join(", "),
        body.trim()
    )
}

pub fn zli_executable_path() -> Option<PathBuf> {
    let directory = env::current_exe().ok()?.parent()?.to_path_buf();
    Some(directory.join(if cfg!(windows) { "zli.exe" } else { "zli" }))
}

fn lock_error<T>(_: std::sync::PoisonError<T>) -> ControlError {
    ControlError::new(
        ControlErrorCode::ControlRuntimeError,
        "Team state is unavailable",
    )
}
fn session_not_found() -> ControlError {
    ControlError::new(
        ControlErrorCode::SessionNotFound,
        "Agent session was not found",
    )
}
fn control_runtime(error: impl std::fmt::Debug) -> ControlError {
    ControlError::new(ControlErrorCode::ControlRuntimeError, format!("{error:?}"))
}
fn persistence_error(error: impl std::fmt::Display) -> ControlError {
    ControlError::new(
        ControlErrorCode::ControlRuntimeError,
        format!("Pending message queue is unavailable: {error}"),
    )
}
fn queue_data_error(message: impl Into<String>) -> ControlError {
    ControlError::new(ControlErrorCode::ControlRuntimeError, message)
}
