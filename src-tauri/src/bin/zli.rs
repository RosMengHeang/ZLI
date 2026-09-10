#[cfg(windows)]
use serde::Deserialize;
#[cfg(windows)]
use serde_json::{json, Value};
#[cfg(windows)]
use std::path::PathBuf;
#[cfg(windows)]
use swarmterm_lib::control::{
    ControlMethod, ControlRequest, NamedPipeClient, CONTROL_PROTOCOL_VERSION,
};

#[cfg(windows)]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionInfo {
    protocol_version: u16,
    endpoint: String,
    token: String,
}

#[cfg(windows)]
fn main() {
    if let Err(error) = run() {
        eprintln!("zli: {error}");
        std::process::exit(1);
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("zli: the local control transport currently requires Windows");
    std::process::exit(1);
}

#[cfg(windows)]
fn run() -> Result<(), String> {
    let mut args = std::env::args().skip(1).collect::<Vec<_>>();
    let json_output = remove_flag(&mut args, "--json");
    let (method, params) = parse_command(&args)?;
    let request = ControlRequest::new(UuidRequestId::new(), method, params, 30_000)
        .map_err(|error| error.to_string())?;
    let connection = connection_info()?;
    if connection.protocol_version != CONTROL_PROTOCOL_VERSION {
        return Err("the running ZLI app uses an incompatible control protocol".into());
    }
    let response = NamedPipeClient::new(connection.endpoint, connection.token)
        .request(request)
        .map_err(|error| format!("could not reach the running ZLI app: {error}"))?;
    if json_output {
        println!(
            "{}",
            serde_json::to_string(&response).map_err(|error| error.to_string())?
        );
    } else if response.ok {
        let result = response.result.unwrap_or(Value::Null);
        if result.is_null() {
            println!("OK");
        } else {
            println!(
                "{}",
                serde_json::to_string_pretty(&result).map_err(|error| error.to_string())?
            );
        }
    } else if let Some(error) = response.error {
        return Err(format!("{}: {}", error.code, error.message));
    }
    Ok(())
}

#[cfg(windows)]
fn parse_command(args: &[String]) -> Result<(ControlMethod, Value), String> {
    let group = args.first().map(String::as_str);
    let action = args.get(1).map(String::as_str);
    match (group, action) {
        (Some("status"), _) => Ok((ControlMethod::SessionList, json!({}))),
        (Some("agents"), _) | (Some("agent"), Some("list")) => {
            Ok((ControlMethod::AgentList, json!({})))
        }
        (Some("attention"), _) => Ok((ControlMethod::AttentionList, json!({}))),
        (Some("session"), Some("list")) => Ok((ControlMethod::SessionList, json!({}))),
        (Some("session"), Some("resume")) => Ok((
            ControlMethod::SessionResume,
            json!({ "sessionId": required(args.get(2), "session ID")? }),
        )),
        (Some("agent"), Some("send")) => {
            let agent_id = required(args.get(2), "agent ID")?;
            let body = joined(args, 3, "message")?;
            Ok((
                ControlMethod::AgentSend,
                json!({ "agentId": agent_id, "body": body }),
            ))
        }
        (Some("agent"), Some("spawn")) => {
            let managed_project = std::env::var("ZLI_PROJECT_ID")
                .ok()
                .filter(|value| !value.is_empty());
            let flagged = args
                .iter()
                .any(|arg| arg == "--provider" || arg == "--task");
            let (project_id, provider_id, task, name) = if flagged {
                (
                    option(args, "--project")
                        .map(str::to_owned)
                        .or(managed_project)
                        .ok_or_else(|| {
                            "project is required; pass --project outside a managed agent".to_owned()
                        })?,
                    option(args, "--provider")
                        .ok_or_else(|| "provider is required".to_owned())?
                        .to_owned(),
                    option(args, "--task")
                        .ok_or_else(|| "task is required".to_owned())?
                        .to_owned(),
                    option(args, "--name").map(str::to_owned),
                )
            } else if let Some(project_id) = managed_project {
                (
                    project_id,
                    required(args.get(2), "provider")?.to_owned(),
                    joined(args, 3, "task")?,
                    None,
                )
            } else {
                (
                    required(args.get(2), "project")?.to_owned(),
                    required(args.get(3), "provider")?.to_owned(),
                    joined(args, 4, "task")?,
                    None,
                )
            };
            Ok((
                ControlMethod::AgentSpawn,
                json!({ "projectId": project_id, "providerId": provider_id, "task": task, "name": name }),
            ))
        }
        (Some("agent"), Some(action @ ("read" | "focus" | "pause" | "stop"))) => {
            let method = match action {
                "read" => ControlMethod::AgentRead,
                "focus" => ControlMethod::AgentFocus,
                "pause" => ControlMethod::AgentPause,
                _ => ControlMethod::AgentStop,
            };
            Ok((
                method,
                json!({ "agentId": required(args.get(2), "agent ID")? }),
            ))
        }
        (Some("browser"), Some("list")) => Ok((ControlMethod::BrowserList, json!({}))),
        (Some("browser"), Some(action @ ("open" | "navigate"))) => Ok((
            if action == "open" {
                ControlMethod::BrowserOpen
            } else {
                ControlMethod::BrowserNavigate
            },
            json!({ "url": required(args.get(2), "URL")? }),
        )),
        (Some("taxchat"), Some("send")) => Ok((
            ControlMethod::TaxChatSend,
            json!({ "body": joined(args, 2, "message")? }),
        )),
        _ => Err(usage()),
    }
}

#[cfg(windows)]
fn connection_info() -> Result<ConnectionInfo, String> {
    match (
        std::env::var("ZLI_CONTROL_ENDPOINT").ok(),
        std::env::var("ZLI_CONTROL_TOKEN").ok(),
    ) {
        (Some(endpoint), Some(token)) if !endpoint.is_empty() && !token.is_empty() => {
            Ok(ConnectionInfo {
                protocol_version: CONTROL_PROTOCOL_VERSION,
                endpoint,
                token,
            })
        }
        _ => {
            let app_data = std::env::var_os("APPDATA")
                .map(PathBuf::from)
                .ok_or_else(|| "APPDATA is unavailable".to_owned())?;
            let path = app_data
                .join("com.taxzy.cli")
                .join("control")
                .join("endpoint.json");
            let bytes = std::fs::read(path).map_err(|_| {
                "ZLI is not running or its control endpoint is unavailable".to_owned()
            })?;
            serde_json::from_slice(&bytes)
                .map_err(|_| "the ZLI control endpoint file is invalid".to_owned())
        }
    }
}

#[cfg(windows)]
fn remove_flag(args: &mut Vec<String>, flag: &str) -> bool {
    let found = args.iter().any(|arg| arg == flag);
    args.retain(|arg| arg != flag);
    found
}

#[cfg(windows)]
fn option<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter()
        .position(|arg| arg == name)
        .and_then(|index| args.get(index + 1))
        .filter(|value| !value.starts_with("--") && !value.trim().is_empty())
        .map(String::as_str)
}

#[cfg(windows)]
fn required<'a>(value: Option<&'a String>, label: &str) -> Result<&'a str, String> {
    value
        .filter(|value| !value.trim().is_empty())
        .map(String::as_str)
        .ok_or_else(|| format!("{label} is required"))
}

#[cfg(windows)]
fn joined(args: &[String], start: usize, label: &str) -> Result<String, String> {
    let value = args.get(start..).unwrap_or_default().join(" ");
    if value.trim().is_empty() {
        Err(format!("{label} is required"))
    } else {
        Ok(value)
    }
}

#[cfg(windows)]
fn usage() -> String {
    "unknown command. Try: status | agents | agent send <id> <message> | agent spawn --project <path> --provider <provider> --task <task> | session list | session resume <id> | browser list | taxchat send <message>".into()
}

#[cfg(windows)]
struct UuidRequestId;

#[cfg(windows)]
impl UuidRequestId {
    fn new() -> String {
        uuid::Uuid::new_v4().to_string()
    }
}
