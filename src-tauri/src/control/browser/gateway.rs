use crate::control::{ControlError, ControlErrorCode, ControlMethod};
use serde_json::Value;

pub const BROWSER_USE_TOOLS: &[&str] = &[
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
];

pub fn tool_names() -> &'static [&'static str] {
    BROWSER_USE_TOOLS
}

pub fn decode_browser_use(params: Value) -> Result<(ControlMethod, Value), ControlError> {
    let tool = params
        .get("tool")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| invalid("browser.use requires a tool"))?;
    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| Value::Object(Default::default()));
    if !arguments.is_object() {
        return Err(invalid("browser.use arguments must be an object"));
    }
    let method = match tool {
        "browser_status" => ControlMethod::BrowserStatus,
        "browser_open" => ControlMethod::BrowserOpen,
        "browser_navigate" => ControlMethod::BrowserNavigate,
        "browser_wait" => ControlMethod::BrowserWait,
        "browser_snapshot" => ControlMethod::BrowserSnapshot,
        "browser_click" => ControlMethod::BrowserClick,
        "browser_fill" => ControlMethod::BrowserFill,
        "browser_press" => ControlMethod::BrowserPress,
        "browser_console" => ControlMethod::BrowserConsole,
        "browser_errors" => ControlMethod::BrowserErrors,
        "browser_screenshot" => ControlMethod::BrowserScreenshot,
        _ => return Err(invalid("browser.use tool is not supported")),
    };
    Ok((method, arguments))
}

fn invalid(message: impl Into<String>) -> ControlError {
    ControlError::new(ControlErrorCode::BrowserInvalidCommand, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn maps_browser_use_tools_to_typed_control_methods() {
        let (method, params) = decode_browser_use(json!({
            "tool": "browser_snapshot",
            "arguments": { "surfaceId": "surface-1" }
        }))
        .expect("browser use tool should decode");

        assert_eq!(method, ControlMethod::BrowserSnapshot);
        assert_eq!(params, json!({ "surfaceId": "surface-1" }));
    }

    #[test]
    fn rejects_unknown_browser_use_tools() {
        let error = decode_browser_use(json!({
            "tool": "shell_exec",
            "arguments": {}
        }))
        .expect_err("non-browser tools must not cross this gateway");

        assert_eq!(error.code, ControlErrorCode::BrowserInvalidCommand);
    }

    #[test]
    fn keeps_javascript_evaluation_out_of_the_provider_gateway() {
        let error = decode_browser_use(json!({
            "tool": "browser_eval",
            "arguments": { "surfaceId": "surface-1", "expression": "document.title" }
        }))
        .expect_err("javascript evaluation requires the elevated direct control method");

        assert_eq!(error.code, ControlErrorCode::BrowserInvalidCommand);
    }
}
