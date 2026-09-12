use super::{AgentEventEnvelope, AgentEventKind, AgentEventPayload};
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

const EVENT_LOG_FILE: &str = "events.jsonl";
const MAX_PERSISTED_TEXT_CHARS: usize = 4_096;

/// Extra on-disk lines past `capacity` before a rewrite.
/// Default hub capacity is 1024 → headroom 256. Tiny test capacities keep at
/// least 1 so appends past capacity do not rewrite every time.
fn rewrite_headroom(capacity: usize) -> usize {
    (capacity / 4).max(1)
}

/// The durable event log is intentionally bounded by the event hub capacity.
/// Snapshots own the full scrollback, so output events keep only their identity
/// and sequence while lifecycle and coordination events keep their payloads.
pub(crate) struct DurableEventLog {
    path: PathBuf,
    capacity: usize,
    line_count: usize,
    rewrite_count: usize,
}

impl DurableEventLog {
    pub(crate) fn open(
        root: impl AsRef<Path>,
        capacity: usize,
    ) -> io::Result<(Self, Vec<AgentEventEnvelope>)> {
        let root = root.as_ref();
        fs::create_dir_all(root)?;
        let path = root.join(EVENT_LOG_FILE);
        let (events, line_count) = load_events(&path, capacity)?;
        let mut log = Self {
            path,
            capacity,
            line_count,
            rewrite_count: 0,
        };
        if line_count != events.len() {
            log.rewrite(&events)?;
        }
        Ok((log, events))
    }

    pub(crate) fn append(
        &mut self,
        event: &AgentEventEnvelope,
        retained: &[AgentEventEnvelope],
    ) -> io::Result<()> {
        if self.capacity == 0 {
            return Ok(());
        }
        let persisted = compact_event(event);
        let bytes = serde_json::to_vec(&persisted).map_err(io::Error::other)?;
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        file.write_all(&bytes)?;
        file.write_all(b"\n")?;
        // Lifecycle durability stays on sync_all. AgentOutput is already
        // payload-stripped; headroom cuts rewrite thrash without deferred sync.
        file.sync_all()?;
        // Windows cannot replace events.jsonl while this append handle is open.
        drop(file);
        self.line_count += 1;
        if self.line_count > self.capacity + rewrite_headroom(self.capacity) {
            self.rewrite(retained)?;
        }
        Ok(())
    }

    pub(crate) fn rewrite_count(&self) -> usize {
        self.rewrite_count
    }

    fn rewrite(&mut self, retained: &[AgentEventEnvelope]) -> io::Result<()> {
        let mut bytes = Vec::new();
        let start = retained.len().saturating_sub(self.capacity);
        let kept = &retained[start..];
        for event in kept {
            let persisted = compact_event(event);
            serde_json::to_writer(&mut bytes, &persisted).map_err(io::Error::other)?;
            bytes.push(b'\n');
        }
        crate::control::persistence::save_bytes_atomic_file(&self.path, &bytes)?;
        self.line_count = kept.len();
        self.rewrite_count += 1;
        Ok(())
    }
}

fn load_events(path: &Path, capacity: usize) -> io::Result<(Vec<AgentEventEnvelope>, usize)> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok((Vec::new(), 0)),
        Err(error) => return Err(error),
    };
    let mut events = Vec::new();
    let mut line_count = 0;
    for line in BufReader::new(file).lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        line_count += 1;
        let Ok(event) = serde_json::from_str::<AgentEventEnvelope>(&line) else {
            continue;
        };
        if event.schema_version == 1 && event.sequence > 0 {
            events.push(event);
        }
    }
    if events.len() > capacity {
        let start = events.len() - capacity;
        events = events.split_off(start);
    }
    Ok((events, line_count))
}

fn compact_event(event: &AgentEventEnvelope) -> AgentEventEnvelope {
    let mut compacted = event.clone();
    if compacted.kind == AgentEventKind::AgentOutput {
        compacted.payload = AgentEventPayload::Empty;
    } else if let AgentEventPayload::Text { text } = &mut compacted.payload {
        if text.chars().count() > MAX_PERSISTED_TEXT_CHARS {
            let mut truncated = text
                .chars()
                .take(MAX_PERSISTED_TEXT_CHARS)
                .collect::<String>();
            truncated.push_str("\n[output truncated in durable log]");
            *text = truncated;
        }
    }
    compacted
}

#[cfg(test)]
mod tests {
    use super::{rewrite_headroom, DurableEventLog};
    use crate::control::{AgentEventEnvelope, AgentEventKind, AgentEventPayload};
    use tempfile::tempdir;

    fn lifecycle_event(id: &str, sequence: u64) -> AgentEventEnvelope {
        let mut event = AgentEventEnvelope::new(
            id.into(),
            "project-1".into(),
            Some("agent-1".into()),
            AgentEventKind::AgentStarted,
            AgentEventPayload::Empty,
        );
        event.sequence = sequence;
        event
    }

    #[test]
    fn append_past_capacity_rewrites_o_of_n_over_headroom_not_o_of_n() {
        let root = tempdir().expect("temporary event log directory");
        let capacity = 8;
        let headroom = rewrite_headroom(capacity);
        let (mut log, _) =
            DurableEventLog::open(root.path(), capacity).expect("open durable event log");

        let mut retained = Vec::new();
        let append_count = capacity + headroom * 20;
        for index in 0..append_count {
            let event = lifecycle_event(&format!("event-{index}"), (index as u64) + 1);
            retained.push(event.clone());
            if retained.len() > capacity {
                retained.remove(0);
            }
            log.append(&event, &retained)
                .expect("append durable event");
        }

        let past_capacity = append_count.saturating_sub(capacity);
        let expected = if append_count <= capacity + headroom {
            0
        } else {
            1 + (append_count - capacity - headroom - 1) / (headroom + 1)
        };
        assert_eq!(log.rewrite_count(), expected);
        assert!(
            log.rewrite_count() <= past_capacity / headroom + 1,
            "rewrites must be O(N/HEADROOM), got {} for {} past-capacity appends (headroom {})",
            log.rewrite_count(),
            past_capacity,
            headroom
        );
        assert!(
            log.rewrite_count() < past_capacity,
            "must not rewrite on every past-capacity append"
        );
    }
}
