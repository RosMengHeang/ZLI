use super::{
    delivery_desk::{DeliveryDesk, PullReceipt, ReadinessObservation, ReadinessView},
    AgentEventEnvelope, AgentEventKind, AgentEventPayload, AgentEventSource, ControlError,
    ControlErrorCode, LaunchIntent, ManagedAgentContext, ManagedLaunch, SnapshotStore, Supervisor,
    SUPERVISOR_PROTOCOL_VERSION,
};
use crate::agents::{
    self,
    providers::{DeliveryKind, ProviderCapabilityReport, ProviderRegistry},
    Agent, AgentManager, LaunchAgentRequest,
};
use crate::git::worktree::{self, CreateWorktreeRequest, RemoveWorktreeRequest};
use crate::pty::{EventSink, PtyManager, TerminalStatus};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};
#[cfg(test)]
use std::sync::atomic::{AtomicUsize, Ordering};
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

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserAgentCapability {
    pub profile_id: String,
    pub shell_fallback_available: bool,
    pub mcp_adapter_available: bool,
    pub mcp_provider_configured: bool,
    pub mode: String,
    pub reason: String,
    pub adapter_command: Option<String>,
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
    pub readiness: ReadinessView,
    pub delivery: DeliveryKind,
}

#[derive(Clone, Default)]
pub struct AgentMessageInbox {
    pending: Arc<Mutex<HashMap<String, VecDeque<QueuedAgentMessage>>>>,
    in_flight: Arc<Mutex<HashMap<(String, String), QueuedAgentMessage>>>,
    store: Option<SnapshotStore>,
    #[cfg(test)]
    fail_next_persist: Arc<AtomicUsize>,
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
            #[cfg(test)]
            fail_next_persist: Arc::new(AtomicUsize::new(0)),
        })
    }

    #[cfg(test)]
    pub(crate) fn fail_next_persist(&self) {
        self.fail_next_persist.store(1, Ordering::SeqCst);
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
                readiness: ReadinessView::Unknown,
                delivery: DeliveryKind::MintedSlots,
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
                    readiness: ReadinessView::Unknown,
                    delivery: DeliveryKind::MintedSlots,
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
        #[cfg(test)]
        if self.fail_next_persist.swap(0, Ordering::SeqCst) > 0 {
            return Err(ControlError::new(
                ControlErrorCode::ControlRuntimeError,
                "injected inbox persistence failure",
            ));
        }
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

pub trait TeamBackend: Send + Sync {
    fn active_agent_count(&self, project_id: &str) -> Result<usize, ControlError>;
    fn begin_agent_launch(&self, _project_id: &str) -> Result<(), ControlError> {
        Ok(())
    }
    fn end_agent_launch(&self, _project_id: &str) {}
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
    fn launch_child(
        &self,
        launch: &ManagedLaunch,
        name: String,
        worktree: PreparedWorktree,
    ) -> Result<Agent, ControlError>;
    fn deliver(&self, terminal_id: &str, body: &str) -> Result<(), ControlError>;
    fn read(&self, agent_id: &str) -> Result<(String, String), ControlError>;
    fn stop(&self, agent_id: &str) -> Result<(), ControlError>;
    /// Abort a child launch transaction and forget its session metadata.
    /// Normal user stops intentionally keep metadata available for resume.
    fn abort(&self, agent_id: &str) -> Result<(), ControlError> {
        self.stop(agent_id)
    }
    fn cleanup_worktree(&self, project_id: &str, path: &str) -> Result<(), ControlError>;
    fn emit(&self, event: AgentEventEnvelope);
}

struct LaunchSlotGuard<'a> {
    backend: &'a dyn TeamBackend,
    project_id: String,
}

impl Drop for LaunchSlotGuard<'_> {
    fn drop(&mut self) {
        self.backend.end_agent_launch(&self.project_id);
    }
}

