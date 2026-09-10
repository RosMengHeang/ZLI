use super::persistence::sanitize_browser_checkpoint;
use super::{ProjectSnapshot, SessionRegistry, SnapshotStore, SnapshotStoreError};
use serde::Serialize;
use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

pub type SessionCheckpoint = ProjectSnapshot;

pub struct SessionManager {
    registry: Arc<SessionRegistry>,
    store: SnapshotStore,
    next_generation: AtomicU64,
    persisted_generation: Mutex<u64>,
}

impl SessionManager {
    pub fn new(registry: Arc<SessionRegistry>, store: SnapshotStore) -> Self {
        Self {
            registry,
            store,
            next_generation: AtomicU64::new(0),
            persisted_generation: Mutex::new(0),
        }
    }

    pub fn registry(&self) -> &Arc<SessionRegistry> {
        &self.registry
    }

    pub fn checkpoint(
        &self,
        project_id: &str,
        pane_tree: Value,
        browser: Vec<Value>,
        tax_chat_room: Option<Value>,
        last_event_sequence: u64,
    ) -> Result<SessionCheckpoint, SnapshotStoreError> {
        let generation = self.reserve_generation();
        let mut snapshot = ProjectSnapshot::empty(project_id.to_owned());
        snapshot.pane_tree = pane_tree;
        snapshot.browser = browser
            .into_iter()
            .filter_map(sanitize_browser_checkpoint)
            .collect();
        snapshot.tax_chat_room = tax_chat_room;
        snapshot.last_event_sequence = last_event_sequence;
        for session in self
            .registry
            .list()
            .map_err(|error| snapshot_error(error.to_string()))?
        {
            let descriptor = session
                .descriptor()
                .map_err(|error| snapshot_error(error.to_string()))?;
            if descriptor.project_id != project_id {
                continue;
            }
            let scrollback = session
                .scrollback()
                .map_err(|error| snapshot_error(error.to_string()))?;
            snapshot.agents.push(
                serde_json::to_value(RuntimeSessionCheckpoint {
                    descriptor,
                    scrollback,
                })
                .map_err(SnapshotStoreError::InvalidData)?,
            );
        }
        self.persist_generation(generation, &snapshot)?;
        Ok(snapshot)
    }

    pub fn schedule_checkpoint(
        self: &Arc<Self>,
        snapshot: SessionCheckpoint,
        debounce: Duration,
    ) -> u64 {
        let generation = self.reserve_generation();
        let manager = self.clone();
        thread::spawn(move || {
            thread::sleep(debounce);
            if manager.next_generation.load(Ordering::Acquire) == generation {
                let _ = manager.persist_generation(generation, &snapshot);
            }
        });
        generation
    }

    pub fn persist_generation(
        &self,
        generation: u64,
        snapshot: &SessionCheckpoint,
    ) -> Result<bool, SnapshotStoreError> {
        let mut persisted = self
            .persisted_generation
            .lock()
            .map_err(|_| snapshot_error("checkpoint generation lock poisoned"))?;
        if generation <= *persisted {
            return Ok(false);
        }
        self.store.save_atomic(snapshot)?;
        *persisted = generation;
        Ok(true)
    }

    fn reserve_generation(&self) -> u64 {
        self.next_generation.fetch_add(1, Ordering::AcqRel) + 1
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeSessionCheckpoint {
    descriptor: super::SessionDescriptor,
    scrollback: String,
}

fn snapshot_error(message: impl Into<String>) -> SnapshotStoreError {
    SnapshotStoreError::Io(std::io::Error::new(
        std::io::ErrorKind::Other,
        message.into(),
    ))
}
