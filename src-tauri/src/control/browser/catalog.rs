use super::commands::{
    BrowserCommand, BrowserKey, LoadState, SelectorState, BROWSER_LIMITS,
};
use crate::control::{ControlError, ControlErrorCode, ControlMethod};
use serde::Serialize;
use serde_json::{json, Map, Value};

pub struct BrowserToolSpec {
    pub name: &'static str,
    pub description: &'static str,
    pub control_method: ControlMethod,
    pub schema: fn() -> Value,
    pub to_command: fn(&Value) -> Result<Option<BrowserCommand>, ControlError>,
}

pub fn catalog() -> &'static [BrowserToolSpec] {
    &TOOLS
}

pub fn tool_names() -> Vec<&'static str> {
    catalog().iter().map(|tool| tool.name).collect()
}

pub fn input_schema(name: &str) -> Option<Value> {
    catalog()
        .iter()
        .find(|tool| tool.name == name)
        .map(|tool| (tool.schema)())
}

pub fn decode_tool(name: &str, arguments: &Value) -> Result<(ControlMethod, Value), ControlError> {
    let spec = catalog()
        .iter()
        .find(|tool| tool.name == name)
        .ok_or_else(|| invalid("browser.use tool is not supported"))?;
    let _ = (spec.to_command)(arguments)?;
    Ok((spec.control_method, arguments.clone()))
}

const PANE: &str = "ZLI built-in browser pane";

const TOOLS: &[BrowserToolSpec] = &[
    BrowserToolSpec {
        name: "browser_status",
        description: "Report whether the ZLI built-in browser pane is enabled for this profile.",
        control_method: ControlMethod::BrowserStatus,
        schema: schema_status,
        to_command: command_status,
    },
    BrowserToolSpec {
        name: "browser_open",
        description: "Open a URL in a new ZLI built-in browser pane.",
        control_method: ControlMethod::BrowserOpen,
        schema: schema_open,
        to_command: command_open,
    },
    BrowserToolSpec {
        name: "browser_navigate",
        description: "Navigate an existing ZLI built-in browser pane to a URL.",
        control_method: ControlMethod::BrowserNavigate,
        schema: schema_navigate,
        to_command: command_navigate,
    },
    BrowserToolSpec {
        name: "browser_wait",
        description: "Wait until a selector, URL, or load state matches in the ZLI built-in browser pane.",
        control_method: ControlMethod::BrowserWait,
        schema: schema_wait,
        to_command: command_wait,
    },
    BrowserToolSpec {
        name: "browser_snapshot",
        description: "Read a bounded DOM snapshot from the ZLI built-in browser pane.",
        control_method: ControlMethod::BrowserSnapshot,
        schema: schema_snapshot,
        to_command: command_snapshot,
    },
    BrowserToolSpec {
        name: "browser_click",
        description: "Click a selector in the ZLI built-in browser pane.",
        control_method: ControlMethod::BrowserClick,
        schema: schema_click,
        to_command: command_click,
    },
    BrowserToolSpec {
        name: "browser_fill",
        description: "Fill a selector in the ZLI built-in browser pane.",
        control_method: ControlMethod::BrowserFill,
        schema: schema_fill,
        to_command: command_fill,
    },
    BrowserToolSpec {
        name: "browser_press",
        description: "Press a supported key in the ZLI built-in browser pane.",
        control_method: ControlMethod::BrowserPress,
        schema: schema_press,
        to_command: command_press,
    },
    BrowserToolSpec {
        name: "browser_console",
        description: "Read captured console messages from the ZLI built-in browser pane.",
        control_method: ControlMethod::BrowserConsole,
        schema: schema_surface_only,
        to_command: command_console,
    },
    BrowserToolSpec {
        name: "browser_errors",
        description: "Read captured page errors from the ZLI built-in browser pane.",
        control_method: ControlMethod::BrowserErrors,
        schema: schema_surface_only,
        to_command: command_errors,
    },
    BrowserToolSpec {
        name: "browser_screenshot",
        description: "Capture a screenshot of the ZLI built-in browser pane.",
        control_method: ControlMethod::BrowserScreenshot,
        schema: schema_surface_only,
        to_command: command_screenshot,
    },
];

fn schema_status() -> Value {
    object(
        &format!("No arguments. Reports {PANE} control status."),
        Map::new(),
        &[],
    )
}

