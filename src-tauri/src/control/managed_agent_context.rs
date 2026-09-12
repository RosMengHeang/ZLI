use super::security::{CapabilityTokenStore, CredentialHandle};
use super::{
    CallerIdentity, Capability, ControlError, ControlErrorCode, SessionCommandError,
    SessionDescriptor,
};
use crate::error::BackendError;
use crate::pty::EventSink;
use std::collections::{BTreeMap, HashMap};
use std::env;
use std::ffi::{OsStr, OsString};
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use uuid::Uuid;

const CREDENTIAL_LEASE: Duration = Duration::from_secs(12 * 60 * 60);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ManagedAgentIdentity {
    pub agent_id: String,
    pub project_id: String,
    pub provider_id: String,
    pub parent_agent_id: Option<String>,
}

pub enum LaunchIntent<'a> {
    Direct {
        project_id: &'a str,
        provider_id: &'a str,
    },
    Restart {
        replaces: &'a str,
        project_id: &'a str,
        provider_id: &'a str,
    },
    Child {
        project_id: &'a str,
        provider_id: &'a str,
        parent_agent_id: Option<&'a str>,
    },
    Resume {
        descriptor: &'a SessionDescriptor,
    },
}

pub struct ManagedEnvironment {
    entries: BTreeMap<OsString, OsString>,
}

impl ManagedEnvironment {
    pub(crate) fn empty() -> Self {
        Self {
            entries: BTreeMap::new(),
        }
    }

    pub fn merge_provider(
        &self,
        plan: &BTreeMap<OsString, OsString>,
    ) -> HashMap<OsString, OsString> {
        let mut merged: HashMap<OsString, OsString> = plan
            .iter()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();
        for (key, value) in &self.entries {
            if key == OsStr::new("PATH") {
                continue;
            }
            merged.insert(key.clone(), value.clone());
        }
        if let Some(provider_path) = plan.get(OsStr::new("PATH")) {
            let merged_path = match sidecar_directory(&self.entries) {
                Some(directory) => prepend_dir_to_path(&directory, Some(provider_path)),
                None => provider_path.clone(),
            };
            merged.insert(OsString::from("PATH"), merged_path);
        } else if let Some(scoped_path) = self.entries.get(OsStr::new("PATH")) {
            merged.insert(OsString::from("PATH"), scoped_path.clone());
        }
        merged
    }
}

impl fmt::Debug for ManagedEnvironment {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let entries = self
            .entries
            .iter()
            .map(|(key, value)| {
                let key = key.to_string_lossy().into_owned();
                let value = if key == "ZLI_CONTROL_TOKEN" {
                    String::from("***")
                } else {
                    value.to_string_lossy().into_owned()
                };
                (key, value)
            })
            .collect::<BTreeMap<_, _>>();
        f.debug_struct("ManagedEnvironment")
            .field("entries", &entries)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SidecarPaths {
    control: PathBuf,
    browser_use: PathBuf,
}

impl SidecarPaths {
    pub fn resolve(directory: &Path) -> Result<Self, ManagedContextError> {
        let control = directory.join(control_sidecar_name());
        if !control.is_file() {
            return Err(ManagedContextError::SidecarMissing {
                name: control_sidecar_name(),
                expected: control,
            });
        }
        let browser_use = directory.join(browser_use_sidecar_name());
        if !browser_use.is_file() {
            return Err(ManagedContextError::SidecarMissing {
                name: browser_use_sidecar_name(),
                expected: browser_use,
            });
        }
        Ok(Self {
            control,
            browser_use,
        })
    }

    pub fn control(&self) -> &Path {
        &self.control
    }