pub struct TeamCoordinator {
    backend: Arc<dyn TeamBackend>,
    context: ManagedAgentContext,
    providers: ProviderRegistry,
    desk: DeliveryDesk,
    records: Mutex<HashMap<String, TeamAgent>>,
    inbox: AgentMessageInbox,
    delivery_ack_pending: Mutex<HashMap<(String, String), QueuedAgentMessage>>,
    delivery_requeue_pending: Mutex<HashMap<(String, String), QueuedAgentMessage>>,
    exit_cleanup_pending: Mutex<HashSet<String>>,
    starting_agents: Mutex<HashSet<String>>,
    early_exit_pending: Mutex<HashSet<String>>,
}

impl TeamCoordinator {
    pub fn new(backend: Arc<dyn TeamBackend>, context: ManagedAgentContext) -> Self {
        Self {
            backend,
            context,
            providers: ProviderRegistry::default(),
            desk: DeliveryDesk::new(),
            records: Mutex::new(HashMap::new()),
            inbox: AgentMessageInbox::default(),
            delivery_ack_pending: Mutex::new(HashMap::new()),
            delivery_requeue_pending: Mutex::new(HashMap::new()),
            exit_cleanup_pending: Mutex::new(HashSet::new()),
            starting_agents: Mutex::new(HashSet::new()),
            early_exit_pending: Mutex::new(HashSet::new()),
        }
    }

    pub fn context(&self) -> &ManagedAgentContext {
        &self.context
    }

    pub fn with_message_store(mut self, store: SnapshotStore) -> Result<Self, ControlError> {
        self.inbox = AgentMessageInbox::with_store(store)?;
        Ok(self)
    }

    #[cfg(test)]
    pub(crate) fn fail_next_inbox_persist(&self) {
        self.inbox.fail_next_persist();
    }

    pub fn queue_status(
        &self,
        project_id: Option<&str>,
    ) -> Result<Vec<AgentQueueStatus>, ControlError> {
        self.retry_pending_exit_cleanups();
        let mut statuses = BTreeMap::<(String, String), AgentQueueStatus>::new();
        for status in self.inbox.queue_status(project_id)? {
            statuses.insert((status.project_id.clone(), status.agent_id.clone()), status);
        }
        let records = self.records.lock().map_err(lock_error)?;
        for record in records.values() {
            if project_id.is_some_and(|requested| requested != record.project_id) {
                continue;
            }
            let delivery = self.delivery_kind_for(&record.provider_id);
            let readiness = self.desk.view(&record.agent_id);
            statuses
                .entry((record.project_id.clone(), record.agent_id.clone()))
                .and_modify(|status| {
                    status.readiness = readiness.clone();
                    status.delivery = delivery;
                })
                .or_insert_with(|| AgentQueueStatus {
                    project_id: record.project_id.clone(),
                    agent_id: record.agent_id.clone(),
                    pending_count: 0,
                    in_flight_count: 0,
                    oldest_message_id: None,
                    readiness,
                    delivery,
                });
        }
        Ok(statuses.into_values().collect())
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

        self.backend.begin_agent_launch(&request.project_id)?;
        let _launch_slot = LaunchSlotGuard {
            backend: self.backend.as_ref(),
            project_id: request.project_id.clone(),
        };

        let launch = self.context.prepare(LaunchIntent::Child {
            project_id: &request.project_id,
            provider_id: &request.provider_id,
            parent_agent_id: request.parent_agent_id.as_deref(),
        })?;
        let worktree = self
            .backend
            .create_worktree(&request.project_id, &request.provider_id)?;
        let agent_id = launch.agent().agent_id.clone();
        self.starting_agents
            .lock()
            .map_err(lock_error)?
            .insert(agent_id.clone());
        self.desk
            .bind(&agent_id, self.delivery_kind_for(&request.provider_id))?;

        let name = request
            .name
            .clone()
            .unwrap_or_else(|| format!("{} child", request.provider_id));
        let agent = match self.backend.launch_child(&launch, name, worktree.clone()) {
            Ok(agent) => agent,
            Err(error) => {
                self.forget_starting_agent(&agent_id);
                let _ = self.desk.apply(ReadinessObservation::Exited {
                    agent_id: agent_id.clone(),
                });
                self.retire_coordination_record(&agent_id);
                let _ = self
                    .backend
                    .cleanup_worktree(&request.project_id, &worktree.path);
                return Err(error);
            }
        };

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
        if let Err(error) = self.inbox.enqueue(QueuedAgentMessage {
            message_id: Uuid::new_v4().to_string(),
            project_id: child.project_id.clone(),
            agent_id: child.agent_id.clone(),
            terminal_id: child.terminal_id.clone(),
            body: request.task.clone(),
            kind: QueuedAgentMessageKind::Agent,
        }) {
            self.forget_starting_agent(&child.agent_id);
            let _ = self.desk.apply(ReadinessObservation::Exited {
                agent_id: child.agent_id.clone(),
            });
            self.retire_coordination_record(&child.agent_id);
            let _ = self.backend.abort(&child.agent_id);
            let _ = self
                .backend
                .cleanup_worktree(&request.project_id, &child.worktree_path);
            return Err(error);
        }
        self.records
            .lock()
            .map_err(lock_error)?
            .insert(child.agent_id.clone(), child.clone());
        launch.commit();
        self.forget_starting_agent(&child.agent_id);
        let exited_during_start = self
            .early_exit_pending
            .lock()
            .map_err(lock_error)?
            .remove(&child.agent_id);
        if exited_during_start {
            let _ = self.drain_inbox_for_exit(&child.agent_id);
            let _ = self.desk.apply(ReadinessObservation::Exited {
                agent_id: child.agent_id.clone(),
            });
            self.context.revoke(&child.agent_id);
            self.retire_coordination_record(&child.agent_id);
        } else if self
            .records
            .lock()
            .map(|records| records.contains_key(&child.agent_id))
            .unwrap_or(false)
        {
            let _ = self.dispatch_ready(&child);
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
        }
        Ok(child)
    }