fn schema_open() -> Value {
    object(
        &format!("Open an http(s) URL or about:blank in a new {PANE}."),
        properties(&[("url", url_property())]),
        &["url"],
    )
}

fn schema_navigate() -> Value {
    object(
        &format!("Navigate an existing {PANE} to an http(s) URL or about:blank."),
        properties(&[("surfaceId", surface_id_property()), ("url", url_property())]),
        &["surfaceId", "url"],
    )
}

fn schema_wait() -> Value {
    object(
        &format!(
            "Wait on the {PANE}. timeoutMs is {min}..{max}.",
            min = BROWSER_LIMITS.min_command_timeout_ms,
            max = BROWSER_LIMITS.max_command_timeout_ms
        ),
        properties(&[
            ("surfaceId", surface_id_property()),
            ("condition", wait_condition_property()),
            ("timeoutMs", timeout_property()),
        ]),
        &["surfaceId", "condition", "timeoutMs"],
    )
}

fn schema_snapshot() -> Value {
    object(
        &format!(
            "Snapshot the {PANE}. selector max {sel} characters. maxDepth 1..{depth}.",
            sel = BROWSER_LIMITS.max_selector_characters,
            depth = BROWSER_LIMITS.max_snapshot_depth
        ),
        properties(&[
            ("surfaceId", surface_id_property()),
            ("selector", selector_property()),
            ("maxDepth", max_depth_property()),
        ]),
        &["surfaceId"],
    )
}

fn schema_click() -> Value {
    object(
        &format!("Click a selector in the {PANE}."),
        properties(&[
            ("surfaceId", surface_id_property()),
            ("selector", selector_property()),
        ]),
        &["surfaceId", "selector"],
    )
}

fn schema_fill() -> Value {
    object(
        &format!(
            "Fill a selector in the {PANE}. text max {max} characters.",
            max = BROWSER_LIMITS.max_fill_characters
        ),
        properties(&[
            ("surfaceId", surface_id_property()),
            ("selector", selector_property()),
            ("text", text_property()),
        ]),
        &["surfaceId", "selector", "text"],
    )
}

fn schema_press() -> Value {
    object(
        &format!("Press a supported key in the {PANE}."),
        properties(&[
            ("surfaceId", surface_id_property()),
            ("key", key_property()),
        ]),
        &["surfaceId", "key"],
    )
}

fn schema_surface_only() -> Value {
    object(
        &format!("Target an existing {PANE} by surfaceId."),
        properties(&[("surfaceId", surface_id_property())]),
        &["surfaceId"],
    )
}

fn command_status(arguments: &Value) -> Result<Option<BrowserCommand>, ControlError> {
    let object = object_args(arguments)?;
    if !object.is_empty() {
        return Err(invalid("browser_status does not accept arguments"));
    }
    Ok(None)
}

fn command_open(arguments: &Value) -> Result<Option<BrowserCommand>, ControlError> {
    decode_kind(arguments, "open")
}

fn command_navigate(arguments: &Value) -> Result<Option<BrowserCommand>, ControlError> {
    decode_kind(arguments, "navigate")
}

fn command_wait(arguments: &Value) -> Result<Option<BrowserCommand>, ControlError> {
    decode_kind(arguments, "wait")
}

fn command_snapshot(arguments: &Value) -> Result<Option<BrowserCommand>, ControlError> {
    decode_kind(arguments, "snapshot")
}

fn command_click(arguments: &Value) -> Result<Option<BrowserCommand>, ControlError> {
    decode_kind(arguments, "click")
}

fn command_fill(arguments: &Value) -> Result<Option<BrowserCommand>, ControlError> {
    decode_kind(arguments, "fill")
}

fn command_press(arguments: &Value) -> Result<Option<BrowserCommand>, ControlError> {
    decode_kind(arguments, "press")
}

fn command_console(arguments: &Value) -> Result<Option<BrowserCommand>, ControlError> {
    decode_kind(arguments, "console")
}

fn command_errors(arguments: &Value) -> Result<Option<BrowserCommand>, ControlError> {
    decode_kind(arguments, "errors")
}

fn command_screenshot(arguments: &Value) -> Result<Option<BrowserCommand>, ControlError> {
    decode_kind(arguments, "screenshot")
}

