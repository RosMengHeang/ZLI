use super::managed_agent_context::{ManagedAgentIdentity, SidecarPaths};
use crate::agents::providers::LaunchPlan;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::ffi::OsString;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const ZLI_MCP_SERVER_ID: &str = "zli_browser_use";
const HELP_PROBE_TIMEOUT: Duration = Duration::from_millis(1500);

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ToolBinding {
    Mcp {
        provider_id: String,
        server_id: &'static str,
        evidence: BindEvidence,
        argv: Vec<OsString>,
        overlay_dir: PathBuf,
    },
    Shell {
        provider_id: String,
        reason: String,
        prompt_path: PathBuf,
        zli: PathBuf,
        browser_use: PathBuf,
        argv: Vec<OsString>,
    },
    Unsupported {
        provider_id: String,
        reason: String,
    },
}

impl ToolBinding {
    pub fn mode(&self) -> &'static str {
        match self {
            Self::Mcp { .. } => "mcp",
            Self::Shell { .. } => "shell_fallback",
            Self::Unsupported { .. } => "unsupported",
        }
    }

    pub fn mcp_configured(&self) -> bool {
        matches!(self, Self::Mcp { .. })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BindEvidence {
    LaunchFlag {
        flag: &'static str,
        artifact: Option<PathBuf>,
    },
    ProjectFile {
        path: PathBuf,
        reserved_key: &'static str,
        command: PathBuf,
    },
}

#[derive(Clone, Debug)]
pub struct BindRequest {
    pub agent: ManagedAgentIdentity,
    pub cwd: PathBuf,
    pub sidecars: SidecarPaths,
    pub extra_argv: Vec<OsString>,
    pub program: PathBuf,
}

#[derive(Debug)]
pub enum BindError {
    Io(std::io::Error),
    InvalidConfig(String),
}

impl std::fmt::Display for BindError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "{error}"),
            Self::InvalidConfig(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for BindError {}

impl From<std::io::Error> for BindError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}

pub struct ToolBindContext<'a> {
    pub tools: &'a ProviderTools,
    pub agent: &'a ManagedAgentIdentity,
    pub sidecars: &'a SidecarPaths,
}

impl ToolBindContext<'_> {
    pub fn apply(&self, plan: LaunchPlan, program: &Path) -> Result<LaunchPlan, BindError> {
        let binding = self.tools.bind(BindRequest {
            agent: self.agent.clone(),
            cwd: plan.cwd.clone(),
            sidecars: self.sidecars.clone(),
            extra_argv: plan.arguments.clone(),
            program: program.to_path_buf(),
        })?;
        Ok(ProviderTools::apply_launch(plan, &binding))
    }
}

pub struct ProviderTools {
    bindings: Mutex<HashMap<String, ToolBinding>>,
    overlay_root: PathBuf,
}

impl ProviderTools {
    pub fn new(overlay_root: PathBuf) -> Self {
        Self {
            bindings: Mutex::new(HashMap::new()),
            overlay_root,
        }
    }

    pub fn bind(&self, request: BindRequest) -> Result<ToolBinding, BindError> {
        let overlay = overlay_dir(&self.overlay_root, &request.agent.agent_id);
        fs::create_dir_all(&overlay)?;
        let recipe = recipe_for(&request.agent.provider_id);
        let binding = match recipe {
            ToolRecipe::ClaudeSessionMcp => bind_claude(&request, &overlay)?,
            ToolRecipe::CodexArgvOverlay => bind_codex(&request, &overlay)?,
            ToolRecipe::CursorProjectMcp
            | ToolRecipe::OpenCodeProjectMcp
            | ToolRecipe::GeminiProjectSettings
            | ToolRecipe::ShellOnly => bind_shell(&request, &overlay, shell_reason(recipe))?,
        };
        self.retain(&request.agent.agent_id, binding.clone());
        Ok(binding)
    }

    pub fn apply_launch(mut plan: LaunchPlan, binding: &ToolBinding) -> LaunchPlan {
        match binding {
            ToolBinding::Mcp { argv, .. } | ToolBinding::Shell { argv, .. } => {
                plan.arguments.extend(argv.iter().cloned());
            }
            ToolBinding::Unsupported { .. } => {}
        }
        plan
    }

    pub fn get(&self, agent_id: &str) -> Option<ToolBinding> {
        self.lock().get(agent_id).cloned()
    }

