use super::browser::catalog;
use serde_json::{json, Value};

pub const SUPPORTED_MCP_PROTOCOL_VERSIONS: &[&str] = &["2024-11-05", "2025-03-26", "2025-06-18"];
pub const DEFAULT_MCP_PROTOCOL_VERSION: &str = "2025-06-18";

#[derive(Clone, Debug, PartialEq)]
pub enum Incoming {
    Request {
        id: Value,
        method: String,
        params: Value,
    },
    Notification {
        method: String,
        params: Value,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum McpParseError {
    MissingMethod,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Dispatch {
    Silent,
    Reply(Value),
    Call {
        id: Value,
        name: String,
        arguments: Value,
    },
}

pub fn parse_incoming(value: Value) -> Result<Incoming, McpParseError> {
    let method = value
        .get("method")
        .and_then(Value::as_str)
        .ok_or(McpParseError::MissingMethod)?
        .to_owned();
    let params = value.get("params").cloned().unwrap_or(Value::Null);
    match value.get("id") {
        Some(id) => Ok(Incoming::Request {
            id: id.clone(),
            method,
            params,
        }),
        None => Ok(Incoming::Notification { method, params }),
    }
}

pub fn negotiate_version(client: &str) -> &'static str {
    SUPPORTED_MCP_PROTOCOL_VERSIONS
        .iter()
        .copied()
        .find(|version| *version == client)
        .unwrap_or(DEFAULT_MCP_PROTOCOL_VERSION)
}

pub fn handle(incoming: Incoming) -> Option<Value> {
    match dispatch(incoming) {
        Dispatch::Silent | Dispatch::Call { .. } => None,
        Dispatch::Reply(value) => Some(value),
    }
}

pub fn dispatch(incoming: Incoming) -> Dispatch {
    match incoming {
        Incoming::Notification { .. } => Dispatch::Silent,
        Incoming::Request { id, method, params } => match method.as_str() {
            "initialize" => Dispatch::Reply(initialize_result(id, params)),
            "tools/list" => Dispatch::Reply(tools_list_result(id)),
            "tools/call" => tools_call(id, params),
            _ => Dispatch::Reply(json_rpc_error(id, -32601, "Method not found")),
        },
    }
}

fn tools_call(id: Value, params: Value) -> Dispatch {
    let Some(object) = params.as_object() else {
        return Dispatch::Reply(json_rpc_error(
            id,
            -32602,
            "tools/call params must be an object",
        ));
    };
    let Some(name) = object.get("name").and_then(Value::as_str) else {
        return Dispatch::Reply(json_rpc_error(
            id,
            -32602,
            "tools/call requires a tool name",
        ));
    };
    let arguments = object
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    match catalog::decode_tool(name, &arguments) {
        Ok(_) => Dispatch::Call {
            id,
            name: name.to_owned(),
            arguments,
        },
        Err(error) => Dispatch::Reply(tool_error(id, error.to_string())),
    }
}

fn initialize_result(id: Value, params: Value) -> Value {
    let client = params
        .get("protocolVersion")
        .and_then(Value::as_str)
        .unwrap_or("");
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": {
            "protocolVersion": negotiate_version(client),
            "capabilities": { "tools": { "listChanged": false } },
            "serverInfo": {
                "name": "zli-browser-use",
                "version": env!("CARGO_PKG_VERSION")
            }
        }
    })
}

fn tools_list_result(id: Value) -> Value {
    let tools: Vec<Value> = catalog::catalog()
        .iter()
        .map(|tool| {
            json!({
                "name": tool.name,
                "description": tool.description,
                "inputSchema": (tool.schema)()
            })
        })
        .collect();
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": { "tools": tools }
    })
}

fn tool_error(id: Value, message: String) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": {
            "isError": true,
            "content": [{ "type": "text", "text": message }]
        }
    })
}

pub fn json_rpc_error(id: Value, code: i32, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn negotiate_version_echoes_supported_and_defaults_unknown() {
        assert_eq!(negotiate_version("2025-03-26"), "2025-03-26");
        assert_eq!(negotiate_version("2024-11-05"), "2024-11-05");
        assert_eq!(negotiate_version("not-a-version"), DEFAULT_MCP_PROTOCOL_VERSION);
    }

    #[test]
    fn initialized_notification_is_silent() {
        let incoming = parse_incoming(json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
            "params": {}
        }))
        .expect("parse");
        assert!(matches!(incoming, Incoming::Notification { .. }));
        assert_eq!(handle(incoming), None);
    }

    #[test]
    fn initialize_negotiates_and_tools_list_uses_typed_schemas() {
        let incoming = parse_incoming(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": { "protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": { "name": "test", "version": "0" } }
        }))
        .expect("parse");
        let reply = handle(incoming).expect("initialize reply");
        assert_eq!(reply["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(reply["result"]["capabilities"]["tools"]["listChanged"], false);
        assert_eq!(reply["result"]["serverInfo"]["name"], "zli-browser-use");

        let list = handle(Incoming::Request {
            id: json!(2),
            method: "tools/list".into(),
            params: json!({}),
        })
        .expect("tools/list");
        let tools = list["result"]["tools"].as_array().expect("tools");
        assert!(!tools.is_empty());
        for tool in tools {
            assert_eq!(tool["inputSchema"]["additionalProperties"], false);
            assert!(tool["inputSchema"]["required"].is_array());
            assert_ne!(tool["name"], "browser_eval");
        }
    }

    #[test]
    fn tools_call_with_extra_properties_is_a_tool_error() {
        let dispatch = dispatch(Incoming::Request {
            id: json!(3),
            method: "tools/call".into(),
            params: json!({
                "name": "browser_click",
                "arguments": { "surfaceId": "s", "selector": "#x", "extra": 1 }
            }),
        });
        let Dispatch::Reply(reply) = dispatch else {
            panic!("extra fields must not dispatch a call");
        };
        assert_eq!(reply["result"]["isError"], true);
    }
}
