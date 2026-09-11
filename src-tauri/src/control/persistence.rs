use super::browser::commands::{BrowserCapability, BrowserCommand};
use super::events::utc_rfc3339_now;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use thiserror::Error;

pub const SNAPSHOT_SCHEMA_VERSION: u16 = 1;
pub const PENDING_QUEUE_SCHEMA_VERSION: u16 = 1;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSnapshot {
    pub schema_version: u16,
    pub project_id: String,
    pub agents: Vec<Value>,
    pub pane_tree: Value,
    pub browser: Vec<Value>,
    pub tax_chat_room: Option<Value>,
    pub last_event_sequence: u64,
    pub saved_at: String,
    #[serde(flatten)]
    pub extensions: BTreeMap<String, Value>,
}

impl ProjectSnapshot {
    pub fn empty(project_id: String) -> Self {
        Self {
            schema_version: SNAPSHOT_SCHEMA_VERSION,
            project_id,
            agents: Vec::new(),
            pane_tree: Value::Null,
            browser: Vec::new(),
            tax_chat_room: None,
            last_event_sequence: 0,
            saved_at: utc_rfc3339_now(),
            extensions: BTreeMap::new(),
        }
    }
}

pub(crate) fn sanitize_browser_checkpoint(value: Value) -> Option<Value> {
    let object = value.as_object()?;
    let url = object.get("url")?.as_str()?.to_owned();
    BrowserCommand::Open { url: url.clone() }.validate().ok()?;
    let capabilities = object
        .get("capabilities")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|value| serde_json::from_value::<BrowserCapability>(value.clone()).ok())
        .filter(|capability| {
            matches!(
                capability,
                BrowserCapability::Read
                    | BrowserCapability::Control
                    | BrowserCapability::Javascript
            )
        })
        .collect::<Vec<_>>();
    Some(serde_json::json!({
        "url": url,
        "open": object.get("open").and_then(Value::as_bool).unwrap_or(false),
        "profileId": object.get("profileId").and_then(Value::as_str).filter(|value| !value.trim().is_empty()).unwrap_or("default"),
        "capabilities": capabilities,
    }))
}

#[derive(Debug, Error)]
pub enum SnapshotStoreError {
    #[error("invalid project identifier")]
    InvalidProjectId,
    #[error("unsupported snapshot schema version {found}; supported version is {supported}")]
    UnsupportedSchemaVersion { found: u16, supported: u16 },
    #[error("unsupported pending queue schema version {found}; supported version is {supported}")]
    UnsupportedPendingQueueSchemaVersion { found: u16, supported: u16 },
    #[error("snapshot I/O failed: {0}")]
    Io(#[from] io::Error),
    #[error("snapshot data is invalid: {0}")]
    InvalidData(#[from] serde_json::Error),
}

impl SnapshotStoreError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidProjectId => "invalid_project_id",
            Self::UnsupportedSchemaVersion { .. } => "unsupported_snapshot_schema",
            Self::UnsupportedPendingQueueSchemaVersion { .. } => {
                "unsupported_pending_queue_schema"
            }
            Self::Io(_) => "snapshot_io_error",
            Self::InvalidData(_) => "invalid_snapshot_data",
        }
    }
}

#[derive(Clone, Debug)]
pub struct SnapshotStore {
    root: PathBuf,
}

impl SnapshotStore {
    pub fn new(app_data_dir: PathBuf) -> Self {
        Self {
            root: app_data_dir.join("control").join("projects"),
        }
    }

    pub fn load(&self, project_id: &str) -> Result<Option<ProjectSnapshot>, SnapshotStoreError> {
        let path = self.snapshot_path(project_id)?;
        let bytes = match fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let document: Value = serde_json::from_slice(&bytes)?;
        let schema_version = document
            .get("schemaVersion")
            .and_then(Value::as_u64)
            .and_then(|value| u16::try_from(value).ok());
        if let Some(found) = schema_version.filter(|version| *version > SNAPSHOT_SCHEMA_VERSION) {
            return Err(SnapshotStoreError::UnsupportedSchemaVersion {
                found,
                supported: SNAPSHOT_SCHEMA_VERSION,
            });
        }
        let snapshot: ProjectSnapshot = serde_json::from_value(document)?;
        if snapshot.schema_version != SNAPSHOT_SCHEMA_VERSION || snapshot.project_id != project_id {
            return Err(SnapshotStoreError::InvalidData(serde_json::Error::io(
                io::Error::new(io::ErrorKind::InvalidData, "snapshot identity mismatch"),
            )));
        }
        Ok(Some(snapshot))
    }