fn decode_kind(arguments: &Value, kind: &str) -> Result<Option<BrowserCommand>, ControlError> {
    let mut object = object_args(arguments)?.clone();
    object.insert("kind".into(), Value::String(kind.into()));
    Ok(Some(BrowserCommand::decode(Value::Object(object))?))
}

fn object_args(arguments: &Value) -> Result<&Map<String, Value>, ControlError> {
    arguments
        .as_object()
        .ok_or_else(|| invalid("browser.use arguments must be an object"))
}

fn object(description: &str, properties: Map<String, Value>, required: &[&str]) -> Value {
    json!({
        "type": "object",
        "description": description,
        "additionalProperties": false,
        "properties": properties,
        "required": required,
    })
}

fn properties(fields: &[(&str, Value)]) -> Map<String, Value> {
    fields
        .iter()
        .map(|(name, value)| ((*name).to_owned(), value.clone()))
        .collect()
}

fn surface_id_property() -> Value {
    json!({
        "type": "string",
        "minLength": 1,
        "description": "Identifier of an existing ZLI browser surface.",
    })
}

fn url_property() -> Value {
    json!({
        "type": "string",
        "minLength": 1,
        "description": "Absolute http or https URL, or about:blank.",
    })
}

fn selector_property() -> Value {
    json!({
        "type": "string",
        "minLength": 1,
        "maxLength": BROWSER_LIMITS.max_selector_characters,
        "description": format!(
            "CSS selector, at most {} characters.",
            BROWSER_LIMITS.max_selector_characters
        ),
    })
}

fn text_property() -> Value {
    json!({
        "type": "string",
        "maxLength": BROWSER_LIMITS.max_fill_characters,
        "description": format!(
            "Replacement text, at most {} characters.",
            BROWSER_LIMITS.max_fill_characters
        ),
    })
}

fn timeout_property() -> Value {
    json!({
        "type": "integer",
        "minimum": BROWSER_LIMITS.min_command_timeout_ms,
        "maximum": BROWSER_LIMITS.max_command_timeout_ms,
        "description": format!(
            "Wait budget in milliseconds, {min} to {max}.",
            min = BROWSER_LIMITS.min_command_timeout_ms,
            max = BROWSER_LIMITS.max_command_timeout_ms
        ),
    })
}

fn max_depth_property() -> Value {
    json!({
        "type": "integer",
        "minimum": 1,
        "maximum": BROWSER_LIMITS.max_snapshot_depth,
        "description": format!(
            "Snapshot depth, 1 to {}.",
            BROWSER_LIMITS.max_snapshot_depth
        ),
    })
}

fn key_property() -> Value {
    json!({
        "type": "string",
        "enum": browser_key_values(),
        "description": "Supported keyboard key. Names match BrowserKey.",
    })
}

fn wait_condition_property() -> Value {
    json!({
        "description": "Wait until a selector, URL, or load state matches.",
        "oneOf": [
            {
                "type": "object",
                "additionalProperties": false,
                "required": ["kind", "selector"],
                "properties": {
                    "kind": { "const": "selector" },
                    "selector": selector_property(),
                    "state": {
                        "type": "string",
                        "enum": enum_values(&[
                            SelectorState::Attached,
                            SelectorState::Visible,
                            SelectorState::Hidden,
                            SelectorState::Detached,
                        ]),
                    }
                }
            },
            {
                "type": "object",
                "additionalProperties": false,
                "required": ["kind", "url"],
                "properties": {
                    "kind": { "const": "url" },
                    "url": url_property()
                }
            },
            {
                "type": "object",
                "additionalProperties": false,
                "required": ["kind", "state"],
                "properties": {
                    "kind": { "const": "load" },
                    "state": {
                        "type": "string",
                        "enum": enum_values(&[
                            LoadState::DomContentLoaded,
                            LoadState::Load,
                            LoadState::NetworkIdle,
                        ]),
                    }
                }
            }
        ]
    })
}

fn browser_key_values() -> Vec<Value> {
    enum_values(&all_browser_keys())
}

fn all_browser_keys() -> [BrowserKey; 14] {
    exhaust_browser_key(BrowserKey::Enter);
    [
        BrowserKey::Enter,
        BrowserKey::Tab,
        BrowserKey::Escape,
        BrowserKey::Backspace,
        BrowserKey::Delete,
        BrowserKey::Space,
        BrowserKey::ArrowUp,
        BrowserKey::ArrowDown,
        BrowserKey::ArrowLeft,
        BrowserKey::ArrowRight,
        BrowserKey::Home,
        BrowserKey::End,
        BrowserKey::PageUp,
        BrowserKey::PageDown,
    ]
}

