use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const SETTINGS_FILE_NAME: &str = "settings.json";
const SETTINGS_SCHEMA_VERSION: u16 = 1;
const CLEAN_PROFILE_ID: &str = "clean";

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserProfileSettings {
    pub built_in_browser_control_enabled: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserControlSettings {
    pub schema_version: u16,
    pub profiles: BTreeMap<String, BrowserProfileSettings>,
}

impl BrowserControlSettings {
    fn clean_default() -> Self {
        let mut profiles = BTreeMap::new();
        profiles.insert(
            CLEAN_PROFILE_ID.to_owned(),
            BrowserProfileSettings {
                built_in_browser_control_enabled: true,
            },
        );
        Self {
            schema_version: SETTINGS_SCHEMA_VERSION,
            profiles,
        }
    }

    fn disabled() -> Self {
        Self {
            schema_version: SETTINGS_SCHEMA_VERSION,
            profiles: BTreeMap::new(),
        }
    }
}

#[derive(Clone)]
pub struct BrowserControlSettingsStore {
    path: PathBuf,
    settings: Arc<Mutex<BrowserControlSettings>>,
}

impl BrowserControlSettingsStore {
    pub fn open(control_dir: impl AsRef<Path>) -> io::Result<Self> {
        let control_dir = control_dir.as_ref();
        fs::create_dir_all(control_dir)?;
        let path = control_dir.join(SETTINGS_FILE_NAME);
        let settings = match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .unwrap_or_else(|_| BrowserControlSettings::disabled()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                BrowserControlSettings::clean_default()
            }
            Err(error) => return Err(error),
        };
        Ok(Self {
            path,
            settings: Arc::new(Mutex::new(settings)),
        })
    }

    pub fn is_enabled(&self, profile_id: &str) -> io::Result<bool> {
        let settings = self
            .settings
            .lock()
            .map_err(|_| io::Error::other("browser settings lock is poisoned"))?;
        Ok(settings
            .profiles
            .get(profile_id)
            .is_some_and(|profile| profile.built_in_browser_control_enabled))
    }

    pub fn set_enabled(&self, profile_id: &str, enabled: bool) -> io::Result<()> {
        if profile_id.trim().is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "browser profile ID is required",
            ));
        }
        let mut settings = self
            .settings
            .lock()
            .map_err(|_| io::Error::other("browser settings lock is poisoned"))?;
        settings.profiles.insert(
            profile_id.to_owned(),
            BrowserProfileSettings {
                built_in_browser_control_enabled: enabled,
            },
        );
        let encoded = serde_json::to_vec_pretty(&*settings)
            .map_err(|error| io::Error::other(format!("serialize browser settings: {error}")))?;
        atomic_write(&self.path, &encoded)?;
        Ok(())
    }
}

fn atomic_write(path: &Path, contents: &[u8]) -> io::Result<()> {
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, contents)?;
    if let Err(rename_error) = fs::rename(&temporary, path) {
        if path.exists() {
            fs::remove_file(path)?;
            fs::rename(&temporary, path)?;
        } else {
            return Err(rename_error);
        }
    }
    Ok(())
}
