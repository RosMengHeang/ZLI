use crate::control::{ControlError, ControlErrorCode, CONTROL_PROTOCOL_VERSION};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const BROWSER_PROTOCOL_VERSION: u16 = CONTROL_PROTOCOL_VERSION;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Hash, Serialize)]
pub enum BrowserCapability {
    #[serde(rename = "browser.read")]
    Read,
    #[serde(rename = "browser.control")]
    Control,
    #[serde(rename = "browser.javascript")]
    Javascript,
    #[serde(rename = "browser.storage")]
    Storage,
    #[serde(rename = "browser.download")]
    Download,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BrowserLimits {
    pub max_snapshot_characters: usize,
    pub max_script_characters: usize,
    pub max_snapshot_depth: u16,
    pub max_selector_characters: usize,
    pub max_fill_characters: usize,
    pub max_console_entries: usize,
    pub max_page_errors: usize,
    pub max_screenshot_characters: usize,
    pub min_command_timeout_ms: u64,
    pub max_command_timeout_ms: u64,
}

pub const BROWSER_LIMITS: BrowserLimits = BrowserLimits {
    max_snapshot_characters: 100_000,
    max_script_characters: 20_000,
    max_snapshot_depth: 32,
    max_selector_characters: 4_096,
    max_fill_characters: 100_000,
    max_console_entries: 500,
    max_page_errors: 200,
    max_screenshot_characters: 10_000_000,
    min_command_timeout_ms: 100,
    max_command_timeout_ms: 120_000,
};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub enum BrowserKey {
    Enter,
    Tab,
    Escape,
    Backspace,
    Delete,
    Space,
    ArrowUp,
    ArrowDown,
    ArrowLeft,
    ArrowRight,
    Home,
    End,
    PageUp,
    PageDown,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SelectorState {
    Attached,
    Visible,
    Hidden,
    Detached,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LoadState {
    DomContentLoaded,
    Load,
    NetworkIdle,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum BrowserWaitCondition {
    Selector {
        selector: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        state: Option<SelectorState>,
    },
    Url {
        url: String,
    },
    Load {
        state: LoadState,
    },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum BrowserCommand {
    Open {
        url: String,
    },
    Navigate {
        surface_id: String,
        url: String,
    },
    Wait {
        surface_id: String,
        condition: BrowserWaitCondition,
        timeout_ms: u64,
    },
    Snapshot {
        surface_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        selector: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_depth: Option<u16>,
    },
    Click {
        surface_id: String,
        selector: String,
    },
    Fill {
        surface_id: String,
        selector: String,
        text: String,
    },
    Press {
        surface_id: String,
        key: BrowserKey,
    },
    Eval {
        surface_id: String,
        script: String,
    },
    Console {
        surface_id: String,
    },
    Errors {
        surface_id: String,
    },
    Screenshot {
        surface_id: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BrowserCommandKind {
    Open,
    Navigate,
    Wait,
    Snapshot,
    Click,
    Fill,
    Press,
    Eval,
    Console,
    Errors,
    Screenshot,
}

impl BrowserCommand {
    pub fn kind(&self) -> BrowserCommandKind {
        match self {
            Self::Open { .. } => BrowserCommandKind::Open,
            Self::Navigate { .. } => BrowserCommandKind::Navigate,
            Self::Wait { .. } => BrowserCommandKind::Wait,
            Self::Snapshot { .. } => BrowserCommandKind::Snapshot,
            Self::Click { .. } => BrowserCommandKind::Click,
            Self::Fill { .. } => BrowserCommandKind::Fill,
            Self::Press { .. } => BrowserCommandKind::Press,
            Self::Eval { .. } => BrowserCommandKind::Eval,
            Self::Console { .. } => BrowserCommandKind::Console,
            Self::Errors { .. } => BrowserCommandKind::Errors,
            Self::Screenshot { .. } => BrowserCommandKind::Screenshot,
        }
    }

    pub fn surface_id(&self) -> Option<&str> {
        match self {
            Self::Open { .. } => None,
            Self::Navigate { surface_id, .. }
            | Self::Wait { surface_id, .. }
            | Self::Snapshot { surface_id, .. }
            | Self::Click { surface_id, .. }
            | Self::Fill { surface_id, .. }
            | Self::Press { surface_id, .. }
            | Self::Eval { surface_id, .. }
            | Self::Console { surface_id }
            | Self::Errors { surface_id }
            | Self::Screenshot { surface_id } => Some(surface_id),
        }
    }

    pub fn decode(value: Value) -> Result<Self, ControlError> {
        let command: Self = serde_json::from_value(value)
            .map_err(|error| invalid(format!("Invalid browser command: {error}")))?;
        command.validate()?;
        Ok(command)
    }

    pub fn validate(&self) -> Result<(), ControlError> {
        match self {
            Self::Open { url } => validate_url(url),
            Self::Navigate { surface_id, url } => {
                validate_id(surface_id)?;
                validate_url(url)
            }
            Self::Wait {
                surface_id,
                condition,
                timeout_ms,
            } => {
                validate_id(surface_id)?;
                condition.validate()?;
                if !(BROWSER_LIMITS.min_command_timeout_ms..=BROWSER_LIMITS.max_command_timeout_ms)
                    .contains(timeout_ms)
                {
                    return Err(invalid("timeoutMs is outside the supported range"));
                }
                Ok(())
            }
            Self::Snapshot {
                surface_id,
                selector,
                max_depth,
            } => {
                validate_id(surface_id)?;
                if let Some(selector) = selector {
                    validate_selector(selector)?;
                }
                if max_depth
                    .is_some_and(|depth| depth == 0 || depth > BROWSER_LIMITS.max_snapshot_depth)
                {
                    return Err(invalid("maxDepth is outside the supported range"));
                }
                Ok(())
            }
            Self::Click {
                surface_id,
                selector,
            } => {
                validate_id(surface_id)?;
                validate_selector(selector)
            }
            Self::Fill {
                surface_id,
                selector,
                text,
            } => {
                validate_id(surface_id)?;
                validate_selector(selector)?;
                validate_length(text, BROWSER_LIMITS.max_fill_characters, "text")
            }
            Self::Press { surface_id, .. }
            | Self::Console { surface_id }
            | Self::Errors { surface_id }
            | Self::Screenshot { surface_id } => validate_id(surface_id),
            Self::Eval { surface_id, script } => {
                validate_id(surface_id)?;
                if script.trim().is_empty() {
                    return Err(invalid("script must be a nonempty string"));
                }
                validate_length(script, BROWSER_LIMITS.max_script_characters, "script")
            }
        }
    }
}

impl BrowserWaitCondition {
    fn validate(&self) -> Result<(), ControlError> {
        match self {
            Self::Selector { selector, .. } => validate_selector(selector),
            Self::Url { url } => validate_url(url),
            Self::Load { .. } => Ok(()),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConsoleLevel {
    Debug,
    Info,
    Warn,
    Error,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserConsoleEntry {
    pub level: ConsoleLevel,
    pub message: String,
    pub timestamp: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPageError {
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column: Option<u32>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NavigationPhase {
    Started,
    Finished,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum BrowserResult {
    Surface {
        surface_id: String,
        project_id: String,
        agent_id: Option<String>,
        url: String,
        profile_id: String,
    },
    Navigation {
        surface_id: String,
        url: String,
        phase: NavigationPhase,
    },
    Snapshot {
        surface_id: String,
        content: String,
        truncated: bool,
    },
    ConsoleEntries {
        surface_id: String,
        entries: Vec<BrowserConsoleEntry>,
        truncated: bool,
    },
    PageErrors {
        surface_id: String,
        errors: Vec<BrowserPageError>,
        truncated: bool,
    },
    Screenshot {
        surface_id: String,
        data_url: String,
        width: u32,
        height: u32,
    },
}

fn validate_id(value: &str) -> Result<(), ControlError> {
    if value.trim().is_empty() {
        return Err(invalid("surfaceId must be a nonempty string"));
    }
    Ok(())
}

fn validate_selector(value: &str) -> Result<(), ControlError> {
    if value.trim().is_empty() {
        return Err(invalid("selector must be a nonempty string"));
    }
    validate_length(value, BROWSER_LIMITS.max_selector_characters, "selector")
}

fn validate_length(value: &str, maximum: usize, field: &str) -> Result<(), ControlError> {
    if value.chars().count() > maximum {
        return Err(invalid(format!("{field} exceeds {maximum} characters")));
    }
    Ok(())
}

fn validate_url(value: &str) -> Result<(), ControlError> {
    if value == "about:blank" {
        return Ok(());
    }
    let lower = value.to_ascii_lowercase();
    let scheme_length = if lower.starts_with("http://") {
        7
    } else if lower.starts_with("https://") {
        8
    } else {
        return Err(invalid("url must use http, https, or about:blank"));
    };
    let remainder = value
        .get(scheme_length..)
        .ok_or_else(|| invalid("url must use http, https, or about:blank"))?;
    let authority = remainder.split(['/', '?', '#']).next().unwrap_or_default();
    if authority.is_empty()
        || authority.contains('@')
        || value
            .chars()
            .any(|character| character.is_whitespace() || character.is_control())
        || value.contains('\\')
        || !valid_authority(authority)
    {
        return Err(invalid("url must be an absolute http or https URL"));
    }
    Ok(())
}

fn valid_authority(authority: &str) -> bool {
    if let Some(host_and_port) = authority.strip_prefix('[') {
        let Some(closing) = host_and_port.find(']') else {
            return false;
        };
        let host = &host_and_port[..closing];
        let suffix = &host_and_port[closing + 1..];
        return !host.is_empty()
            && (suffix.is_empty() || suffix.strip_prefix(':').is_some_and(valid_port));
    }

    if authority.matches(':').count() > 1 {
        return false;
    }
    let (host, port) = authority
        .rsplit_once(':')
        .map_or((authority, None), |(host, port)| (host, Some(port)));
    !host.is_empty() && !host.contains(['[', ']']) && port.is_none_or(valid_port)
}

fn valid_port(port: &str) -> bool {
    !port.is_empty()
        && port.bytes().all(|byte| byte.is_ascii_digit())
        && port.parse::<u16>().is_ok()
}

fn invalid(message: impl Into<String>) -> ControlError {
    ControlError::new(ControlErrorCode::BrowserInvalidCommand, message)
}