fn exhaust_browser_key(key: BrowserKey) {
    match key {
        BrowserKey::Enter
        | BrowserKey::Tab
        | BrowserKey::Escape
        | BrowserKey::Backspace
        | BrowserKey::Delete
        | BrowserKey::Space
        | BrowserKey::ArrowUp
        | BrowserKey::ArrowDown
        | BrowserKey::ArrowLeft
        | BrowserKey::ArrowRight
        | BrowserKey::Home
        | BrowserKey::End
        | BrowserKey::PageUp
        | BrowserKey::PageDown => {}
    }
}

fn enum_values<T: Serialize>(values: &[T]) -> Vec<Value> {
    values
        .iter()
        .map(|value| serde_json::to_value(value).expect("enum serializes"))
        .collect()
}

fn invalid(message: impl Into<String>) -> ControlError {
    ControlError::new(ControlErrorCode::BrowserInvalidCommand, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn catalog_names_match_the_former_gateway_list() {
        assert_eq!(
            tool_names(),
            vec![
                "browser_status",
                "browser_open",
                "browser_navigate",
                "browser_wait",
                "browser_snapshot",
                "browser_click",
                "browser_fill",
                "browser_press",
                "browser_console",
                "browser_errors",
                "browser_screenshot",
            ]
        );
        assert!(input_schema("browser_eval").is_none());
    }

    #[test]
    fn mcp_schemas_lock_required_fields_and_reject_extras() {
        for name in tool_names() {
            let schema = input_schema(name).expect("schema");
            assert_eq!(schema["type"], "object");
            assert_eq!(schema["additionalProperties"], false, "{name}");
            assert!(schema["description"].as_str().unwrap().contains("ZLI"));
        }

        let open = input_schema("browser_open").unwrap();
        assert_eq!(open["required"], json!(["url"]));
        let navigate = input_schema("browser_navigate").unwrap();
        assert_eq!(navigate["required"], json!(["surfaceId", "url"]));
        let click = input_schema("browser_click").unwrap();
        assert_eq!(click["required"], json!(["surfaceId", "selector"]));
        let fill = input_schema("browser_fill").unwrap();
        assert_eq!(fill["required"], json!(["surfaceId", "selector", "text"]));
        let press = input_schema("browser_press").unwrap();
        assert_eq!(press["required"], json!(["surfaceId", "key"]));
        assert_eq!(
            press["properties"]["key"]["enum"],
            json!(browser_key_values())
        );
        assert_eq!(
            click["properties"]["selector"]["maxLength"],
            BROWSER_LIMITS.max_selector_characters
        );
        let wait = input_schema("browser_wait").unwrap();
        assert_eq!(
            wait["required"],
            json!(["surfaceId", "condition", "timeoutMs"])
        );
        assert_eq!(
            wait["properties"]["timeoutMs"]["minimum"],
            BROWSER_LIMITS.min_command_timeout_ms
        );
        assert_eq!(
            wait["properties"]["timeoutMs"]["maximum"],
            BROWSER_LIMITS.max_command_timeout_ms
        );
    }

    #[test]
    fn extra_properties_fail_browser_command_decode() {
        let error = decode_tool(
            "browser_click",
            &json!({
                "surfaceId": "surface-1",
                "selector": "#go",
                "bonus": true
            }),
        )
        .expect_err("extra properties");
        assert_eq!(error.code, ControlErrorCode::BrowserInvalidCommand);

        decode_tool(
            "browser_status",
            &json!({ "unexpected": true }),
        )
        .expect_err("status rejects extras");

        let (method, params) = decode_tool(
            "browser_open",
            &json!({ "url": "https://example.com" }),
        )
        .expect("open");
        assert_eq!(method, ControlMethod::BrowserOpen);
        assert_eq!(params, json!({ "url": "https://example.com" }));
    }

    #[test]
    fn press_schema_enum_round_trips_every_browser_key() {
        for key in all_browser_keys() {
            let value = serde_json::to_value(key).unwrap();
            BrowserCommand::decode(json!({
                "kind": "press",
                "surfaceId": "surface-1",
                "key": value
            }))
            .expect("key must decode");
        }
    }
}