    pub fn forget(&self, agent_id: &str) {
        self.lock().remove(agent_id);
    }

    fn retain(&self, agent_id: &str, binding: ToolBinding) {
        self.lock().insert(agent_id.to_owned(), binding);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, ToolBinding>> {
        self.bindings
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolRecipe {
    ClaudeSessionMcp,
    CodexArgvOverlay,
    CursorProjectMcp,
    OpenCodeProjectMcp,
    GeminiProjectSettings,
    ShellOnly,
}

pub fn recipe_for(provider_id: &str) -> ToolRecipe {
    match provider_id {
        "claude-code" => ToolRecipe::ClaudeSessionMcp,
        "codex" => ToolRecipe::CodexArgvOverlay,
        "cursor-agent" => ToolRecipe::CursorProjectMcp,
        "opencode" => ToolRecipe::OpenCodeProjectMcp,
        "gemini" => ToolRecipe::GeminiProjectSettings,
        "aider" | "goose" => ToolRecipe::ShellOnly,
        _ => ToolRecipe::ShellOnly,
    }
}

pub fn overlay_dir(root: &Path, agent_id: &str) -> PathBuf {
    root.join(agent_id)
}

pub fn write_claude_mcp_json(dir: &Path, browser_use: &Path) -> Result<PathBuf, BindError> {
    fs::create_dir_all(dir)?;
    let path = dir.join("mcp.json");
    let body = json!({
        "mcpServers": {
            ZLI_MCP_SERVER_ID: {
                "command": path_value(browser_use),
                "args": []
            }
        }
    });
    fs::write(&path, serde_json::to_vec_pretty(&body).map_err(json_err)?)?;
    Ok(path)
}

pub enum ProjectMcpFormat {
    CursorMcpJson,
    OpenCodeJsonc,
    GeminiSettings,
}

pub fn merge_reserved_server(
    path: &Path,
    format: ProjectMcpFormat,
    command: &Path,
) -> Result<BindEvidence, BindError> {
    match format {
        ProjectMcpFormat::CursorMcpJson | ProjectMcpFormat::GeminiSettings => {
            merge_mcp_servers(path, command)
        }
        ProjectMcpFormat::OpenCodeJsonc => merge_opencode(path, command),
    }
}

pub fn write_shell_fallback_txt(
    dir: &Path,
    zli: &Path,
    agent_id: &str,
) -> Result<PathBuf, BindError> {
    fs::create_dir_all(dir)?;
    let path = dir.join("shell-fallback.txt");
    let zli = zli.display();
    let body = format!(
        "ZLI CLI for agent {agent_id}. Use these absolute commands.\n\
         \n\
         Browser (ZLI built-in pane):\n\
         {zli} browser open <url> --project <project>\n\
         {zli} browser list --project <project>\n\
         {zli} browser snapshot <surfaceId>\n\
         {zli} browser click <surfaceId> <selector>\n\
         {zli} browser fill <surfaceId> <selector> <text>\n\
         {zli} browser screenshot <surfaceId>\n\
         {zli} browser status\n\
         \n\
         Messaging stays on the CLI, not MCP:\n\
         {zli} agent pull {agent_id}\n\
         {zli} taxchat send <message> --project <project> [--to <agentId>]\n\
         {zli} agent send <agentId> <message>\n"
    );
    fs::write(&path, body)?;
    Ok(path)
}

pub fn help_contains(executable: &Path, needle: &str) -> bool {
    capture_help(executable).is_ok_and(|text| text.contains(needle))
}

fn bind_claude(request: &BindRequest, overlay: &Path) -> Result<ToolBinding, BindError> {
    let prompt = write_shell_fallback_txt(
        overlay,
        request.sidecars.control(),
        &request.agent.agent_id,
    )?;
    if !help_contains(&request.program, "--mcp-config") {
        return Ok(shell_binding(
            request,
            prompt.clone(),
            "--mcp-config is not available on this Claude CLI".into(),
            prompt_argv(&request.program, &prompt),
        ));
    }
    let mcp_json = write_claude_mcp_json(overlay, request.sidecars.browser_use())?;
    let mut argv = vec![
        OsString::from("--mcp-config"),
        mcp_json.into_os_string(),
    ];
    argv.extend(prompt_argv(&request.program, &prompt));
    Ok(ToolBinding::Mcp {
        provider_id: request.agent.provider_id.clone(),
        server_id: ZLI_MCP_SERVER_ID,
        evidence: BindEvidence::LaunchFlag {
            flag: "--mcp-config",
            artifact: Some(overlay.join("mcp.json")),
        },
        argv,
        overlay_dir: overlay.to_path_buf(),
    })
}

fn bind_codex(request: &BindRequest, overlay: &Path) -> Result<ToolBinding, BindError> {
    write_shell_fallback_txt(overlay, request.sidecars.control(), &request.agent.agent_id)?;
    let command = path_value(request.sidecars.browser_use());
    let overlay_key = format!("mcp_servers.{ZLI_MCP_SERVER_ID}.command=");
    let argv = if request
        .extra_argv
        .iter()
        .any(|arg| arg.to_string_lossy().contains(&overlay_key))
    {
        Vec::new()
    } else {
        vec![
            OsString::from("-c"),
            OsString::from(format!("{overlay_key}{command}")),
        ]
    };
    Ok(ToolBinding::Mcp {
        provider_id: request.agent.provider_id.clone(),
        server_id: ZLI_MCP_SERVER_ID,
        evidence: BindEvidence::LaunchFlag {
            flag: "-c",
            artifact: None,
        },
        argv,
        overlay_dir: overlay.to_path_buf(),
    })
}

fn bind_shell(
    request: &BindRequest,
    overlay: &Path,
    reason: String,
) -> Result<ToolBinding, BindError> {
    let prompt = write_shell_fallback_txt(
        overlay,
        request.sidecars.control(),
        &request.agent.agent_id,
    )?;
    // Explicit-pull providers must remain interactive. Passing the cookbook
    // as a provider prompt turns it into a one-shot request; once the model
    // answers, the provider exits and ZLI loses the session. The cookbook is
    // still created in the overlay so the user or provider can run the
    // scoped `agent pull` command from the live terminal.
    let reason = format!(
        "{reason} Run `agent pull {}` in the live provider terminal; instructions are in `{}`.",
        request.agent.agent_id,
        prompt.display()
    );
    Ok(shell_binding(request, prompt, reason, Vec::new()))
}

fn shell_binding(
    request: &BindRequest,
    prompt: PathBuf,
    reason: String,
    argv: Vec<OsString>,
) -> ToolBinding {
    ToolBinding::Shell {
        provider_id: request.agent.provider_id.clone(),
        reason,
        prompt_path: prompt,
        zli: request.sidecars.control().to_path_buf(),
        browser_use: request.sidecars.browser_use().to_path_buf(),
        argv,
    }
}

fn prompt_argv(program: &Path, prompt: &Path) -> Vec<OsString> {
    if help_contains(program, "--append-system-prompt-file") {
        vec![
            OsString::from("--append-system-prompt-file"),
            prompt.as_os_str().to_owned(),
        ]
    } else {
        Vec::new()
    }
}

fn shell_reason(recipe: ToolRecipe) -> String {
    match recipe {
        ToolRecipe::CursorProjectMcp => {
            "Cursor MCP project merge is reserved until a verification gate passes.".into()
        }
        ToolRecipe::OpenCodeProjectMcp => {
            "OpenCode MCP project merge is reserved until a verification gate passes.".into()
        }
        ToolRecipe::GeminiProjectSettings => {
            "Gemini MCP settings merge is reserved until vendor session flags are verified.".into()
        }
        ToolRecipe::ClaudeSessionMcp
        | ToolRecipe::CodexArgvOverlay
        | ToolRecipe::ShellOnly => {
            "This provider has no documented session MCP overlay.".into()
        }
    }
}

fn merge_mcp_servers(path: &Path, command: &Path) -> Result<BindEvidence, BindError> {
    let mut root = read_json_object(path)?;
    let servers = root
        .entry("mcpServers".to_owned())
        .or_insert_with(|| json!({}));
    let Some(servers) = servers.as_object_mut() else {
        return Err(BindError::InvalidConfig(
            "mcpServers must be a JSON object".into(),
        ));
    };
    servers.insert(
        ZLI_MCP_SERVER_ID.to_owned(),
        json!({
            "command": path_value(command),
            "args": []
        }),
    );
    write_json(path, &Value::Object(root))?;
    Ok(BindEvidence::ProjectFile {
        path: path.to_path_buf(),
        reserved_key: ZLI_MCP_SERVER_ID,
        command: command.to_path_buf(),
    })
}

fn merge_opencode(path: &Path, command: &Path) -> Result<BindEvidence, BindError> {
    let mut root = read_json_object(path)?;
    let mcp = root.entry("mcp".to_owned()).or_insert_with(|| json!({}));
    let Some(mcp) = mcp.as_object_mut() else {
        return Err(BindError::InvalidConfig("mcp must be a JSON object".into()));
    };
    mcp.insert(
        ZLI_MCP_SERVER_ID.to_owned(),
        json!({
            "type": "local",
            "command": [path_value(command)]
        }),
    );
    write_json(path, &Value::Object(root))?;
    Ok(BindEvidence::ProjectFile {
        path: path.to_path_buf(),
        reserved_key: ZLI_MCP_SERVER_ID,
        command: command.to_path_buf(),
    })
}

fn read_json_object(path: &Path) -> Result<serde_json::Map<String, Value>, BindError> {
    if !path.is_file() {
        return Ok(serde_json::Map::new());
    }
    let bytes = fs::read(path)?;
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|error| BindError::InvalidConfig(error.to_string()))?;
    value
        .as_object()
        .cloned()
        .ok_or_else(|| BindError::InvalidConfig("project MCP file must be a JSON object".into()))
}

fn write_json(path: &Path, value: &Value) -> Result<(), BindError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, serde_json::to_vec_pretty(value).map_err(json_err)?)?;
    Ok(())
}