    pub fn browser_use(&self) -> &Path {
        &self.browser_use
    }
}

pub fn install_directory() -> Result<PathBuf, ManagedContextError> {
    env::current_exe()
        .ok()
        .and_then(|executable| executable.parent().map(Path::to_path_buf))
        .ok_or(ManagedContextError::InstallDirectoryUnknown)
}

#[derive(Clone, Debug)]
pub enum ControlEndpoint {
    Available(String),
    Unsupported { reason: &'static str },
}

impl ControlEndpoint {
    pub fn from_transport(endpoint: String) -> Self {
        if endpoint.trim().is_empty() {
            Self::Unsupported {
                reason: "control transport endpoint is empty",
            }
        } else {
            Self::Available(endpoint)
        }
    }
}

#[must_use = "dropping a ManagedLaunch revokes its credential; call commit once the process is bound"]
pub struct ManagedLaunch {
    agent: ManagedAgentIdentity,
    environment: ManagedEnvironment,
    sidecars: SidecarPaths,
    sink: Arc<dyn EventSink>,
    credential: CredentialGuard,
}

impl ManagedLaunch {
    pub fn agent(&self) -> &ManagedAgentIdentity {
        &self.agent
    }

    pub fn environment(&self) -> &ManagedEnvironment {
        &self.environment
    }

    pub fn sidecars(&self) -> &SidecarPaths {
        &self.sidecars
    }

    pub fn sink(&self) -> Arc<dyn EventSink> {
        self.sink.clone()
    }

    pub fn commit(mut self) -> ManagedAgentIdentity {
        self.credential.commit();
        self.agent.clone()
    }
}

struct CredentialGuard {
    tokens: Arc<CapabilityTokenStore>,
    agent_id: String,
    handle: CredentialHandle,
    supersedes: Option<String>,
    armed: bool,
}

impl CredentialGuard {
    fn commit(&mut self) {
        self.tokens
            .revoke_agent_except(&self.agent_id, self.handle);
        if let Some(replaces) = self.supersedes.as_deref() {
            self.tokens.revoke_agent(replaces);
        }
        self.armed = false;
    }
}

impl Drop for CredentialGuard {
    fn drop(&mut self) {
        if self.armed {
            self.tokens.revoke_handle(self.handle);
        }
    }
}

pub struct ManagedAgentContext {
    tokens: Arc<CapabilityTokenStore>,
    endpoint: ControlEndpoint,
    install_dir: PathBuf,
    sink: Arc<dyn EventSink>,
    lease: Duration,
}

impl ManagedAgentContext {
    pub fn new(
        tokens: Arc<CapabilityTokenStore>,
        endpoint: ControlEndpoint,
        install_dir: PathBuf,
        sink: Arc<dyn EventSink>,
    ) -> Self {
        Self {
            tokens,
            endpoint,
            install_dir,
            sink,
            lease: CREDENTIAL_LEASE,
        }
    }

    pub fn prepare(&self, intent: LaunchIntent<'_>) -> Result<ManagedLaunch, ManagedContextError> {
        let sidecars = SidecarPaths::resolve(&self.install_dir)?;
        let endpoint = match &self.endpoint {
            ControlEndpoint::Available(endpoint) => endpoint.clone(),
            ControlEndpoint::Unsupported { reason } => {
                return Err(ManagedContextError::ControlTransportUnavailable { reason });
            }
        };
        let (agent, supersedes) = identity_from_intent(intent)?;
        let issued = self.tokens.issue(caller_identity(&agent), self.lease);
        let environment = scoped_environment(&agent, &endpoint, &issued.token, &sidecars);
        Ok(ManagedLaunch {
            agent: agent.clone(),
            environment,
            sidecars,
            sink: self.sink.clone(),
            credential: CredentialGuard {
                tokens: self.tokens.clone(),
                agent_id: agent.agent_id,
                handle: issued.handle,
                supersedes,
                armed: true,
            },
        })
    }

    pub fn revoke(&self, agent_id: &str) -> usize {
        self.tokens.revoke_agent(agent_id)
    }

    pub fn touch(&self, agent_id: &str) {
        self.tokens.touch_agent(agent_id, self.lease);
    }

