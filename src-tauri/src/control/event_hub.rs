use crate::control::AgentEventEnvelope;
use std::collections::{HashSet, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard};

const DEFAULT_CAPACITY: usize = 1_024;

#[derive(Clone)]
pub struct EventHub {
    state: Arc<Mutex<HubState>>,
}

struct HubState {
    sequence: u64,
    events: VecDeque<AgentEventEnvelope>,
    event_ids: HashSet<String>,
    capacity: usize,
}

impl EventHub {
    pub fn new(capacity: usize) -> Self {
        Self {
            state: Arc::new(Mutex::new(HubState {
                sequence: 0,
                events: VecDeque::with_capacity(capacity),
                event_ids: HashSet::with_capacity(capacity),
                capacity,
            })),
        }
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
        if state.capacity > 0 {
            while state.events.len() >= state.capacity {
                state.events.pop_front();
            }
            state.events.push_back(event.clone());
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
