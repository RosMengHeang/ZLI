#[cfg(windows)]
use serde::Deserialize;
#[cfg(windows)]
use serde_json::{json, Value};
#[cfg(windows)]
use std::path::PathBuf;
#[cfg(windows)]
use swarmterm_lib::control::{
    ControlMethod, ControlRequest, ControlResponse, NamedPipeClient, CONTROL_PROTOCOL_VERSION,
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
        let (body, code) = json_mode_result(&response)?;
        println!("{body}");
        if code != 0 {
            let _ = std::io::Write::flush(&mut std::io::stdout());
            std::process::exit(code);
        }
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
fn json_mode_result(response: &ControlResponse) -> Result<(String, i32), String> {
    let body = serde_json::to_string(response).map_err(|error| error.to_string())?;
    Ok((body, if response.ok { 0 } else { 1 }))
}

#[cfg(windows)]
fn parse_command(args: &[String]) -> Result<(ControlMethod, Value), String> {
    let group = args.first().map(String::as_str);
    let action = args.get(1).map(String::as_str);
    match (group, action) {
        (Some("status"), _) => Ok((ControlMethod::SessionList, json!({}))),
        (Some("health"), _) => {
            let project_id = option(args, "--project")
                .map(str::to_owned)
                .or_else(|| std::env::var("ZLI_PROJECT_ID").ok())
                .filter(|value| !value.trim().is_empty());
            Ok((
                ControlMethod::RuntimeHealth,
                project_id.map_or_else(
                    || json!({}),
                    |project_id| json!({ "projectId": project_id }),
                ),
            ))
        }
        (Some("agents"), _) | (Some("agent"), Some("list")) => {
            Ok((ControlMethod::AgentList, json!({})))
        }
        (Some("agent"), Some("queue")) => {
            let project_id = option(args, "--project")
                .map(str::to_owned)
                .or_else(|| std::env::var("ZLI_PROJECT_ID").ok())
                .filter(|value| !value.trim().is_empty());
            Ok((
                ControlMethod::AgentQueueStatus,
                project_id.map_or_else(|| json!({}), |project_id| json!({ "projectId": project_id })),
            ))
        }
        (Some("attention"), None | Some("list")) => Ok((ControlMethod::AttentionList, json!({}))),
        (Some("attention"), Some("ack")) => {
            let project_id = option(args, "--project")
                .map(str::to_owned)
                .or_else(|| std::env::var("ZLI_PROJECT_ID").ok())
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| {
                    "project is required; pass --project outside a managed agent".to_owned()
                })?;
            let agent_id = required(args.get(2), "agent ID")?;
            Ok((
                ControlMethod::AttentionAck,
                json!({ "projectId": project_id, "agentId": agent_id }),
            ))
        }
        (Some("session"), Some("list")) => Ok((ControlMethod::SessionList, json!({}))),
        (Some("session"), Some("reconcile")) | (Some("doctor"), _) => {
            Ok((ControlMethod::SessionReconcile, json!({})))
        }
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
        (Some("worktree"), Some("audit")) => {
            let project_id = option(args, "--project")
                .map(str::to_owned)
                .or_else(|| std::env::var("ZLI_PROJECT_ID").ok())
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| {
                    "project is required; pass --project outside a managed agent".to_owned()
                })?;
            Ok((
                ControlMethod::WorktreeAudit,
                json!({ "projectId": project_id }),
            ))
        }
        (Some("browser"), Some("list")) => Ok((ControlMethod::BrowserList, json!({}))),
        (Some("browser"), Some("status")) => Ok((ControlMethod::BrowserStatus, json!({}))),
        (Some("browser"), Some("doctor")) => Ok((
            ControlMethod::BrowserStatus,
            option(args, "--agent")
                .map(|agent_id| json!({ "doctor": true, "agentId": agent_id }))
                .unwrap_or_else(|| json!({ "doctor": true })),
        )),
        (Some("browser"), Some(action)) => parse_browser_command(args, action),
        (Some("taxchat"), Some("send")) => {
            let project_id = option(args, "--project")
                .map(str::to_owned)
                .or_else(|| std::env::var("ZLI_PROJECT_ID").ok())
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| {
                    "project is required; pass --project outside a managed agent".to_owned()
                })?;
            let body = positional(args, 2).join(" ");
            if body.trim().is_empty() {
                return Err("message is required".into());
            }
            let recipient_ids = option_values(args, "--to");
            Ok((
                ControlMethod::TaxChatSend,
                json!({ "projectId": project_id, "body": body, "recipientIds": recipient_ids }),
            ))
        }
        _ => Err(usage()),
    }
}

