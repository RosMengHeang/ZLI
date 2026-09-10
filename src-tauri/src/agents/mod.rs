use crate::error::BackendError;
use crate::pty::{EventSink, PtyManager, TerminalStatus};
use crate::system::{detect_powershell, find_executable};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::ffi::OsString;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use uuid::Uuid;

pub mod providers;

#[derive(Clone, Debug)]
pub struct ProviderSpec {
    pub id: &'static str,
    pub display_name: &'static str,
    pub candidates: &'static [&'static str],
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProvider {
    pub id: String,
    pub display_name: String,
    pub executable: String,
    pub installed: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchAgentRequest {
    pub name: String,
    pub provider: String,
    pub cwd: String,
    #[serde(default)]
    pub create_worktree: bool,
    #[serde(default)]
    pub cols: Option<u16>,
    #[serde(default)]
    pub rows: Option<u16>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentStatus {
    Running,
    Exited,
    Failed,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Agent {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub terminal_id: String,
    pub cwd: String,
    pub branch: String,
    pub worktree_path: Option<String>,
    pub status: AgentStatus,
    pub error: Option<String>,
}

#[derive(Clone)]
pub struct AgentManager {
    agents: Arc<Mutex<std::collections::HashMap<String, Agent>>>,
}

impl AgentManager {
    pub fn new() -> Self {
        Self {
            agents: Arc::new(Mutex::new(std::collections::HashMap::new())),
        }
    }

    pub fn launch(
        &self,
        request: LaunchAgentRequest,
        pty: &PtyManager,
        sink: Arc<dyn EventSink>,
    ) -> Result<Agent, BackendError> {
        self.launch_scoped(request, pty, sink, HashMap::new(), None)
    }

    pub(crate) fn launch_scoped(
        &self,
        request: LaunchAgentRequest,
        pty: &PtyManager,
        sink: Arc<dyn EventSink>,
        scoped_environment: HashMap<OsString, OsString>,
        agent_id: Option<String>,
    ) -> Result<Agent, BackendError> {
        let provider_id = request.provider.as_str();
        let provider_registry = providers::ProviderRegistry::default();
        let provider_adapter = if provider_id == "shell" {
            None
        } else {
            Some(
                provider_registry
                    .get(provider_id)
                    .ok_or_else(|| BackendError::ProviderNotFound(provider_id.to_owned()))?,
            )
        };
        let (provider, executable) = if provider_id == "shell" {
            (None, None)
        } else {
            let (spec, executable) = resolve_provider(provider_id)?;
            (Some(spec), Some(executable))
        };

        let mut launch_cwd = request.cwd.clone();
        let mut branch = String::new();
        let mut worktree_path = None;
        if request.create_worktree {
            let created = crate::git::worktree::create_worktree(
                crate::git::worktree::CreateWorktreeRequest {
                    repository_root: request.cwd.clone(),
                    provider: request.provider.clone(),
                    base_branch: None,
                },
            )
            .map_err(|err| BackendError::InvalidInput(err.to_string()))?;
            launch_cwd = created.worktree_path.clone();
            branch = created.branch;
            worktree_path = Some(created.worktree_path);
        }

        let session = match executable {
            Some(executable) => {
                let adapter = provider_adapter.expect("non-shell provider has an adapter");
                let plan = adapter.build_launch(&providers::ProviderLaunchRequest {
                    provider_id: adapter.id().to_owned(),
                    cwd: PathBuf::from(&launch_cwd),
                    executable: Some(executable),
                    provider_session_hint: None,
                })?;
                let environment = plan
                    .environment
                    .into_iter()
                    .chain(scoped_environment)
                    .collect();
                pty.spawn_agent_with_size_args_env(
                    plan.program,
                    plan.arguments,
                    Some(plan.cwd.to_string_lossy().as_ref()),
                    request.cols.unwrap_or(120),
                    request.rows.unwrap_or(30),
                    environment,
                    sink,
                )?
            }
            None => {
                let shell = crate::system::detect_shell()?;
                pty.spawn_agent_with_size_args_env(
                    shell,
                    Vec::new(),
                    Some(&launch_cwd),
                    request.cols.unwrap_or(120),
                    request.rows.unwrap_or(30),
                    scoped_environment,
                    sink,
                )?
            }
        };
        let agent = Agent {
            id: agent_id.unwrap_or_else(|| Uuid::new_v4().to_string()),
            name: if request.name.trim().is_empty() {
                provider
                    .as_ref()
                    .map(|item| item.display_name.to_owned())
                    .unwrap_or_else(|| "Terminal".to_owned())
            } else {
                request.name
            },
            provider: provider
                .as_ref()
                .map(|item| item.id.to_owned())
                .unwrap_or_else(|| "shell".to_owned()),
            terminal_id: session.id,
            cwd: session.cwd,
            branch,
            worktree_path,
            status: AgentStatus::Running,
            error: None,
        };
        self.agents
            .lock()
            .map_err(|_| BackendError::Internal("agent lock poisoned".into()))?
            .insert(agent.id.clone(), agent.clone());
        Ok(agent)
    }

    pub(crate) fn set_worktree_metadata(
        &self,
        id: &str,
        branch: String,
        worktree_path: String,
    ) -> Result<Agent, BackendError> {
        let mut agents = self
            .agents
            .lock()
            .map_err(|_| BackendError::Internal("agent lock poisoned".into()))?;
        let agent = agents
            .get_mut(id)
            .ok_or_else(|| BackendError::SessionNotFound(id.to_owned()))?;
        agent.branch = branch;
        agent.worktree_path = Some(worktree_path);
        Ok(agent.clone())
    }

    pub fn stop(&self, id: &str, pty: &PtyManager) -> Result<(), BackendError> {
        let terminal_id = self
            .agents
            .lock()
            .map_err(|_| BackendError::Internal("agent lock poisoned".into()))?
            .get(id)
            .map(|agent| agent.terminal_id.clone())
            .ok_or_else(|| BackendError::SessionNotFound(id.to_owned()))?;
        if let Err(error) = pty.kill(&terminal_id) {
            if !matches!(error, BackendError::SessionNotFound(_)) {
                return Err(error);
            }
        }
        self.agents
            .lock()
            .map_err(|_| BackendError::Internal("agent lock poisoned".into()))?
            .remove(id);
        Ok(())
    }

    pub fn list(&self, pty: &PtyManager) -> Result<Vec<Agent>, BackendError> {
        let mut agents = self
            .agents
            .lock()
            .map_err(|_| BackendError::Internal("agent lock poisoned".into()))?;
        for agent in agents.values_mut() {
            if agent.status == AgentStatus::Running {
                if let Ok(status) = pty.session_status(&agent.terminal_id) {
                    if status != TerminalStatus::Running {
                        agent.status = AgentStatus::Exited;
                    }
                } else {
                    agent.status = AgentStatus::Exited;
                }
            }
        }
        Ok(agents.values().cloned().collect())
    }
}

impl Default for AgentManager {
    fn default() -> Self {
        Self::new()
    }
}

pub(crate) fn launcher_for_executable(
    executable: PathBuf,
) -> Result<(PathBuf, Vec<OsString>), BackendError> {
    let extension = executable
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if extension == "ps1" {
        let shell = detect_powershell()?;
        return Ok((
            shell,
            vec![
                OsString::from("-NoLogo"),
                OsString::from("-NoProfile"),
                OsString::from("-ExecutionPolicy"),
                OsString::from("Bypass"),
                OsString::from("-File"),
                executable.into_os_string(),
            ],
        ));
    }
    if extension == "cmd" || extension == "bat" {
        let shell = find_executable(&["cmd.exe"]).ok_or_else(|| {
            BackendError::ExecutableNotFound("cmd.exe for Windows CLI script".to_owned())
        })?;
        return Ok((
            shell,
            vec![
                OsString::from("/D"),
                OsString::from("/S"),
                OsString::from("/C"),
                executable.into_os_string(),
            ],
        ));
    }
    Ok((executable, Vec::new()))
}

fn codex_compatibility_args(
    provider_id: &str,
    has_swarmterm_session: bool,
    config: &str,
) -> Vec<String> {
    if provider_id != "codex" || has_swarmterm_session {
        return Vec::new();
    }

    let mut in_swarmterm = false;
    let mut requires_session = false;
    let mut enabled = true;
    for raw_line in config.lines() {
        let line = raw_line.trim();
        if line.starts_with('[') && line.ends_with(']') {
            if in_swarmterm {
                break;
            }
            in_swarmterm = matches!(
                line,
                "[mcp_servers.swarmterm]" | "[mcp_servers.\"swarmterm\"]"
            );
            continue;
        }
        if !in_swarmterm {
            continue;
        }
        if let Some((key, value)) = line.split_once('=') {
            let key = key.trim();
            let value = value.trim().trim_matches(['\'', '"']);
            if key == "bearer_token_env_var" && value == "SWARMTERM_SESSION" {
                requires_session = true;
            } else if key == "enabled" && value.eq_ignore_ascii_case("false") {
                enabled = false;
            }
        }
    }

    if requires_session && enabled {
        vec![
            "-c".to_owned(),
            "mcp_servers.swarmterm.enabled=false".to_owned(),
        ]
    } else {
        Vec::new()
    }
}

fn runtime_codex_compatibility_args(provider_id: &str) -> Vec<OsString> {
    let has_swarmterm_session =
        env::var_os("SWARMTERM_SESSION").is_some_and(|value| !value.is_empty());
    let codex_home = env::var_os("CODEX_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                .filter(|value| !value.is_empty())
                .map(|value| PathBuf::from(value).join(".codex"))
        });
    let config = codex_home
        .and_then(|directory| fs::read_to_string(directory.join("config.toml")).ok())
        .unwrap_or_default();

    codex_compatibility_args(provider_id, has_swarmterm_session, &config)
        .into_iter()
        .map(OsString::from)
        .collect()
}

const CLAUDE_CANDIDATES: &[&str] = &["claude", "claude.exe", "claude.cmd", "claude.ps1"];
const CODEX_CANDIDATES: &[&str] = &["codex", "codex.exe", "codex.cmd", "codex.ps1"];
const CURSOR_CANDIDATES: &[&str] = &[
    "cursor-agent",
    "cursor-agent.exe",
    "cursor-agent.cmd",
    "agent",
    "agent.exe",
    "agent.cmd",
    "cursor-agent.ps1",
    "agent.ps1",
];
const OPENCODE_CANDIDATES: &[&str] = &["opencode", "opencode.exe", "opencode.cmd", "opencode.ps1"];
const GEMINI_CANDIDATES: &[&str] = &["gemini", "gemini.exe", "gemini.cmd", "gemini.ps1"];
const AIDER_CANDIDATES: &[&str] = &["aider", "aider.exe", "aider.cmd", "aider.ps1"];
const GOOSE_CANDIDATES: &[&str] = &["goose", "goose.exe", "goose.cmd", "goose.ps1"];

pub fn provider_specs() -> Vec<ProviderSpec> {
    vec![
        ProviderSpec {
            id: "claude-code",
            display_name: "Claude Code",
            candidates: CLAUDE_CANDIDATES,
        },
        ProviderSpec {
            id: "codex",
            display_name: "Codex",
            candidates: CODEX_CANDIDATES,
        },
        ProviderSpec {
            id: "cursor-agent",
            display_name: "Cursor Agent",
            candidates: CURSOR_CANDIDATES,
        },
        ProviderSpec {
            id: "opencode",
            display_name: "OpenCode",
            candidates: OPENCODE_CANDIDATES,
        },
        ProviderSpec {
            id: "gemini",
            display_name: "Gemini CLI",
            candidates: GEMINI_CANDIDATES,
        },
        ProviderSpec {
            id: "aider",
            display_name: "Aider",
            candidates: AIDER_CANDIDATES,
        },
        ProviderSpec {
            id: "goose",
            display_name: "Goose",
            candidates: GOOSE_CANDIDATES,
        },
    ]
}

pub fn provider_spec(provider_id: &str) -> Option<ProviderSpec> {
    let canonical_id = match provider_id {
        "claude" | "claude-code" => "claude-code",
        "codex" => "codex",
        "cursor" | "cursor-agent" => "cursor-agent",
        "opencode" => "opencode",
        "gemini" | "gemini-cli" => "gemini",
        "aider" => "aider",
        "goose" => "goose",
        _ => return None,
    };
    provider_specs()
        .into_iter()
        .find(|spec| spec.id == canonical_id)
}

pub fn resolve_provider(provider_id: &str) -> Result<(ProviderSpec, PathBuf), BackendError> {
    let spec = provider_spec(provider_id)
        .ok_or_else(|| BackendError::ProviderNotFound(provider_id.to_owned()))?;
    let executable = find_executable(spec.candidates).ok_or_else(|| {
        BackendError::ExecutableNotFound(format!("{} ({})", spec.display_name, spec.id))
    })?;
    Ok((spec, executable))
}

struct ProviderSnapshot {
    fetched_at: Instant,
    providers: Vec<AgentProvider>,
}

static PROVIDER_CACHE: Mutex<Option<ProviderSnapshot>> = Mutex::new(None);
const PROVIDER_CACHE_TTL: Duration = Duration::from_secs(20);

pub fn detect_providers() -> Vec<AgentProvider> {
    detect_providers_cached(false)
}

pub fn detect_providers_cached(force: bool) -> Vec<AgentProvider> {
    if !force {
        if let Ok(cache) = PROVIDER_CACHE.lock() {
            if let Some(snapshot) = cache.as_ref() {
                if snapshot.fetched_at.elapsed() < PROVIDER_CACHE_TTL {
                    return snapshot.providers.clone();
                }
            }
        }
    }
    let providers = scan_providers();
    if let Ok(mut cache) = PROVIDER_CACHE.lock() {
        *cache = Some(ProviderSnapshot {
            fetched_at: Instant::now(),
            providers: providers.clone(),
        });
    }
    providers
}

fn scan_providers() -> Vec<AgentProvider> {
    provider_specs()
        .into_iter()
        .map(|spec| {
            let executable = find_executable(spec.candidates);
            let installed = executable.is_some();
            AgentProvider {
                id: spec.id.to_owned(),
                display_name: spec.display_name.to_owned(),
                executable: executable
                    .map(|path| path.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                installed,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{
        codex_compatibility_args, detect_providers, provider_specs, AgentManager,
        LaunchAgentRequest,
    };
    use crate::pty::MemoryEventSink;
    use std::sync::Arc;
    use tempfile::tempdir;

    #[test]
    fn provider_specs_include_reasonable_cli_variants() {
        let specs = provider_specs();
        assert_eq!(specs.len(), 7);
        assert!(specs
            .iter()
            .find(|spec| spec.id == "claude-code")
            .unwrap()
            .candidates
            .contains(&"claude"));
        assert!(specs
            .iter()
            .find(|spec| spec.id == "codex")
            .unwrap()
            .candidates
            .contains(&"codex"));
        let cursor = specs.iter().find(|spec| spec.id == "cursor-agent").unwrap();
        assert!(cursor.candidates.contains(&"cursor-agent"));
        assert!(cursor.candidates.contains(&"agent"));
        assert!(specs
            .iter()
            .find(|spec| spec.id == "opencode")
            .unwrap()
            .candidates
            .contains(&"opencode"));
    }

    #[test]
    fn codex_disables_only_a_stale_swarmterm_mcp_registration() {
        let config = r#"
[mcp_servers.swarmterm]
url = "http://127.0.0.1:64832/mcp"
bearer_token_env_var = "SWARMTERM_SESSION"
"#;
        assert_eq!(
            codex_compatibility_args("codex", false, config),
            vec!["-c", "mcp_servers.swarmterm.enabled=false"]
        );
        assert!(codex_compatibility_args("codex", true, config).is_empty());
        assert!(codex_compatibility_args("claude-code", false, config).is_empty());
        assert!(codex_compatibility_args("codex", false, "[mcp_servers.github]").is_empty());
    }

    #[test]
    fn an_installed_coding_cli_launches_inside_a_real_pty() {
        let provider = detect_providers()
            .into_iter()
            .find(|provider| provider.installed);
        let Some(provider) = provider else {
            return;
        };
        let directory = tempdir().unwrap();
        let pty = crate::pty::PtyManager::new();
        let agents = AgentManager::new();
        let agent = agents
            .launch(
                LaunchAgentRequest {
                    name: "runtime-test".to_owned(),
                    provider: provider.id,
                    cwd: directory.path().to_string_lossy().into_owned(),
                    create_worktree: false,
                    cols: Some(80),
                    rows: Some(24),
                },
                &pty,
                Arc::new(MemoryEventSink::default()),
            )
            .unwrap();
        assert_eq!(agent.status, super::AgentStatus::Running);
        assert_eq!(pty.session_count(), 1);
        pty.kill(&agent.terminal_id).unwrap();
        agents.stop(&agent.id, &pty).unwrap();
        assert_eq!(pty.session_count(), 0);
        assert!(agents.list(&pty).unwrap().is_empty());
    }
}
