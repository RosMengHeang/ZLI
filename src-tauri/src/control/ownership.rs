use super::persistence::save_bytes_atomic_file;
use crate::pty::ProcessIdentity;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use thiserror::Error;

pub const OWNERSHIP_SCHEMA_VERSION: u16 = 1;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeOwnershipRecord {
    pub session_id: String,
    pub agent_id: String,
    pub project_id: String,
    pub terminal_id: String,
    pub worktree_path: Option<String>,
    pub process: ProcessIdentity,
    pub recorded_at: String,
}

#[derive(Debug, Error)]
pub enum OwnershipLedgerError {
    #[error("ownership record is invalid: {0}")]
    InvalidRecord(&'static str),
    #[error("unsupported ownership schema version {found}; supported version is {supported}")]
    UnsupportedSchemaVersion { found: u16, supported: u16 },
    #[error("ownership ledger I/O failed: {0}")]
    Io(#[from] io::Error),
    #[error("ownership ledger data is invalid: {0}")]
    InvalidData(#[from] serde_json::Error),
}

impl OwnershipLedgerError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidRecord(_) => "invalid_ownership_record",
            Self::UnsupportedSchemaVersion { .. } => "unsupported_ownership_schema",
            Self::Io(_) => "ownership_ledger_io_error",
            Self::InvalidData(_) => "invalid_ownership_data",
        }
    }
}

#[derive(Clone, Debug)]
pub struct OwnershipLedger {
    path: PathBuf,
    lock: Arc<Mutex<()>>,
}

impl OwnershipLedger {
    pub fn new(app_data_dir: PathBuf) -> Self {
        Self {
            path: app_data_dir.join("control").join("runtime-ownership.json"),
            lock: Arc::new(Mutex::new(())),
        }
    }

    pub fn records(&self) -> Result<Vec<RuntimeOwnershipRecord>, OwnershipLedgerError> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| io::Error::other("ownership ledger lock poisoned"))?;
        self.load_unlocked()
    }

    pub fn record(&self, record: RuntimeOwnershipRecord) -> Result<(), OwnershipLedgerError> {
        validate_record(&record)?;
        let _guard = self
            .lock
            .lock()
            .map_err(|_| io::Error::other("ownership ledger lock poisoned"))?;
        let mut records = self.load_unlocked()?;
        if let Some(existing) = records
            .iter_mut()
            .find(|existing| existing.session_id == record.session_id)
        {
            *existing = record;
        } else {
            records.push(record);
        }
        self.save_unlocked(&records)
    }

    pub fn remove(&self, session_id: &str) -> Result<bool, OwnershipLedgerError> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| io::Error::other("ownership ledger lock poisoned"))?;
        let mut records = self.load_unlocked()?;
        let original_len = records.len();
        records.retain(|record| record.session_id != session_id);
        if records.len() == original_len {
            return Ok(false);
        }
        self.save_unlocked(&records)?;
        Ok(true)
    }

    pub fn remove_for_terminals(
        &self,
        terminal_ids: &[String],
    ) -> Result<usize, OwnershipLedgerError> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| io::Error::other("ownership ledger lock poisoned"))?;
        let mut records = self.load_unlocked()?;
        let original_len = records.len();
        records.retain(|record| !terminal_ids.iter().any(|id| id == &record.terminal_id));
        let removed = original_len - records.len();
        if removed > 0 {
            self.save_unlocked(&records)?;
        }
        Ok(removed)
    }

    fn load_unlocked(&self) -> Result<Vec<RuntimeOwnershipRecord>, OwnershipLedgerError> {
        let bytes = match fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error.into()),
        };
        let document: OwnershipDocument = serde_json::from_slice(&bytes)?;
        if document.schema_version != OWNERSHIP_SCHEMA_VERSION {
            return Err(OwnershipLedgerError::UnsupportedSchemaVersion {
                found: document.schema_version,
                supported: OWNERSHIP_SCHEMA_VERSION,
            });
        }
        for record in &document.records {
            validate_record(record)?;
        }
        Ok(document.records)
    }

    fn save_unlocked(
        &self,
        records: &[RuntimeOwnershipRecord],
    ) -> Result<(), OwnershipLedgerError> {
        let document = OwnershipDocument {
            schema_version: OWNERSHIP_SCHEMA_VERSION,
            records: records.to_vec(),
        };
        let bytes = serde_json::to_vec_pretty(&document)?;
        save_bytes_atomic_file(&self.path, &bytes)?;
        Ok(())
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct OwnershipDocument {
    schema_version: u16,
    records: Vec<RuntimeOwnershipRecord>,
}

fn validate_record(record: &RuntimeOwnershipRecord) -> Result<(), OwnershipLedgerError> {
    for value in [
        record.session_id.as_str(),
        record.agent_id.as_str(),
        record.project_id.as_str(),
        record.terminal_id.as_str(),
        record.process.executable.as_str(),
        record.recorded_at.as_str(),
    ] {
        if value.trim().is_empty() {
            return Err(OwnershipLedgerError::InvalidRecord(
                "required ownership fields cannot be empty",
            ));
        }
    }
    if record.process.pid == 0 || record.process.start_time == 0 {
        return Err(OwnershipLedgerError::InvalidRecord(
            "process identity must include a PID and start time",
        ));
    }
    Ok(())
}