    pub fn sidecars(&self) -> Result<SidecarPaths, ManagedContextError> {
        SidecarPaths::resolve(&self.install_dir)
    }
}

#[derive(Clone, Debug, thiserror::Error)]
pub enum ManagedContextError {
    #[error("{name} was not found at {}", .expected.display())]
    SidecarMissing {
        name: &'static str,
        expected: PathBuf,
    },
    #[error("control transport is unavailable: {reason}")]
    ControlTransportUnavailable { reason: &'static str },
    #[error("session {session_id} has an unusable {field}")]
    UnusableDescriptor {
        session_id: String,
        field: &'static str,
    },
    #[error("the ZLI install directory could not be determined")]
    InstallDirectoryUnknown,
}

impl From<ManagedContextError> for ControlError {
    fn from(error: ManagedContextError) -> Self {
        let code = match error {
            ManagedContextError::ControlTransportUnavailable { .. } => {
                ControlErrorCode::CapabilityDenied
            }
            ManagedContextError::SidecarMissing { .. }
            | ManagedContextError::UnusableDescriptor { .. }
            | ManagedContextError::InstallDirectoryUnknown => ControlErrorCode::ControlRuntimeError,
        };
        ControlError::new(code, error.to_string())
    }
}

impl From<ManagedContextError> for BackendError {
    fn from(error: ManagedContextError) -> Self {
        BackendError::InvalidInput(error.to_string())
    }
}

impl From<ManagedContextError> for SessionCommandError {
    fn from(error: ManagedContextError) -> Self {
        SessionCommandError::Runtime(error.to_string())
    }
}

fn control_sidecar_name() -> &'static str {
    if cfg!(windows) {
        "zli.exe"
    } else {
        "zli"
    }
}

fn browser_use_sidecar_name() -> &'static str {
    if cfg!(windows) {
        "zli-browser-use.exe"
    } else {
        "zli-browser-use"
    }
}

fn identity_from_intent(
    intent: LaunchIntent<'_>,
) -> Result<(ManagedAgentIdentity, Option<String>), ManagedContextError> {
    match intent {
        LaunchIntent::Direct {
            project_id,
            provider_id,
        } => Ok((
            fresh_identity(project_id, provider_id, None),
            None,
        )),
        LaunchIntent::Restart {
            replaces,
            project_id,
            provider_id,
        } => Ok((
            fresh_identity(project_id, provider_id, None),
            Some(replaces.to_owned()),
        )),
        LaunchIntent::Child {
            project_id,
            provider_id,
            parent_agent_id,
        } => Ok((
            fresh_identity(project_id, provider_id, parent_agent_id.map(str::to_owned)),
            None,
        )),
        LaunchIntent::Resume { descriptor } => Ok((identity_from_descriptor(descriptor)?, None)),
    }
}

fn fresh_identity(
    project_id: &str,
    provider_id: &str,
    parent_agent_id: Option<String>,
) -> ManagedAgentIdentity {
    ManagedAgentIdentity {
        agent_id: Uuid::new_v4().to_string(),
        project_id: project_id.to_owned(),
        provider_id: provider_id.to_owned(),
        parent_agent_id,
    }
}

fn identity_from_descriptor(
    descriptor: &SessionDescriptor,
) -> Result<ManagedAgentIdentity, ManagedContextError> {
    let field = if descriptor.agent_id.trim().is_empty() {
        Some("agent_id")
    } else if descriptor.project_id.trim().is_empty() {
        Some("project_id")
    } else if descriptor.provider_id.trim().is_empty() {
        Some("provider_id")
    } else {
        None
    };
    if let Some(field) = field {
        return Err(ManagedContextError::UnusableDescriptor {
            session_id: descriptor.session_id.clone(),
            field,
        });
    }
    Ok(ManagedAgentIdentity {
        agent_id: descriptor.agent_id.clone(),
        project_id: descriptor.project_id.clone(),
        provider_id: descriptor.provider_id.clone(),
        parent_agent_id: descriptor.parent_agent_id.clone(),
    })
}

fn caller_identity(agent: &ManagedAgentIdentity) -> CallerIdentity {
    CallerIdentity {
        caller_id: agent.agent_id.clone(),
        project_id: agent.project_id.clone(),
        agent_id: Some(agent.agent_id.clone()),
        parent_agent_id: agent.parent_agent_id.clone(),
        capabilities: vec![
            Capability::AgentList,
            Capability::AgentSpawn,
            Capability::AgentSend,
            Capability::AgentRead,
            Capability::AttentionRead,
            Capability::AttentionAck,
            Capability::SessionRead,
            Capability::BrowserRead,
            Capability::BrowserControl,
            Capability::TaxChatSend,
        ],
        expires_at: None,
    }
}

fn scoped_environment(
    agent: &ManagedAgentIdentity,
    endpoint: &str,
    token: &str,
    sidecars: &SidecarPaths,
) -> ManagedEnvironment {
    let mut entries = BTreeMap::new();
    for (key, value) in [
        ("ZLI_PROJECT_ID", agent.project_id.as_str()),
        ("ZLI_AGENT_ID", agent.agent_id.as_str()),
        (
            "ZLI_PARENT_AGENT_ID",
            agent.parent_agent_id.as_deref().unwrap_or(""),
        ),
        ("ZLI_CONTROL_ENDPOINT", endpoint),
        ("ZLI_CONTROL_TOKEN", token),
        ("ZLI_BROWSER_PROFILE", "clean"),
        ("ZLI_BROWSER_SESSION", agent.agent_id.as_str()),
    ] {
        entries.insert(OsString::from(key), OsString::from(value));
    }
    entries.insert(
        OsString::from("ZLI_COMMAND"),
        sidecars.control().as_os_str().to_owned(),
    );
    entries.insert(
        OsString::from("ZLI_BROWSER_USE_COMMAND"),
        sidecars.browser_use().as_os_str().to_owned(),
    );
    if let Some(directory) = sidecars.control().parent() {
        entries.insert(
            OsString::from("PATH"),
            prepend_dir_to_path(directory, env::var_os("PATH").as_ref()),
        );
    }
    ManagedEnvironment { entries }
}

fn sidecar_directory(entries: &BTreeMap<OsString, OsString>) -> Option<PathBuf> {
    entries
        .get(OsStr::new("ZLI_COMMAND"))
        .and_then(|command| Path::new(command).parent().map(Path::to_path_buf))
}

fn prepend_dir_to_path(directory: &Path, existing: Option<&OsString>) -> OsString {
    let inherited = existing
        .map(|value| env::split_paths(value).collect::<Vec<_>>())
        .unwrap_or_default();
    let paths = std::iter::once(directory.to_path_buf()).chain(inherited);
    env::join_paths(paths).unwrap_or_else(|_| directory.as_os_str().to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pty::MemoryEventSink;
    use std::fs;

    fn write_sidecars(directory: &Path) {
        fs::write(directory.join(control_sidecar_name()), []).expect("control sidecar");
        fs::write(directory.join(browser_use_sidecar_name()), []).expect("browser sidecar");
    }

    fn test_context(
        endpoint: ControlEndpoint,
        directory: &Path,
        tokens: Arc<CapabilityTokenStore>,
    ) -> ManagedAgentContext {
        ManagedAgentContext::new(
            tokens,
            endpoint,
            directory.to_path_buf(),
            Arc::new(MemoryEventSink::default()),
        )
    }

    fn env_value(environment: &HashMap<OsString, OsString>, key: &str) -> String {
        environment
            .get(OsStr::new(key))
            .unwrap_or_else(|| panic!("{key} must be present"))
            .to_string_lossy()
            .into_owned()
    }

    fn test_descriptor(agent_id: &str) -> SessionDescriptor {
        SessionDescriptor {
            session_id: "session-1".into(),
            project_id: "project-1".into(),
            agent_id: agent_id.into(),
            parent_agent_id: None,
            name: "paused".into(),
            provider_id: "codex".into(),
            terminal_id: "terminal-1".into(),
            working_directory: "D:/repo".into(),
            branch: "main".into(),
            worktree_path: None,
            resume: None,
            attached: false,
        }
    }

    #[test]
    fn prepare_direct_returns_env_sink_sidecars_and_credential() {
        let directory = tempfile::tempdir().expect("install dir");
        write_sidecars(directory.path());
        let tokens = Arc::new(CapabilityTokenStore::default());
        let context = test_context(
            ControlEndpoint::from_transport(r"\\.\pipe\zli-test".into()),
            directory.path(),
            tokens.clone(),
        );

        let launch = context
            .prepare(LaunchIntent::Direct {
                project_id: "project-1",
                provider_id: "codex",
            })
            .expect("prepare direct");
        let environment = launch.environment().merge_provider(&BTreeMap::new());

        assert_eq!(env_value(&environment, "ZLI_PROJECT_ID"), "project-1");
        assert_eq!(
            env_value(&environment, "ZLI_AGENT_ID"),
            launch.agent().agent_id
        );
        assert_eq!(
            env_value(&environment, "ZLI_COMMAND"),
            directory.path().join(control_sidecar_name()).to_string_lossy()
        );
        assert_eq!(
            env_value(&environment, "ZLI_BROWSER_USE_COMMAND"),
            directory
                .path()
                .join(browser_use_sidecar_name())
                .to_string_lossy()
        );
        assert!(std::env::split_paths(environment.get(OsStr::new("PATH")).unwrap())
            .next()
            .is_some_and(|path| path == directory.path()));
        let token = env_value(&environment, "ZLI_CONTROL_TOKEN");
        tokens.verify(&token).expect("issued credential verifies");
        assert!(!format!("{:?}", launch.environment()).contains(&token));
        launch.commit();
        tokens.verify(&token).expect("commit keeps the credential");
    }

    #[test]
    fn dropping_an_uncommitted_launch_revokes_the_credential() {
        let directory = tempfile::tempdir().expect("install dir");
        write_sidecars(directory.path());
        let tokens = Arc::new(CapabilityTokenStore::default());
        let context = test_context(
            ControlEndpoint::from_transport("pipe".into()),
            directory.path(),
            tokens.clone(),
        );
        let launch = context
            .prepare(LaunchIntent::Direct {
                project_id: "project-1",
                provider_id: "codex",
            })
            .expect("prepare");
        let token = env_value(
            &launch.environment().merge_provider(&BTreeMap::new()),
            "ZLI_CONTROL_TOKEN",
        );
        drop(launch);
        assert_eq!(
            tokens.verify(&token).expect_err("drop revokes").code,
            "CAPABILITY_DENIED"
        );
    }

    #[test]
    fn prepare_names_a_missing_sidecar() {
        let directory = tempfile::tempdir().expect("install dir");
        fs::write(directory.path().join(control_sidecar_name()), []).expect("control only");
        let context = test_context(
            ControlEndpoint::from_transport("pipe".into()),
            directory.path(),
            Arc::new(CapabilityTokenStore::default()),
        );

        let Err(error) = context.prepare(LaunchIntent::Direct {
            project_id: "project-1",
            provider_id: "codex",
        }) else {
            panic!("missing browser sidecar");
        };
        match error {
            ManagedContextError::SidecarMissing { name, expected } => {
                assert_eq!(name, browser_use_sidecar_name());
                assert_eq!(expected, directory.path().join(browser_use_sidecar_name()));
            }
            other => panic!("expected SidecarMissing, got {other:?}"),
        }
    }

    #[test]
    fn empty_endpoint_fails_prepare_after_sidecars_exist() {
        let directory = tempfile::tempdir().expect("install dir");
        write_sidecars(directory.path());
        let context = test_context(
            ControlEndpoint::from_transport(String::new()),
            directory.path(),
            Arc::new(CapabilityTokenStore::default()),
        );

        let Err(error) = context.prepare(LaunchIntent::Direct {
            project_id: "project-1",
            provider_id: "codex",
        }) else {
            panic!("empty endpoint");
        };
        match error {
            ManagedContextError::ControlTransportUnavailable { reason } => {
                assert_eq!(reason, "control transport endpoint is empty");
            }
            other => panic!("expected ControlTransportUnavailable, got {other:?}"),
        }
    }

    #[test]
    fn merge_provider_keeps_scoped_zli_keys_and_prepends_path() {
        let directory = tempfile::tempdir().expect("install dir");
        write_sidecars(directory.path());
        let context = test_context(
            ControlEndpoint::from_transport("pipe".into()),
            directory.path(),
            Arc::new(CapabilityTokenStore::default()),
        );
        let launch = context
            .prepare(LaunchIntent::Direct {
                project_id: "project-1",
                provider_id: "codex",
            })
            .expect("prepare");
        let mut plan = BTreeMap::new();
        plan.insert(
            OsString::from("ZLI_CONTROL_TOKEN"),
            OsString::from("stolen-token"),
        );
        plan.insert(OsString::from("PROVIDER_FLAG"), OsString::from("1"));
        plan.insert(
            OsString::from("PATH"),
            OsString::from("C:\\provider\\bin"),
        );

        let merged = launch.environment().merge_provider(&plan);
        assert_ne!(env_value(&merged, "ZLI_CONTROL_TOKEN"), "stolen-token");
        assert_eq!(env_value(&merged, "PROVIDER_FLAG"), "1");
        let mut paths = env::split_paths(merged.get(OsStr::new("PATH")).unwrap());
        assert_eq!(paths.next().as_deref(), Some(directory.path()));
        assert_eq!(
            paths.next().as_deref(),
            Some(Path::new("C:\\provider\\bin"))
        );
        drop(launch);
    }

    #[test]
    fn restart_commit_revokes_the_replaced_agent() {
        let directory = tempfile::tempdir().expect("install dir");
        write_sidecars(directory.path());
        let tokens = Arc::new(CapabilityTokenStore::default());
        let context = test_context(
            ControlEndpoint::from_transport("pipe".into()),
            directory.path(),
            tokens.clone(),
        );
        let previous = context
            .prepare(LaunchIntent::Direct {
                project_id: "project-1",
                provider_id: "codex",
            })
            .expect("previous launch");
        let previous_id = previous.agent().agent_id.clone();
        let previous_token = env_value(
            &previous.environment().merge_provider(&BTreeMap::new()),
            "ZLI_CONTROL_TOKEN",
        );
        previous.commit();

        let restart = context
            .prepare(LaunchIntent::Restart {
                replaces: &previous_id,
                project_id: "project-1",
                provider_id: "codex",
            })
            .expect("restart");
        let restart_token = env_value(
            &restart.environment().merge_provider(&BTreeMap::new()),
            "ZLI_CONTROL_TOKEN",
        );
        restart.commit();

        assert_eq!(
            tokens
                .verify(&previous_token)
                .expect_err("replaced agent revoked")
                .code,
            "CAPABILITY_DENIED"
        );
        tokens
            .verify(&restart_token)
            .expect("restart credential kept");
    }

    #[test]
    fn resume_commit_revokes_prior_generations_of_the_same_agent() {
        let directory = tempfile::tempdir().expect("install dir");
        write_sidecars(directory.path());
        let tokens = Arc::new(CapabilityTokenStore::default());
        let context = test_context(
            ControlEndpoint::from_transport("pipe".into()),
            directory.path(),
            tokens.clone(),
        );
        let descriptor = test_descriptor("agent-resume");
        let first = context
            .prepare(LaunchIntent::Resume {
                descriptor: &descriptor,
            })
            .expect("first resume generation");
        let first_token = env_value(
            &first.environment().merge_provider(&BTreeMap::new()),
            "ZLI_CONTROL_TOKEN",
        );
        first.commit();

        let second = context
            .prepare(LaunchIntent::Resume {
                descriptor: &descriptor,
            })
            .expect("second resume generation");
        let second_token = env_value(
            &second.environment().merge_provider(&BTreeMap::new()),
            "ZLI_CONTROL_TOKEN",
        );
        second.commit();

        assert_eq!(
            tokens
                .verify(&first_token)
                .expect_err("prior generation revoked")
                .code,
            "CAPABILITY_DENIED"
        );
        tokens
            .verify(&second_token)
            .expect("current resume credential kept");
    }
}