#[cfg(windows)]
fn parse_browser_command(args: &[String], action: &str) -> Result<(ControlMethod, Value), String> {
    let managed_project = std::env::var("ZLI_PROJECT_ID")
        .ok()
        .filter(|value| !value.trim().is_empty());
    match action {
        "open" => {
            let project_id = option(args, "--project")
                .map(str::to_owned)
                .or(managed_project)
                .ok_or_else(|| {
                    "project is required; pass --project outside a managed agent".to_owned()
                })?;
            let url = option(args, "--url")
                .or_else(|| {
                    args.get(2)
                        .filter(|value| !value.starts_with("--"))
                        .map(String::as_str)
                })
                .ok_or_else(|| "URL is required".to_owned())?;
            Ok((
                ControlMethod::BrowserOpen,
                json!({ "projectId": project_id, "url": url }),
            ))
        }
        "navigate" => Ok((
            ControlMethod::BrowserNavigate,
            json!({
                "surfaceId": required(args.get(2), "surface ID")?,
                "url": required(args.get(3), "URL")?,
            }),
        )),
        "snapshot" => {
            let surface_id = required(args.get(2), "surface ID")?;
            let mut params = json!({ "surfaceId": surface_id });
            if let Some(selector) = option(args, "--selector") {
                params["selector"] = Value::String(selector.to_owned());
            }
            if let Some(depth) = option(args, "--depth") {
                params["maxDepth"] = Value::from(positive_integer(depth, "depth")?);
            }
            Ok((ControlMethod::BrowserSnapshot, params))
        }
        "click" => Ok((
            ControlMethod::BrowserClick,
            json!({
                "surfaceId": required(args.get(2), "surface ID")?,
                "selector": option(args, "--selector").or_else(|| args.get(3).map(String::as_str)).ok_or_else(|| "selector is required".to_owned())?,
            }),
        )),
        "fill" => Ok((
            ControlMethod::BrowserFill,
            json!({
                "surfaceId": required(args.get(2), "surface ID")?,
                "selector": option(args, "--selector").or_else(|| args.get(3).map(String::as_str)).ok_or_else(|| "selector is required".to_owned())?,
                "text": option(args, "--text").map(str::to_owned).unwrap_or_else(|| args.get(4..).unwrap_or_default().join(" ")),
            }),
        )),
        "press" => Ok((
            ControlMethod::BrowserPress,
            json!({
                "surfaceId": required(args.get(2), "surface ID")?,
                "key": required(args.get(3), "key")?,
            }),
        )),
        "eval" => Ok((
            ControlMethod::BrowserEval,
            json!({
                "surfaceId": required(args.get(2), "surface ID")?,
                "script": option(args, "--script").map(str::to_owned).unwrap_or(joined(args, 3, "script")?),
            }),
        )),
        "wait" => {
            let surface_id = required(args.get(2), "surface ID")?;
            let condition = if let Some(selector) = option(args, "--selector") {
                json!({ "kind": "selector", "selector": selector, "state": option(args, "--state") })
            } else if let Some(url) = option(args, "--url") {
                json!({ "kind": "url", "url": url })
            } else if let Some(state) = option(args, "--load") {
                json!({ "kind": "load", "state": state })
            } else {
                return Err("wait condition is required".into());
            };
            Ok((
                ControlMethod::BrowserWait,
                json!({
                    "surfaceId": surface_id,
                    "condition": condition,
                    "timeoutMs": positive_integer(option(args, "--timeout").unwrap_or("30000"), "timeout")?,
                }),
            ))
        }
        "console" | "errors" | "screenshot" => {
            let method = match action {
                "console" => ControlMethod::BrowserConsole,
                "errors" => ControlMethod::BrowserErrors,
                _ => ControlMethod::BrowserScreenshot,
            };
            Ok((
                method,
                json!({ "surfaceId": required(args.get(2), "surface ID")? }),
            ))
        }
        _ => Err(usage()),
    }
}

#[cfg(windows)]
fn positive_integer(value: &str, label: &str) -> Result<u64, String> {
    value
        .parse::<u64>()
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| format!("{label} must be a positive integer"))
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
fn option_values(args: &[String], name: &str) -> Vec<String> {
    args.iter()
        .enumerate()
        .filter_map(|(index, value)| {
            (value == name)
                .then(|| args.get(index + 1))
                .flatten()
                .filter(|value| !value.starts_with("--") && !value.trim().is_empty())
                .cloned()
        })
        .collect()
}

#[cfg(windows)]
fn positional(args: &[String], start: usize) -> Vec<String> {
    let mut values = Vec::new();
    let mut index = start;
    while index < args.len() {
        if args[index].starts_with("--") {
            index += 2;
        } else {
            values.push(args[index].clone());
            index += 1;
        }
    }
    values
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
    "unknown command. Try: status | health [--project <path>] | doctor | agents | agent queue [--project <path>] | attention [list] | attention ack <agent> --project <path> | agent send <id> <message> | agent spawn --project <path> --provider <provider> --task <task> | worktree audit --project <path> | session list | session reconcile | session resume <id> | browser status | browser doctor [--agent <agent-id>] | browser list | browser open <url> --project <path> | browser snapshot <surface> | browser click <surface> <selector> | browser fill <surface> <selector> <text> | browser screenshot <surface> | taxchat send <message> --project <path> [--to <agent>]".into()
}

