#[cfg(windows)]
use serde::Deserialize;
#[cfg(windows)]
use serde_json::{json, Value};
#[cfg(windows)]
use std::io::{self, BufRead, Write};
#[cfg(windows)]
use std::path::PathBuf;
#[cfg(windows)]
use swarmterm_lib::control::{
    gateway_tools, ControlMethod, ControlRequest, NamedPipeClient, CONTROL_PROTOCOL_VERSION,
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
        eprintln!("zli-browser-use: {error}");
        std::process::exit(1);
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("zli-browser-use: the local control transport currently requires Windows");
    std::process::exit(1);
}

#[cfg(windows)]
fn run() -> Result<(), String> {
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    for line in stdin.lock().lines() {
        let line = line.map_err(|error| error.to_string())?;
        if line.trim().is_empty() {
            continue;
        }
        if let Some(response) = handle_message(&line) {
            serde_json::to_writer(&mut stdout, &response).map_err(|error| error.to_string())?;
            stdout.write_all(b"\n").map_err(|error| error.to_string())?;
            stdout.flush().map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

#[cfg(windows)]
fn handle_message(line: &str) -> Option<Value> {
    let message: Value = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(_) => return Some(json_rpc_error(Value::Null, -32700, "Parse error")),
    };
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    match method {
        "notifications/initialized" => None,
        "initialize" => Some(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "protocolVersion": "2025-06-18",
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "zli-browser-use", "version": env!("CARGO_PKG_VERSION") }
            }
        })),
        "tools/list" => Some(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": { "tools": tools() }
        })),
        "tools/call" => Some(call_tool(
            id,
            message.get("params").cloned().unwrap_or(Value::Null),
        )),
        _ => Some(json_rpc_error(id, -32601, "Method not found")),
    }
}

#[cfg(windows)]
fn tools() -> Vec<Value> {
    gateway_tools()
        .into_iter()
        .map(|name| {
            json!({
                "name": name,
                "description": "Use the ZLI built-in browser surface.",
                "inputSchema": { "type": "object", "additionalProperties": true }
            })
        })
        .collect()
}

#[cfg(windows)]
fn call_tool(id: Value, params: Value) -> Value {
    let Some(params) = params.as_object() else {
        return json_rpc_error(id, -32602, "tools/call params must be an object");
    };
    let Some(name) = params.get("name").and_then(Value::as_str) else {
        return json_rpc_error(id, -32602, "tools/call requires a tool name");
    };
    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let request_params = json!({ "tool": name, "arguments": arguments });
    let request = match ControlRequest::new(
        uuid::Uuid::new_v4().to_string(),
        ControlMethod::BrowserUse,
        request_params,
        30_000,
    ) {
        Ok(request) => request,
        Err(error) => return tool_error(id, error.to_string()),
    };
    let connection = match connection_info() {
        Ok(connection) => connection,
        Err(error) => return tool_error(id, error),
    };
    if connection.protocol_version != CONTROL_PROTOCOL_VERSION {
        return tool_error(
            id,
            "the running ZLI app uses an incompatible control protocol".into(),
        );
    }
    let response =
        match NamedPipeClient::new(connection.endpoint, connection.token).request(request) {
            Ok(response) => response,
            Err(error) => {
                return tool_error(id, format!("could not reach the running ZLI app: {error}"))
            }
        };
    if response.ok {
        let value = response.result.unwrap_or(Value::Null);
        json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": { "content": [{ "type": "text", "text": serde_json::to_string_pretty(&value).unwrap_or_else(|_| value.to_string()) }] }
        })
    } else {
        let message = response
            .error
            .map(|error| format!("{}: {}", error.code, error.message))
            .unwrap_or_else(|| "browser request failed".into());
        tool_error(id, message)
    }
}

#[cfg(windows)]
fn tool_error(id: Value, message: String) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": { "isError": true, "content": [{ "type": "text", "text": message }] }
    })
}

#[cfg(windows)]
fn json_rpc_error(id: Value, code: i32, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
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