    pub fn save_atomic(&self, snapshot: &ProjectSnapshot) -> Result<(), SnapshotStoreError> {
        self.validate_snapshot(snapshot)?;
        let destination = self.snapshot_path(&snapshot.project_id)?;
        let bytes = serde_json::to_vec_pretty(snapshot)?;
        self.save_bytes_atomic(&destination, &bytes)
    }

    pub fn load_pending_messages(&self) -> Result<Vec<Value>, SnapshotStoreError> {
        let path = self.pending_queue_path();
        let bytes = match fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error.into()),
        };
        let document: PendingMessageDocument = serde_json::from_slice(&bytes)?;
        if document.schema_version != PENDING_QUEUE_SCHEMA_VERSION {
            return Err(SnapshotStoreError::UnsupportedPendingQueueSchemaVersion {
                found: document.schema_version,
                supported: PENDING_QUEUE_SCHEMA_VERSION,
            });
        }
        Ok(document.messages)
    }

    pub fn save_pending_messages(&self, messages: &[Value]) -> Result<(), SnapshotStoreError> {
        let document = PendingMessageDocument {
            schema_version: PENDING_QUEUE_SCHEMA_VERSION,
            messages: messages.to_vec(),
        };
        let bytes = serde_json::to_vec_pretty(&document)?;
        self.save_bytes_atomic(&self.pending_queue_path(), &bytes)
    }

    pub fn delete_project(&self, project_id: &str) -> Result<(), SnapshotStoreError> {
        let directory = self.project_dir(project_id)?;
        match fs::remove_dir_all(directory) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    fn validate_snapshot(&self, snapshot: &ProjectSnapshot) -> Result<(), SnapshotStoreError> {
        self.project_dir(&snapshot.project_id)?;
        if snapshot.schema_version != SNAPSHOT_SCHEMA_VERSION {
            return Err(SnapshotStoreError::UnsupportedSchemaVersion {
                found: snapshot.schema_version,
                supported: SNAPSHOT_SCHEMA_VERSION,
            });
        }
        Ok(())
    }

    fn snapshot_path(&self, project_id: &str) -> Result<PathBuf, SnapshotStoreError> {
        Ok(self.project_dir(project_id)?.join("project.json"))
    }

    fn pending_queue_path(&self) -> PathBuf {
        self.root
            .parent()
            .expect("snapshot root has a control parent")
            .join("pending-messages.json")
    }

    fn save_bytes_atomic(
        &self,
        destination: &Path,
        bytes: &[u8],
    ) -> Result<(), SnapshotStoreError> {
        save_bytes_atomic_file(destination, bytes)?;
        Ok(())
    }

    fn project_dir(&self, project_id: &str) -> Result<PathBuf, SnapshotStoreError> {
        if project_id.trim().is_empty() {
            return Err(SnapshotStoreError::InvalidProjectId);
        }
        Ok(self.root.join(project_storage_key(project_id)))
    }
}

pub(crate) fn save_bytes_atomic_file(destination: &Path, bytes: &[u8]) -> io::Result<()> {
    let directory = destination.parent().expect("atomic path has a parent");
    fs::create_dir_all(directory)?;
    let temporary = destination.with_extension("json.tmp");
    let result = (|| -> io::Result<()> {
        let mut file = File::create(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        replace_file(&temporary, destination)?;
        if let Ok(directory_file) = File::open(directory) {
            let _ = directory_file.sync_all();
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PendingMessageDocument {
    schema_version: u16,
    messages: Vec<Value>,
}

fn project_storage_key(project_id: &str) -> String {
    if project_id != "."
        && project_id != ".."
        && Path::new(project_id).components().count() == 1
        && project_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return project_id.to_owned();
    }
    let mut encoded = String::with_capacity(project_id.len() * 2 + 1);
    encoded.push('~');
    for byte in project_id.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.') {
            encoded.push(char::from(byte));
        } else {
            encoded.push('_');
            encoded.push_str(&format!("{byte:02X}"));
        }
    }
    encoded
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let moved = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}
