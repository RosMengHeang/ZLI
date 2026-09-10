use super::events::utc_rfc3339_now;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use thiserror::Error;

pub const SNAPSHOT_SCHEMA_VERSION: u16 = 1;

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

#[derive(Debug, Error)]
pub enum SnapshotStoreError {
    #[error("invalid project identifier")]
    InvalidProjectId,
    #[error("unsupported snapshot schema version {found}; supported version is {supported}")]
    UnsupportedSchemaVersion { found: u16, supported: u16 },
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
        let directory = destination.parent().expect("snapshot path has a parent");
        fs::create_dir_all(directory)?;
        let temporary = destination.with_extension("json.tmp");
        let bytes = serde_json::to_vec_pretty(snapshot)?;
        let result = (|| -> Result<(), SnapshotStoreError> {
            let mut file = File::create(&temporary)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            replace_file(&temporary, &destination)?;
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

    fn project_dir(&self, project_id: &str) -> Result<PathBuf, SnapshotStoreError> {
        if project_id.trim().is_empty()
            || project_id == "."
            || project_id == ".."
            || project_id.contains(['/', '\\'])
            || Path::new(project_id).components().count() != 1
        {
            return Err(SnapshotStoreError::InvalidProjectId);
        }
        Ok(self.root.join(project_id))
    }
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
