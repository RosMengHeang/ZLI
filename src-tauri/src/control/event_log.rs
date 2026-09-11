use super::{AgentEventEnvelope, AgentEventKind, AgentEventPayload};
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

const EVENT_LOG_FILE: &str = "events.jsonl";
const MAX_PERSISTED_TEXT_CHARS: usize = 4_096;

/// The durable event log is intentionally bounded by the event hub capacity.
/// Snapshots own the full scrollback, so output events keep only their identity
/// and sequence while lifecycle and coordination events keep their payloads.
pub(crate) struct DurableEventLog {
    path: PathBuf,
    capacity: usize,
    line_count: usize,
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
        file.sync_all()?;
        self.line_count += 1;
        if self.line_count > self.capacity {
            self.rewrite(retained)?;
        }
        Ok(())
    }

    fn rewrite(&mut self, retained: &[AgentEventEnvelope]) -> io::Result<()> {
        let mut bytes = Vec::new();
        let start = retained.len().saturating_sub(self.capacity);
        for event in &retained[start..] {
            let persisted = compact_event(event);
            serde_json::to_writer(&mut bytes, &persisted).map_err(io::Error::other)?;
            bytes.push(b'\n');
        }
        crate::control::persistence::save_bytes_atomic_file(&self.path, &bytes)?;
        self.line_count = retained.len().min(self.capacity);
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
