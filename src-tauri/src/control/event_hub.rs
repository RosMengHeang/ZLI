use crate::control::{event_log::DurableEventLog, AgentEventEnvelope};
use serde::Serialize;
use std::collections::{HashSet, VecDeque};
use std::io;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};

const DEFAULT_CAPACITY: usize = 1_024;
const EVENT_ID_DEDUPE_CAPACITY: usize = 32_768;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventHubHealth {
    pub enabled: bool,
    pub healthy: bool,
    pub retained_events: usize,
    pub current_sequence: u64,
    pub error: Option<String>,
}

#[derive(Clone)]
pub struct EventHub {
    state: Arc<Mutex<HubState>>,
    durable: Arc<Mutex<Option<DurableEventLog>>>,
    persistence_error: Arc<Mutex<Option<String>>>,
}

struct HubState {
    sequence: u64,
    events: VecDeque<AgentEventEnvelope>,
    event_ids: HashSet<String>,
    event_id_order: VecDeque<String>,
    capacity: usize,
}

impl EventHub {
    pub fn new(capacity: usize) -> Self {
        Self {
            state: Arc::new(Mutex::new(HubState {
                sequence: 0,
                events: VecDeque::with_capacity(capacity),
                event_ids: HashSet::with_capacity(capacity.min(EVENT_ID_DEDUPE_CAPACITY)),
                event_id_order: VecDeque::with_capacity(capacity.min(EVENT_ID_DEDUPE_CAPACITY)),
                capacity,
            })),
            durable: Arc::new(Mutex::new(None)),
            persistence_error: Arc::new(Mutex::new(None)),
        }
    }

    /// Load the bounded event history before any runtime event is published.
    /// The sequence watermark is restored from disk so reconnect cursors stay
    /// valid across desktop restarts.
    pub fn enable_persistence(&self, root: impl AsRef<Path>) -> io::Result<()> {
        let capacity = self.state().capacity;
        let (log, events) = DurableEventLog::open(root, capacity)?;
        let mut state = self.state();
        if state.sequence != 0 || !state.events.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "event persistence must be enabled before publishing events",
            ));
        }
        state.sequence = events.iter().map(|event| event.sequence).max().unwrap_or(0);
        state.event_ids = events
            .iter()
            .map(|event| event.event_id.clone())
            .collect();
        state.event_id_order = events
            .iter()
            .map(|event| event.event_id.clone())
            .collect();
        state.events = events.into_iter().collect();
        *self
            .durable
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(log);
        Ok(())
    }

    pub fn publish(&self, mut event: AgentEventEnvelope) -> Option<AgentEventEnvelope> {
        let mut state = self.state();
        if state.event_ids.contains(&event.event_id) {
            return None;
        }

        state.sequence = state
            .sequence
            .checked_add(1)
            .expect("event sequence exhausted");
        event.sequence = state.sequence;
        state.event_ids.insert(event.event_id.clone());
        state.event_id_order.push_back(event.event_id.clone());
        while state.event_id_order.len() > EVENT_ID_DEDUPE_CAPACITY {
            if let Some(evicted_id) = state.event_id_order.pop_front() {
                state.event_ids.remove(&evicted_id);
            }
        }
        if state.capacity > 0 {
            while state.events.len() >= state.capacity {
                state.events.pop_front();
            }
            state.events.push_back(event.clone());
        }
        let retained = state.events.iter().cloned().collect::<Vec<_>>();
        if let Ok(mut durable) = self.durable.lock() {
            if let Some(log) = durable.as_mut() {
                if let Err(error) = log.append(&event, &retained) {
                    if let Ok(mut persistence_error) = self.persistence_error.lock() {
                        *persistence_error = Some(error.to_string());
                    }
                }
            }
        }
        Some(event)
    }

    pub fn subscribe_after(&self, cursor: u64) -> Vec<AgentEventEnvelope> {
        self.state()
            .events
            .iter()
            .filter(|event| event.sequence > cursor)
            .cloned()
            .collect()
    }

    pub fn latest_sequence(&self) -> u64 {
        self.state().sequence
    }

    pub fn len(&self) -> usize {
        self.state().events.len()
    }

    pub fn persistence_error(&self) -> Option<String> {
        self.persistence_error
            .lock()
            .ok()
            .and_then(|error| error.clone())
    }

    pub fn health(&self) -> EventHubHealth {
        let enabled = self
            .durable
            .lock()
            .map(|durable| durable.is_some())
            .unwrap_or(false);
        let error = self.persistence_error();
        EventHubHealth {
            enabled,
            healthy: error.is_none(),
            retained_events: self.len(),
            current_sequence: self.latest_sequence(),
            error,
        }
    }

    fn state(&self) -> MutexGuard<'_, HubState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl Default for EventHub {
    fn default() -> Self {
        Self::new(DEFAULT_CAPACITY)
    }
}