    pub fn browser_capability(
        &self,
        project_id: &str,
        agent_id: &str,
    ) -> Result<BrowserAgentCapability, ControlError> {
        let _record = self.record(project_id, agent_id)?;
        let sidecars = self.context.sidecars();
        let adapter_command = sidecars.as_ref().ok().map(|paths| {
            paths.browser_use().to_string_lossy().into_owned()
        });
        let shell_fallback_available = sidecars.is_ok();
        let mcp_adapter_available = sidecars.is_ok();
        let mcp_provider_configured = false;
        let mode = if mcp_provider_configured {
            "mcp"
        } else if shell_fallback_available {
            "shell_fallback"
        } else {
            "unsupported"
        };
        let reason = if mcp_provider_configured {
            "The provider launch adapter accepted the ZLI Browser Use configuration."
        } else if shell_fallback_available {
            "Use the scoped zli browser commands; this provider has no configured MCP launch adapter yet."
        } else {
            "The ZLI command was not available to this managed session."
        };
        Ok(BrowserAgentCapability {
            profile_id: "clean".into(),
            shell_fallback_available,
            mcp_adapter_available,
            mcp_provider_configured,
            mode: mode.into(),
            reason: reason.into(),
            adapter_command,
        })
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
        let scheduled = self.dispatch_ready(&record)?.is_some();
        Ok(json!({ "messageId": message_id, "queued": true, "scheduled": scheduled }))
    }