#[cfg(windows)]
struct UuidRequestId;

#[cfg(windows)]
impl UuidRequestId {
    fn new() -> String {
        uuid::Uuid::new_v4().to_string()
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use swarmterm_lib::control::{ControlError, ControlErrorCode};

    #[test]
    fn json_mode_prints_a_failed_envelope_and_exits_nonzero() {
        let response = ControlResponse::failure(
            "req-fail",
            ControlError::new(ControlErrorCode::SessionNotFound, "session missing"),
        );

        let (body, code) = json_mode_result(&response).expect("serialize failed envelope");

        assert_eq!(code, 1);
        let parsed: Value = serde_json::from_str(&body).expect("stdout JSON");
        assert_eq!(parsed["ok"], false);
        assert_eq!(parsed["id"], "req-fail");
        assert_eq!(parsed["error"]["code"], "SESSION_NOT_FOUND");
        assert_eq!(parsed["error"]["message"], "session missing");
    }

    #[test]
    fn json_mode_prints_a_successful_envelope_and_exits_zero() {
        let response = ControlResponse::success("req-ok", json!({ "agents": [] }));

        let (body, code) = json_mode_result(&response).expect("serialize successful envelope");

        assert_eq!(code, 0);
        let parsed: Value = serde_json::from_str(&body).expect("stdout JSON");
        assert_eq!(parsed["ok"], true);
        assert_eq!(parsed["id"], "req-ok");
        assert_eq!(parsed["result"], json!({ "agents": [] }));
    }

    #[test]
    fn taxchat_flags_are_not_included_in_the_message_body() {
        let args = [
            "taxchat",
            "send",
            "Review",
            "the",
            "release",
            "--project",
            r"D:\repo",
            "--to",
            "agent-1",
            "--to",
            "agent-2",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect::<Vec<_>>();

        let (method, params) = parse_command(&args).expect("parse TaxChat command");

        assert_eq!(method, ControlMethod::TaxChatSend);
        assert_eq!(params["projectId"], r"D:\repo");
        assert_eq!(params["body"], "Review the release");
        assert_eq!(params["recipientIds"], json!(["agent-1", "agent-2"]));
    }

    #[test]
    fn attention_ack_is_project_scoped() {
        let args = ["attention", "ack", "agent-1", "--project", r"D:\repo"]
            .into_iter()
            .map(str::to_owned)
            .collect::<Vec<_>>();

        let (method, params) = parse_command(&args).expect("parse attention acknowledgement");

        assert_eq!(method, ControlMethod::AttentionAck);
        assert_eq!(
            params,
            json!({ "projectId": r"D:\repo", "agentId": "agent-1" })
        );
    }

    #[test]
    fn agent_queue_command_is_project_scoped_without_a_message_body() {
        let args = ["agent", "queue", "--project", r"D:\repo"]
            .into_iter()
            .map(str::to_owned)
            .collect::<Vec<_>>();

        let (method, params) = parse_command(&args).expect("parse queue command");

        assert_eq!(method, ControlMethod::AgentQueueStatus);
        assert_eq!(params, json!({ "projectId": r"D:\repo" }));
        assert!(params.get("body").is_none());
    }

    #[test]
    fn worktree_audit_is_project_scoped_and_read_only() {
        let args = ["worktree", "audit", "--project", r"D:\repo"]
            .into_iter()
            .map(str::to_owned)
            .collect::<Vec<_>>();

        let (method, params) = parse_command(&args).expect("parse worktree audit command");

        assert_eq!(method, ControlMethod::WorktreeAudit);
        assert_eq!(params, json!({ "projectId": r"D:\repo" }));
        assert!(params.get("force").is_none());
    }

    #[test]
    fn worktree_audit_requires_a_project_outside_a_managed_agent() {
        let args = ["worktree", "audit"]
            .into_iter()
            .map(str::to_owned)
            .collect::<Vec<_>>();

        let error = parse_command(&args).expect_err("project should be required");
        assert!(error.contains("project"));
    }

    #[test]
    fn browser_status_reports_the_desktop_bridge() {
        let args = ["browser", "status"]
            .into_iter()
            .map(str::to_owned)
            .collect::<Vec<_>>();

        let (method, params) = parse_command(&args).expect("parse browser status");

        assert_eq!(method, ControlMethod::BrowserStatus);
        assert_eq!(params, json!({}));
    }
}