fn path_value(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn json_err(error: serde_json::Error) -> BindError {
    BindError::InvalidConfig(error.to_string())
}

fn capture_help(executable: &Path) -> Result<String, String> {
    let (program, mut arguments) = crate::agents::launcher_for_executable(executable.to_path_buf())
        .map_err(|error| error.to_string())?;
    arguments.push(OsString::from("--help"));
    let mut child = Command::new(&program)
        .args(&arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| error.to_string())?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                let mut stdout = String::new();
                let mut stderr = String::new();
                if let Some(mut pipe) = child.stdout.take() {
                    let _ = pipe.read_to_string(&mut stdout);
                }
                if let Some(mut pipe) = child.stderr.take() {
                    let _ = pipe.read_to_string(&mut stderr);
                }
                stdout.push_str(&stderr);
                return Ok(stdout);
            }
            Ok(None) if started.elapsed() < HELP_PROBE_TIMEOUT => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("help probe timed out".into());
            }
            Err(error) => return Err(error.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::providers::LaunchPlan;
    use std::collections::BTreeMap;
    use std::ffi::OsString;

    fn identity(provider: &str) -> ManagedAgentIdentity {
        ManagedAgentIdentity {
            agent_id: "agent-1".into(),
            project_id: "project-1".into(),
            provider_id: provider.into(),
            parent_agent_id: None,
        }
    }

    fn sidecars(dir: &Path) -> SidecarPaths {
        let control = if cfg!(windows) { "zli.exe" } else { "zli" };
        let browser = if cfg!(windows) {
            "zli-browser-use.exe"
        } else {
            "zli-browser-use"
        };
        fs::write(dir.join(control), []).unwrap();
        fs::write(dir.join(browser), []).unwrap();
        SidecarPaths::resolve(dir).unwrap()
    }

    fn stub_help(dir: &Path, name: &str, help: &str) -> PathBuf {
        if cfg!(windows) {
            let path = dir.join(format!("{name}.cmd"));
            fs::write(&path, format!("@echo off\r\necho {help}\r\n")).unwrap();
            path
        } else {
            let path = dir.join(name);
            fs::write(&path, format!("#!/bin/sh\necho '{help}'\n")).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mut permissions = fs::metadata(&path).unwrap().permissions();
                permissions.set_mode(0o755);
                fs::set_permissions(&path, permissions).unwrap();
            }
            path
        }
    }

    fn request(
        root: &Path,
        provider: &str,
        program: PathBuf,
        extra_argv: Vec<OsString>,
    ) -> (ProviderTools, BindRequest) {
        let sidecars = sidecars(root);
        let tools = ProviderTools::new(root.join("overlays"));
        (
            tools,
            BindRequest {
                agent: identity(provider),
                cwd: root.to_path_buf(),
                sidecars,
                extra_argv,
                program,
            },
        )
    }

    #[test]
    fn claude_bind_writes_session_mcp_config_without_strict_or_token() {
        let root = tempfile::tempdir().unwrap();
        let program = stub_help(
            root.path(),
            "claude",
            "--mcp-config --append-system-prompt-file",
        );
        let (tools, request) = request(root.path(), "claude-code", program, Vec::new());
        let binding = tools.bind(request).expect("claude bind");
        let ToolBinding::Mcp {
            argv,
            evidence,
            overlay_dir,
            server_id,
            ..
        } = binding
        else {
            panic!("expected MCP binding: {binding:?}");
        };
        assert_eq!(server_id, ZLI_MCP_SERVER_ID);
        assert!(argv.iter().any(|arg| arg == "--mcp-config"));
        assert!(argv
            .iter()
            .any(|arg| arg == "--append-system-prompt-file"));
        assert!(!argv.iter().any(|arg| arg == "--strict-mcp-config"));
        let BindEvidence::LaunchFlag { flag, artifact } = evidence else {
            panic!("expected launch flag");
        };
        assert_eq!(flag, "--mcp-config");
        let mcp_path = artifact.expect("mcp.json");
        let bytes = fs::read_to_string(&mcp_path).unwrap();
        assert!(!bytes.contains("ZLI_CONTROL_TOKEN"));
        let parsed: Value = serde_json::from_str(&bytes).unwrap();
        assert!(parsed["mcpServers"]["zli_browser_use"]["command"]
            .as_str()
            .unwrap()
            .contains("zli-browser-use"));
        assert_eq!(parsed["mcpServers"]["zli_browser_use"]["args"], json!([]));
        assert!(overlay_dir.join("shell-fallback.txt").is_file());
        assert!(tools.get("agent-1").unwrap().mcp_configured());
    }

    #[test]
    fn claude_without_mcp_config_flag_binds_shell() {
        let root = tempfile::tempdir().unwrap();
        let program = stub_help(root.path(), "claude", "Usage: claude");
        let (tools, request) = request(root.path(), "claude-code", program, Vec::new());
        let binding = tools.bind(request).expect("shell bind");
        match binding {
            ToolBinding::Shell { prompt_path, argv, .. } => {
                assert!(prompt_path.is_file());
                assert!(!argv.iter().any(|arg| arg == "--mcp-config"));
            }
            other => panic!("expected Shell, got {other:?}"),
        }
        assert!(!tools.get("agent-1").unwrap().mcp_configured());
        assert_eq!(tools.get("agent-1").unwrap().mode(), "shell_fallback");
    }

    #[test]
    fn codex_bind_appends_zli_mcp_keys_beside_swarmterm_disable() {
        let root = tempfile::tempdir().unwrap();
        let (tools, request) = request(
            root.path(),
            "codex",
            root.path().join("codex"),
            vec![
                OsString::from("-c"),
                OsString::from("mcp_servers.swarmterm.enabled=false"),
            ],
        );
        let binding = tools.bind(request).expect("codex bind");
        let plan = LaunchPlan {
            program: PathBuf::from("codex"),
            arguments: vec![
                OsString::from("-c"),
                OsString::from("mcp_servers.swarmterm.enabled=false"),
            ],
            cwd: root.path().to_path_buf(),
            environment: BTreeMap::new(),
            provider_session_hint: None,
        };
        let plan = ProviderTools::apply_launch(plan, &binding);
        let argv: Vec<String> = plan
            .arguments
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert!(argv.contains(&"mcp_servers.swarmterm.enabled=false".to_owned()));
        assert!(argv.iter().any(|arg| arg.contains("mcp_servers.zli_browser_use.command=")));
        assert!(matches!(
            binding,
            ToolBinding::Mcp {
                evidence: BindEvidence::LaunchFlag { flag: "-c", artifact: None },
                ..
            }
        ));
        assert!(!root.path().join("config.toml").exists());
        assert!(!root.path().join(".codex").join("config.toml").exists());
    }

    #[test]
    fn cursor_bind_is_shell_until_verification_and_cookbook_exists() {
        let root = tempfile::tempdir().unwrap();
        let (tools, request) = request(root.path(), "cursor-agent", root.path().join("cursor-agent"), Vec::new());
        let binding = tools.bind(request).expect("cursor bind");
        match binding {
            ToolBinding::Shell {
                reason,
                prompt_path,
                zli,
                argv,
                ..
            } => {
                assert!(reason.contains("verification"));
                assert!(reason.contains("agent pull agent-1"));
                assert!(prompt_path.is_file());
                assert!(fs::read_to_string(&prompt_path)
                    .unwrap()
                    .contains(&zli.display().to_string()));
                assert!(argv.is_empty());
            }
            other => panic!("Cursor must not claim MCP: {other:?}"),
        }
        assert!(!tools.get("agent-1").unwrap().mcp_configured());
    }

    #[test]
    fn opencode_shell_fallback_keeps_the_provider_interactive() {
        let root = tempfile::tempdir().unwrap();
        let (tools, request) = request(root.path(), "opencode", root.path().join("opencode"), Vec::new());
        let binding = tools.bind(request).expect("opencode bind");
        match binding {
            ToolBinding::Shell { argv, prompt_path, .. } => {
                assert!(argv.is_empty());
                assert!(fs::read_to_string(prompt_path)
                    .unwrap()
                    .contains("agent pull agent-1"));
            }
            other => panic!("OpenCode must use the verified shell bootstrap: {other:?}"),
        }
    }

    #[test]
    fn explicit_pull_providers_start_interactively_without_a_one_shot_prompt() {
        for provider in ["cursor-agent", "opencode"] {
            let root = tempfile::tempdir().unwrap();
            let (tools, request) = request(
                root.path(),
                provider,
                root.path().join(provider),
                Vec::new(),
            );
            let binding = tools.bind(request).expect("explicit-pull bind");
            match binding {
                ToolBinding::Shell { argv, prompt_path, .. } => {
                    assert!(argv.is_empty(), "{provider} must remain interactive");
                    assert!(fs::read_to_string(prompt_path)
                        .unwrap()
                        .contains("agent pull agent-1"));
                }
                other => panic!("{provider} must use the interactive shell fallback: {other:?}"),
            }
        }
    }

    #[test]
    fn aider_never_binds_mcp() {
        let root = tempfile::tempdir().unwrap();
        let (tools, request) = request(root.path(), "aider", root.path().join("aider"), Vec::new());
        let binding = tools.bind(request).expect("aider bind");
        assert!(!matches!(binding, ToolBinding::Mcp { .. }));
    }

    #[test]
    fn cursor_merge_keeps_existing_github_server() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join(".cursor").join("mcp.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            serde_json::to_vec_pretty(&json!({
                "mcpServers": {
                    "github": { "command": "github-mcp", "args": [] }
                }
            }))
            .unwrap(),
        )
        .unwrap();
        let command = root.path().join("zli-browser-use.exe");
        let evidence =
            merge_reserved_server(&path, ProjectMcpFormat::CursorMcpJson, &command).unwrap();
        let parsed: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(parsed["mcpServers"]["github"]["command"], "github-mcp");
        assert!(parsed["mcpServers"]["zli_browser_use"]["command"]
            .as_str()
            .unwrap()
            .contains("zli-browser-use"));
        assert!(!fs::read_to_string(&path).unwrap().contains("ZLI_CONTROL_TOKEN"));
        assert!(matches!(
            evidence,
            BindEvidence::ProjectFile {
                reserved_key: ZLI_MCP_SERVER_ID,
                ..
            }
        ));
    }

    #[test]
    fn resume_bind_rewrites_the_same_overlay() {
        let root = tempfile::tempdir().unwrap();
        let program = stub_help(root.path(), "claude", "--mcp-config");
        let (tools, first_request) = request(root.path(), "claude-code", program.clone(), Vec::new());
        let first = tools.bind(first_request).expect("first");
        let (_, second_request) = request(root.path(), "claude-code", program, Vec::new());
        let second = tools.bind(second_request).expect("second");
        match (first, second) {
            (
                ToolBinding::Mcp {
                    argv: first_argv,
                    overlay_dir: first_dir,
                    ..
                },
                ToolBinding::Mcp {
                    argv: second_argv,
                    overlay_dir: second_dir,
                    ..
                },
            ) => {
                assert_eq!(first_dir, second_dir);
                assert_eq!(first_argv, second_argv);
                let bytes = fs::read(first_dir.join("mcp.json")).unwrap();
                assert_eq!(bytes, fs::read(second_dir.join("mcp.json")).unwrap());
            }
            other => panic!("expected matching MCP binds: {other:?}"),
        }
    }
}