    pub fn handle_event(&self, event: &AgentEventEnvelope) {
        self.retry_pending_exit_cleanups();
        let Some(agent_id) = event.agent_id.as_deref() else {
            return;
        };
        self.context.touch(agent_id);
        if matches!(
            event.kind,
            AgentEventKind::AgentExited | AgentEventKind::AgentFailed
        ) {
            let _ = self.desk.apply(ReadinessObservation::Exited {
                agent_id: agent_id.to_owned(),
            });
            self.cleanup_exited_agent(agent_id);
            return;
        }
        match event.kind {
            AgentEventKind::AgentPromptDetected => {
                let reason = match &event.payload {
                    AgentEventPayload::Attention { reason } if reason == "claude_code_prompt_marker" => {
                        "claude_code_prompt_marker"
                    }
                    AgentEventPayload::Attention { reason } if reason == "codex_prompt_marker" => {
                        "codex_prompt_marker"
                    }
                    _ => "provider_prompt",
                };
                let _ = self.desk.apply(ReadinessObservation::MintGlyph {
                    agent_id: agent_id.to_owned(),
                    reason,
                });
            }
            AgentEventKind::AgentLocalInput => {
                let _ = self.desk.apply(ReadinessObservation::LocalInput {
                    agent_id: agent_id.to_owned(),
                });
                return;
            }
            _ => {}
        }
        if self
            .exit_cleanup_pending
            .lock()
            .map(|pending| pending.contains(agent_id))
            .unwrap_or(true)
        {
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
        let _ = self.dispatch_ready(&record);
    }

    fn cleanup_exited_agent(&self, agent_id: &str) {
        let messages = match self.inbox.drain(agent_id) {
            Ok(messages) => messages,
            Err(_) => {
                if let Ok(mut pending) = self.exit_cleanup_pending.lock() {
                    pending.insert(agent_id.to_owned());
                }
                return;
            }
        };
        if let Ok(mut pending) = self.exit_cleanup_pending.lock() {
            pending.remove(agent_id);
        }
        self.clear_pending_delivery_acks(agent_id);
        self.clear_pending_delivery_requeues(agent_id);
        for message in messages {
            self.fail_queued_message(message);
        }
        let has_coordination_state = self
            .records
            .lock()
            .map(|records| records.contains_key(agent_id))
            .unwrap_or(false);
        let is_starting = self
            .starting_agents
            .lock()
            .map(|starting| starting.contains(agent_id))
            .unwrap_or(false);
        if is_starting {
            if let Ok(mut pending) = self.early_exit_pending.lock() {
                pending.insert(agent_id.to_owned());
            }
        } else if has_coordination_state {
            self.context.revoke(agent_id);
            self.retire_coordination_record(agent_id);
        } else {
            self.context.revoke(agent_id);
        }
    }

    fn retry_pending_exit_cleanups(&self) {
        let agents = self
            .exit_cleanup_pending
            .lock()
            .map(|pending| pending.iter().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        for agent_id in agents {
            self.cleanup_exited_agent(&agent_id);
        }
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
                    record,
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

    fn retry_pending_delivery_requeue(&self, agent_id: &str) {
        let key = self
            .delivery_requeue_pending
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
            .delivery_requeue_pending
            .lock()
            .ok()
            .and_then(|mut pending| pending.remove(&(queued_agent_id.clone(), message_id.clone())));
        let Some(message) = message else {
            return;
        };
        match self.inbox.requeue(&queued_agent_id, &message_id) {
            Ok(true) => {}
            Ok(false) => (),
            Err(_) => {
                if let Ok(mut pending) = self.delivery_requeue_pending.lock() {
                    pending.insert((queued_agent_id, message_id), message);
                }
            }
        }
    }

    fn clear_pending_delivery_requeues(&self, agent_id: &str) {
        if let Ok(mut pending) = self.delivery_requeue_pending.lock() {
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
        let mut scheduled = false;
        for agent_id in &queued_ids {
            if let Ok(record) = self.record(project_id, agent_id) {
                if self.dispatch_ready(&record)?.is_some() {
                    scheduled = true;
                }
            }
        }
        Ok(json!({
            "messageId": message_id,
            "recipientIds": recipients,
            "queuedIds": queued_ids,
            "deliveredIds": [],
            "failedIds": failed_ids,
            "scheduled": scheduled,
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
        let record = match self.record(project_id, agent_id) {
            Ok(record) => Some(record),
            Err(error) if error.code == ControlErrorCode::SessionNotFound => None,
            Err(error) => return Err(error),
        };
        self.backend.stop(agent_id)?;
        let drained = self.inbox.drain(agent_id)?;
        self.clear_pending_delivery_acks(agent_id);
        self.clear_pending_delivery_requeues(agent_id);
        let _ = self.desk.apply(ReadinessObservation::Exited {
            agent_id: agent_id.to_owned(),
        });
        for message in drained {
            self.fail_queued_message(message);
        }
        self.context.revoke(agent_id);
        self.retire_coordination_record(agent_id);
        if let Some(record) = record {
            self.emit(
                &record,
                AgentEventKind::AgentStopped,
                AgentEventPayload::Empty,
            );
        }
        Ok(json!({ "agentId": agent_id, "stopped": true }))
    }

    pub fn pull(&self, project_id: &str, agent_id: &str) -> Result<PullReceipt, ControlError> {
        let record = self.record(project_id, agent_id)?;
        if record.paused {
            return Err(ControlError::new(
                ControlErrorCode::CapabilityDenied,
                "Agent is paused",
            ));
        }
        if self.delivery_kind_for(&record.provider_id) == DeliveryKind::MintedSlots {
            return Err(ControlError::new(
                ControlErrorCode::CapabilityDenied,
                "This provider mints delivery slots from its prompt; pull is not available",
            ));
        }
        self.desk.arm_pull(&record.agent_id)?;
        let minted = self.desk.view(&record.agent_id) == ReadinessView::Ready;
        let delivered = self.dispatch_ready(&record)?;
        Ok(PullReceipt {
            minted,
            delivered: delivered.is_some(),
            message_id: delivered.map(|message| message.message_id),
        })
    }

    pub fn capability_report(
        &self,
        provider_id: &str,
    ) -> Result<ProviderCapabilityReport, ControlError> {
        let shell_tools_available = self.context.sidecars().is_ok();
        self.providers
            .capability_report(provider_id, shell_tools_available)
            .ok_or_else(|| {
                ControlError::new(
                    ControlErrorCode::ProviderNotInstalled,
                    "The selected provider is not installed",
                )
            })
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
        self.desk
            .bind(&recovered.agent_id, self.delivery_kind_for(&recovered.provider_id))?;
        self.records
            .lock()
            .map_err(lock_error)?
            .insert(agent_id.to_owned(), recovered.clone());
        Ok(recovered)
    }

    fn retire_coordination_record(&self, agent_id: &str) {
        if let Ok(mut records) = self.records.lock() {
            records.remove(agent_id);
        }
        if let Ok(mut pending) = self.exit_cleanup_pending.lock() {
            pending.remove(agent_id);
        }
        if let Ok(mut pending) = self.early_exit_pending.lock() {
            pending.remove(agent_id);
        }
    }

    fn forget_starting_agent(&self, agent_id: &str) {
        if let Ok(mut starting) = self.starting_agents.lock() {
            starting.remove(agent_id);
        }
    }

    fn delivery_kind_for(&self, provider_id: &str) -> DeliveryKind {
        self.providers
            .get(provider_id)
            .map(crate::agents::providers::ProviderAdapter::delivery_kind)
            .unwrap_or(DeliveryKind::ExplicitPull)
    }

    fn dispatch_ready(
        &self,
        record: &TeamAgent,
    ) -> Result<Option<QueuedAgentMessage>, ControlError> {
        self.retry_pending_delivery_ack(&record.agent_id);
        self.retry_pending_delivery_requeue(&record.agent_id);
        let delivered = self.desk.try_dispatch(
            &self.inbox,
            self.backend.as_ref(),
            record,
            &self.delivery_ack_pending,
            &self.delivery_requeue_pending,
        )?;
        if let Some(message) = delivered.as_ref() {
            self.emit_delivery_result(record, message.clone(), true);
        }
        Ok(delivered)
    }

    fn drain_inbox_for_exit(&self, agent_id: &str) -> Result<(), ControlError> {
        let messages = self.inbox.drain(agent_id)?;
        self.clear_pending_delivery_acks(agent_id);
        self.clear_pending_delivery_requeues(agent_id);
        for message in messages {
            self.fail_queued_message(message);
        }
        Ok(())
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
            .any(|session| {
                session.project_id == project_id
                    && session.agent_id == agent_id
                    && self
                        .pty
                        .session_status(&session.terminal_id)
                        .is_ok_and(|status| status == TerminalStatus::Running)
            }))
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
        if !matches!(
            self.pty.session_status(&descriptor.terminal_id),
            Ok(TerminalStatus::Running)
        ) {
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

    fn launch_child(
        &self,
        launch: &ManagedLaunch,
        name: String,
        worktree: PreparedWorktree,
    ) -> Result<Agent, ControlError> {
        let runtime_sink = self.supervisor.runtime_sink(launch.sink());
        let agent = self
            .agents
            .launch_scoped(
                &LaunchAgentRequest {
                    name,
                    provider: launch.agent().provider_id.clone(),
                    cwd: worktree.path.clone(),
                    create_worktree: false,
                    restart_agent_id: None,
                    cols: Some(120),
                    rows: Some(30),
                },
                &self.pty,
                runtime_sink.clone(),
                launch.environment(),
                launch.agent().agent_id.clone(),
            )
            .map_err(control_runtime)?;
        let agent = self
            .agents
            .set_worktree_metadata(&agent.id, worktree.branch, worktree.path)
            .map_err(|error| {
                let _ = self.agents.abort(&agent.id, &self.pty);
                control_runtime(error)
            })?;
        if let Err(error) = self.pty.bind_agent(
            &agent.terminal_id,
            launch.agent().project_id.clone(),
            agent.id.clone(),
            agent.provider.clone(),
        ) {
            let _ = self.agents.abort(&agent.id, &self.pty);
            return Err(control_runtime(error));
        }
        if let Err(error) = self.supervisor.register_agent_with_parent(
            &agent,
            launch.agent().project_id.clone(),
            launch.agent().parent_agent_id.clone(),
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
        match self.agents.stop(agent_id, &self.pty) {
            Ok(()) | Err(crate::error::BackendError::SessionNotFound(_)) => Ok(()),
            Err(error) => Err(control_runtime(error)),
        }
    }

    fn begin_agent_launch(&self, project_id: &str) -> Result<(), ControlError> {
        if self
            .supervisor
            .reserve_agent_slot(project_id)
            .map_err(control_runtime)?
        {
            Ok(())
        } else {
            Err(ControlError::new(
                ControlErrorCode::AgentLimitReached,
                "This project already has 12 agents",
            ))
        }
    }

    fn end_agent_launch(&self, project_id: &str) {
        self.supervisor.release_agent_slot(project_id);
    }

    fn abort(&self, agent_id: &str) -> Result<(), ControlError> {
        self.stop(agent_id)?;
        let descriptor = match self.supervisor.read_session(agent_id) {
            Ok((descriptor, _)) => descriptor,
            Err(super::SessionCommandError::MissingSession(_)) => return Ok(()),
            Err(error) => {
                return Err(ControlError::new(
                    ControlErrorCode::ControlRuntimeError,
                    format!("failed to read aborted session: {error:?}"),
                ));
            }
        };
        self.supervisor
            .forget_session(&descriptor.project_id, agent_id)
            .map(|_| ())
            .map_err(|error| {
                ControlError::new(
                    ControlErrorCode::ControlRuntimeError,
                    format!("failed to forget aborted session: {error:?}"),
                )
            })
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

fn format_taxchat_delivery(sender: &str, recipients: &[String], body: &str) -> String {
    format!(
        "\n[TaxChat delivery]\nFrom: {sender}\nTo: {}\n\n{}\n\nTo reply, emit:\n[[TAXCHAT:to=user]]\nYour message\n[[/TAXCHAT]]\n",
        recipients.join(", "),
        body.trim()
    )
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
