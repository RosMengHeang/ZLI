use crate::error::BackendError;
use crate::pty::{EventSink, PtyManager, TerminalStatus};
use crate::system::{detect_powershell, find_executable};
use serde::{Deserialize, Serialize};
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
    pub restart_agent_id: Option<String>,
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
        self.launch_scoped(
            &request,
            pty,
            sink,
            &crate::control::ManagedEnvironment::empty(),
            Uuid::new_v4().to_string(),
            None,
        )
    }

    pub(crate) fn launch_scoped(
        &self,
        request: &LaunchAgentRequest,
        pty: &PtyManager,
        sink: Arc<dyn EventSink>,
        environment: &crate::control::ManagedEnvironment,
        agent_id: String,
        bind: Option<&crate::control::ToolBindContext<'_>>,
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

        let session_result = match executable {
            Some(executable) => {
                let adapter = provider_adapter.expect("non-shell provider has an adapter");
                let plan = match adapter.build_launch(&providers::ProviderLaunchRequest {
                    provider_id: adapter.id().to_owned(),
                    cwd: PathBuf::from(&launch_cwd),
                    executable: Some(executable.clone()),
                    provider_session_hint: None,
                }) {
                    Ok(plan) => plan,
                    Err(error) => {
                        cleanup_created_worktree(&request.cwd, worktree_path.as_deref());
                        return Err(error);
                    }
                };
                let plan = match bind {
                    Some(ctx) => match ctx.apply(plan, &executable) {
                        Ok(plan) => plan,
                        Err(error) => {
                            cleanup_created_worktree(&request.cwd, worktree_path.as_deref());
                            return Err(BackendError::Internal(error.to_string()));
                        }
                    },
                    None => plan,
                };
                pty.spawn_agent_with_size_args_env(
                    plan.program,
                    plan.arguments,
                    Some(plan.cwd.to_string_lossy().as_ref()),
                    request.cols.unwrap_or(120),
                    request.rows.unwrap_or(30),
                    environment.merge_provider(&plan.environment),
                    sink,
                )
            }
            None => {
                let shell = match crate::system::detect_shell() {
                    Ok(shell) => shell,
                    Err(error) => {
                        cleanup_created_worktree(&request.cwd, worktree_path.as_deref());
                        return Err(error);
                    }
                };
                let shell_args = crate::pty::interactive_shell_args(&shell);
                pty.spawn_agent_with_size_args_env(
                    shell,
                    shell_args,
                    Some(&launch_cwd),
                    request.cols.unwrap_or(120),
                    request.rows.unwrap_or(30),
                    environment.merge_provider(&std::collections::BTreeMap::new()),
                    sink,
                )
            }
        };
        let session = match session_result {
            Ok(session) => session,
            Err(error) => {
                cleanup_created_worktree(&request.cwd, worktree_path.as_deref());
                return Err(error);
            }
        };
        let agent = Agent {
            id: agent_id,
            name: if request.name.trim().is_empty() {
                provider
                    .as_ref()
                    .map(|item| item.display_name.to_owned())
                    .unwrap_or_else(|| "Terminal".to_owned())
            } else {
                request.name.clone()
            },
            provider: provider
                .as_ref()
                .map(|item| item.id.to_owned())
                .unwrap_or_else(|| "shell".to_owned()),
            terminal_id: session.id,
            cwd: session.cwd,
            branch,
            worktree_path: worktree_path.clone(),
            status: AgentStatus::Running,
            error: None,
        };
        let mut agents = match self.agents.lock() {
            Ok(agents) => agents,
            Err(_) => {
                if pty.abort(&agent.terminal_id).is_ok() {
                    cleanup_created_worktree(&request.cwd, worktree_path.as_deref());
                }
                return Err(BackendError::Internal("agent lock poisoned".into()));
            }
        };
        agents.insert(agent.id.clone(), agent.clone());
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

    /// Remove an agent record after its runtime session has already been
    /// stopped or forgotten. This does not touch the PTY or process.
    pub fn forget(&self, id: &str) -> Result<bool, BackendError> {
        Ok(self
            .agents
            .lock()
            .map_err(|_| BackendError::Internal("agent lock poisoned".into()))?
            .remove(id)
            .is_some())
    }

    /// Roll back a launch transaction. Unlike a user stop, this must forget
    /// an unbound PTY as well, because the caller is abandoning the launch
    /// before the terminal is visible or associated with an agent.
    pub(crate) fn abort(&self, id: &str, pty: &PtyManager) -> Result<(), BackendError> {
        let terminal_id = self
            .agents
            .lock()
            .map_err(|_| BackendError::Internal("agent lock poisoned".into()))?
            .get(id)
            .map(|agent| agent.terminal_id.clone())
            .ok_or_else(|| BackendError::SessionNotFound(id.to_owned()))?;
        match pty.abort(&terminal_id) {
            Ok(()) | Err(BackendError::SessionNotFound(_)) => {}
            Err(error) => return Err(error),
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
    "cursor-agent.ps1",
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
    let executable = providers::ProviderRegistry::default()
        .get(spec.id)
        .and_then(|adapter| adapter.detect_installation())
        .or_else(|| find_executable(spec.candidates))
        .ok_or_else(|| {
            BackendError::ExecutableNotFound(format!("{} ({})", spec.display_name, spec.id))
        })?;
    Ok((spec, executable))
}

fn cleanup_created_worktree(repository_root: &str, worktree_path: Option<&str>) {
    let Some(worktree_path) = worktree_path.filter(|path| !path.trim().is_empty()) else {
        return;
    };
    let _ = crate::git::worktree::remove_worktree(crate::git::worktree::RemoveWorktreeRequest {
        repository_root: repository_root.to_owned(),
        worktree_path: worktree_path.to_owned(),
        force: false,
    });
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
    let registry = providers::ProviderRegistry::default();
    provider_specs()
        .into_iter()
        .map(|spec| {
            let executable = registry
                .get(spec.id)
                .and_then(|adapter| adapter.detect_installation())
                .or_else(|| find_executable(spec.candidates));
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
    use crate::git::worktree::list_worktrees;
    use crate::pty::MemoryEventSink;
    use std::fs;
    use std::path::Path;
    use std::process::Command;
    use std::sync::Arc;
    use tempfile::tempdir;

    fn git(dir: &Path, args: &[&str]) {
        let result = Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .expect("spawn git");
        assert!(
            result.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&result.stderr)
        );
    }

    #[cfg(windows)]
    #[test]
    fn cmd_scripts_launch_through_cmd_exe_with_quoting_switches() {
        use std::ffi::OsString;
        use std::path::PathBuf;
        let script = PathBuf::from(r"D:\Program Files\Cursor Agent\cursor-agent.cmd");
        let (program, arguments) =
            super::launcher_for_executable(script.clone()).expect("cmd launcher");
        assert!(program
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case("cmd.exe")));
        assert_eq!(
            arguments,
            vec![
                OsString::from("/D"),
                OsString::from("/S"),
                OsString::from("/C"),
                script.into_os_string(),
            ]
        );
    }

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
        assert!(!cursor.candidates.contains(&"agent"));
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
                    restart_agent_id: None,
                    cols: Some(80),
                    rows: Some(24),
                },
                &pty,
                Arc::new(MemoryEventSink::default()),
            )
            .unwrap();
        assert_eq!(agent.status, super::AgentStatus::Running);
        assert_eq!(pty.session_count(), 1);
        agents.abort(&agent.id, &pty).unwrap();
        assert_eq!(pty.session_count(), 0);
        assert!(agents.list(&pty).unwrap().is_empty());
    }

    #[test]
    fn failed_launch_removes_its_new_worktree_without_force() {
        let repository = tempdir().unwrap();
        git(repository.path(), &["init", "-b", "main"]);
        git(
            repository.path(),
            &["config", "user.email", "test@example.com"],
        );
        git(repository.path(), &["config", "user.name", "ZLI tests"]);
        fs::write(repository.path().join("README.md"), "fixture\n").unwrap();
        git(repository.path(), &["add", "README.md"]);
        git(repository.path(), &["commit", "-m", "fixture"]);

        let pty = crate::pty::PtyManager::new();
        let agents = AgentManager::new();
        let error = agents
            .launch(
                LaunchAgentRequest {
                    name: "failed-launch".to_owned(),
                    provider: "shell".to_owned(),
                    cwd: repository.path().to_string_lossy().into_owned(),
                    create_worktree: true,
                    restart_agent_id: None,
                    cols: Some(0),
                    rows: Some(30),
                },
                &pty,
                Arc::new(MemoryEventSink::default()),
            )
            .expect_err("invalid PTY dimensions should fail the launch");

        assert!(error.to_string().contains("columns"));
        assert_eq!(pty.session_count(), 0);
        assert_eq!(
            list_worktrees(&repository.path().to_string_lossy())
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn forgetting_an_agent_record_does_not_touch_the_pty() {
        let directory = tempdir().unwrap();
        let pty = crate::pty::PtyManager::new();
        let agents = AgentManager::new();
        let agent = agents
            .launch(
                LaunchAgentRequest {
                    name: "forget-test".to_owned(),
                    provider: "shell".to_owned(),
                    cwd: directory.path().to_string_lossy().into_owned(),
                    create_worktree: false,
                    restart_agent_id: None,
                    cols: Some(80),
                    rows: Some(24),
                },
                &pty,
                Arc::new(MemoryEventSink::default()),
            )
            .unwrap();

        assert!(agents.forget(&agent.id).unwrap());
        assert_eq!(pty.session_count(), 1);
        pty.kill(&agent.terminal_id).unwrap();
        assert!(agents.list(&pty).unwrap().is_empty());
    }
}
