use super::commands::{
    BrowserAction, BrowserCommand, BrowserKey, BrowserResult, BrowserWaitCondition, LoadState,
    SelectorState,
};
use crate::control::{ControlError, ControlErrorCode};
use serde_json::{json, Value};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

pub trait BrowserExecutor: Send + Sync {
    fn request_open(
        &self,
        request_id: &str,
        project_id: &str,
        url: &str,
    ) -> Result<(), ControlError>;

    fn execute(
        &self,
        webview_label: &str,
        command: &BrowserCommand,
        timeout: Duration,
    ) -> Result<BrowserResult, ControlError>;
}

#[derive(Clone)]
pub struct TauriBrowserExecutor {
    app: AppHandle,
}

impl TauriBrowserExecutor {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }

    pub fn initialize(&self, webview_label: &str) -> Result<(), ControlError> {
        let webview = self.webview(webview_label)?;
        webview.eval(instrumentation_script()).map_err(|error| {
            runtime(format!(
                "Could not initialize browser instrumentation: {error}"
            ))
        })
    }

    fn webview(&self, label: &str) -> Result<tauri::Webview, ControlError> {
        self.app.get_webview(label).ok_or_else(|| {
            ControlError::new(
                ControlErrorCode::BrowserSurfaceNotFound,
                "Browser webview was not found",
            )
        })
    }

    fn evaluate(
        &self,
        label: &str,
        expression: &str,
        timeout: Duration,
    ) -> Result<Value, ControlError> {
        let webview = self.webview(label)?;
        let script = format!(
            "(() => {{ try {{ {} return {{ ok: true, value: ({expression}) }}; }} catch (error) {{ return {{ ok: false, error: String(error?.message ?? error) }}; }} }})()",
            instrumentation_script()
        );
        let (sender, receiver) = mpsc::sync_channel(1);
        webview
            .eval_with_callback(script, move |raw| {
                let _ = sender.send(raw);
            })
            .map_err(|error| runtime(format!("Browser script could not start: {error}")))?;
        let raw = receiver.recv_timeout(timeout).map_err(|_| {
            ControlError::new(
                ControlErrorCode::BrowserCommandTimeout,
                "Browser script timed out",
            )
        })?;
        let envelope: Value = serde_json::from_str(&raw)
            .map_err(|_| runtime("Browser returned an invalid script result"))?;
        if envelope.get("ok").and_then(Value::as_bool) != Some(true) {
            return Err(runtime(
                envelope
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("Browser script failed"),
            ));
        }
        Ok(envelope.get("value").cloned().unwrap_or(Value::Null))
    }

    fn wait(
        &self,
        label: &str,
        condition: &BrowserWaitCondition,
        timeout: Duration,
    ) -> Result<(), ControlError> {
        let expression = wait_expression(condition)?;
        let started = Instant::now();
        loop {
            let remaining = timeout
                .checked_sub(started.elapsed())
                .ok_or_else(browser_timeout)?;
            if self.evaluate(label, &expression, remaining.min(Duration::from_secs(2)))?
                == Value::Bool(true)
            {
                return Ok(());
            }
            if started.elapsed() >= timeout {
                return Err(browser_timeout());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    #[cfg(windows)]
    fn screenshot(
        &self,
        label: &str,
        surface_id: String,
        timeout: Duration,
    ) -> Result<BrowserResult, ControlError> {
        use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
        use windows::core::HSTRING;

        let dimensions = self.evaluate(
            label,
            "({ width: Math.max(1, window.innerWidth), height: Math.max(1, window.innerHeight) })",
            timeout,
        )?;
        let width = dimensions
            .get("width")
            .and_then(Value::as_u64)
            .and_then(|value| u32::try_from(value).ok())
            .unwrap_or(1);
        let height = dimensions
            .get("height")
            .and_then(Value::as_u64)
            .and_then(|value| u32::try_from(value).ok())
            .unwrap_or(1);
        let webview = self.webview(label)?;
        let (sender, receiver) = mpsc::sync_channel(1);
        webview
            .with_webview(move |platform| {
                let immediate_sender = sender.clone();
                let completion = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                    move |status, result| {
                        let _ =
                            sender.send(status.map(|_| result).map_err(|error| error.to_string()));
                        Ok(())
                    },
                ));
                let result = unsafe {
                    platform.controller().CoreWebView2().and_then(|core| {
                        core.CallDevToolsProtocolMethod(
                            &HSTRING::from("Page.captureScreenshot"),
                            &HSTRING::from(r#"{"format":"png","fromSurface":true}"#),
                            &completion,
                        )
                    })
                };
                if let Err(error) = result {
                    let _ = immediate_sender.send(Err(error.to_string()));
                }
            })
            .map_err(|error| runtime(format!("Browser capture could not start: {error}")))?;
        let response = receiver
            .recv_timeout(timeout)
            .map_err(|_| browser_timeout())?
            .map_err(|error| runtime(format!("Browser capture failed: {error}")))?;
        let data = serde_json::from_str::<Value>(&response)
            .ok()
            .and_then(|value| value.get("data").and_then(Value::as_str).map(str::to_owned))
            .ok_or_else(|| runtime("Browser capture returned no image"))?;
        Ok(BrowserResult::Screenshot {
            surface_id,
            data_url: format!("data:image/png;base64,{data}"),
            width,
            height,
        })
    }
}

impl BrowserExecutor for TauriBrowserExecutor {
    fn request_open(
        &self,
        request_id: &str,
        project_id: &str,
        url: &str,
    ) -> Result<(), ControlError> {
        self.app
            .emit(
                "browser-open-request",
                json!({ "requestId": request_id, "projectId": project_id, "url": url }),
            )
            .map_err(|error| runtime(format!("Browser open request failed: {error}")))
    }

    fn execute(
        &self,
        webview_label: &str,
        command: &BrowserCommand,
        timeout: Duration,
    ) -> Result<BrowserResult, ControlError> {
        let surface_id = command.surface_id().unwrap_or_default().to_owned();
        match command {
            BrowserCommand::Open { .. } => Err(ControlError::new(
                ControlErrorCode::BrowserInvalidCommand,
                "Open uses the browser surface creation flow",
            )),
            BrowserCommand::Navigate { url, .. } => {
                let parsed = tauri::Url::parse(url)
                    .map_err(|_| runtime("Browser navigation URL is invalid"))?;
                self.webview(webview_label)?
                    .navigate(parsed)
                    .map_err(|error| runtime(format!("Browser navigation failed: {error}")))?;
                Ok(BrowserResult::Navigation {
                    surface_id,
                    url: url.clone(),
                    phase: super::commands::NavigationPhase::Started,
                })
            }
            BrowserCommand::Wait { condition, .. } => {
                self.wait(webview_label, condition, timeout)?;
                Ok(BrowserResult::Action {
                    surface_id,
                    action: BrowserAction::Wait,
                })
            }
            BrowserCommand::Snapshot {
                selector,
                max_depth,
                ..
            } => {
                let selector = serde_json::to_string(selector).map_err(serialization)?;
                let depth = max_depth.unwrap_or(12);
                let expression = format!(
                    "(() => {{ const selector = {selector}; const root = selector ? document.querySelector(selector) : document.body; if (!root) throw new Error('Selector did not match'); const walk = (node, depth) => {{ if (depth > {depth}) return null; if (node.nodeType === Node.TEXT_NODE) {{ const text = node.textContent?.replace(/\\s+/g, ' ').trim(); return text || null; }} if (!(node instanceof Element)) return null; const children = Array.from(node.childNodes).map(child => walk(child, depth + 1)).filter(Boolean); const item = {{ tag: node.tagName.toLowerCase() }}; for (const key of ['id', 'role', 'aria-label', 'name', 'type', 'href', 'title', 'alt', 'placeholder']) {{ const value = node.getAttribute(key); if (value) item[key] = value; }} if (children.length) item.children = children; return item; }}; return JSON.stringify(walk(root, 0)); }})()"
                );
                let content = self
                    .evaluate(webview_label, &expression, timeout)?
                    .as_str()
                    .unwrap_or_default()
                    .to_owned();
                Ok(BrowserResult::Snapshot {
                    surface_id,
                    content,
                    truncated: false,
                })
            }
            BrowserCommand::Click { selector, .. } => {
                let selector = serde_json::to_string(selector).map_err(serialization)?;
                self.evaluate(
                    webview_label,
                    &format!("(() => {{ const element = document.querySelector({selector}); if (!(element instanceof HTMLElement)) throw new Error('Selector did not match a clickable element'); element.click(); return true; }})()"),
                    timeout,
                )?;
                Ok(BrowserResult::Action {
                    surface_id,
                    action: BrowserAction::Click,
                })
            }
            BrowserCommand::Fill { selector, text, .. } => {
                let selector = serde_json::to_string(selector).map_err(serialization)?;
                let text = serde_json::to_string(text).map_err(serialization)?;
                self.evaluate(
                    webview_label,
                    &format!("(() => {{ const element = document.querySelector({selector}); if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) throw new Error('Selector did not match a text field'); const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, {text}); element.dispatchEvent(new Event('input', {{ bubbles: true }})); element.dispatchEvent(new Event('change', {{ bubbles: true }})); return true; }})()"),
                    timeout,
                )?;
                Ok(BrowserResult::Action {
                    surface_id,
                    action: BrowserAction::Fill,
                })
            }
            BrowserCommand::Press { key, .. } => {
                // Synthetic KeyboardEvent is untrusted JS and does not enter iframes or shadow
                // roots. Space must be the DOM key " ", not the enum name "Space".
                let key = serde_json::to_string(key.dom_key()).map_err(serialization)?;
                self.evaluate(
                    webview_label,
                    &format!("(() => {{ const target = document.activeElement || document.body; target.dispatchEvent(new KeyboardEvent('keydown', {{ key: {key}, bubbles: true }})); target.dispatchEvent(new KeyboardEvent('keyup', {{ key: {key}, bubbles: true }})); return true; }})()"),
                    timeout,
                )?;
                Ok(BrowserResult::Action {
                    surface_id,
                    action: BrowserAction::Press,
                })
            }
            BrowserCommand::Eval { script, .. } => {
                let script = serde_json::to_string(script).map_err(serialization)?;
                let value =
                    self.evaluate(webview_label, &format!("(0, eval)({script})"), timeout)?;
                Ok(BrowserResult::Evaluation {
                    surface_id,
                    value,
                    truncated: false,
                })
            }
            BrowserCommand::Console { .. } => {
                let entries = serde_json::from_value(self.evaluate(
                    webview_label,
                    "window.__zliBrowser.console",
                    timeout,
                )?)
                .map_err(serialization)?;
                Ok(BrowserResult::ConsoleEntries {
                    surface_id,
                    entries,
                    truncated: false,
                })
            }
            BrowserCommand::Errors { .. } => {
                let errors = serde_json::from_value(self.evaluate(
                    webview_label,
                    "window.__zliBrowser.errors",
                    timeout,
                )?)
                .map_err(serialization)?;
                Ok(BrowserResult::PageErrors {
                    surface_id,
                    errors,
                    truncated: false,
                })
            }
            BrowserCommand::Screenshot { .. } => {
                #[cfg(windows)]
                {
                    self.screenshot(webview_label, surface_id, timeout)
                }
                #[cfg(not(windows))]
                {
                    Err(ControlError::new(
                        ControlErrorCode::MethodNotImplemented,
                        "Browser screenshots are not supported on this platform",
                    ))
                }
            }
        }
    }
}

pub fn instrumentation_script() -> &'static str {
    "if (!window.__zliBrowser) { window.__zliBrowser = { console: [], errors: [] }; const append = (items, item, limit) => { items.push(item); if (items.length > limit) items.splice(0, items.length - limit); }; for (const level of ['debug','info','warn','error']) { const original = console[level].bind(console); console[level] = (...args) => { try { append(window.__zliBrowser.console, { level, message: args.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join(' '), timestamp: new Date().toISOString() }, 1000); } catch (_) {} return original(...args); }; } window.addEventListener('error', event => append(window.__zliBrowser.errors, { message: String(event.message || 'Page error'), source: event.filename || undefined, line: event.lineno || undefined, column: event.colno || undefined }, 400)); window.addEventListener('unhandledrejection', event => append(window.__zliBrowser.errors, { message: String(event.reason?.message || event.reason || 'Unhandled rejection') }, 400)); }"
}

fn wait_expression(condition: &BrowserWaitCondition) -> Result<String, ControlError> {
    Ok(match condition {
        BrowserWaitCondition::Selector { selector, state } => {
            let selector = serde_json::to_string(selector).map_err(serialization)?;
            let element = format!("document.querySelector({selector})");
            match state.unwrap_or(SelectorState::Visible) {
                SelectorState::Attached => format!("Boolean({element})"),
                SelectorState::Detached => format!("!({element})"),
                SelectorState::Visible => format!("(() => {{ const element = {element}; if (!element) return false; const style = getComputedStyle(element); const rect = element.getBoundingClientRect(); return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0; }})()"),
                SelectorState::Hidden => format!("(() => {{ const element = {element}; if (!element) return true; const style = getComputedStyle(element); const rect = element.getBoundingClientRect(); return style.visibility === 'hidden' || style.display === 'none' || rect.width === 0 || rect.height === 0; }})()"),
            }
        }
        BrowserWaitCondition::Url { url } => {
            format!(
                "location.href === {}",
                serde_json::to_string(url).map_err(serialization)?
            )
        }
        BrowserWaitCondition::Load { state } => match state {
            LoadState::DomContentLoaded => "document.readyState !== 'loading'".into(),
            LoadState::Load | LoadState::NetworkIdle => "document.readyState === 'complete'".into(),
        },
    })
}

fn browser_timeout() -> ControlError {
    ControlError::new(
        ControlErrorCode::BrowserCommandTimeout,
        "Browser wait timed out",
    )
}

fn runtime(message: impl Into<String>) -> ControlError {
    ControlError::new(ControlErrorCode::ControlRuntimeError, message)
}

fn serialization(error: impl std::fmt::Display) -> ControlError {
    runtime(format!("Browser result could not be encoded: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_scripts_escape_user_values_as_json() {
        let condition = BrowserWaitCondition::Selector {
            selector: "#x\"); window.evil = true; (\"".into(),
            state: Some(SelectorState::Attached),
        };
        let expression = wait_expression(&condition).expect("wait expression");
        assert!(expression.contains("\\\""));
        assert!(!expression.contains("querySelector(\"#x\")"));
    }

    #[test]
    fn space_key_maps_to_the_dom_space_character() {
        assert_eq!(BrowserKey::Space.dom_key(), " ");
        assert_eq!(
            serde_json::to_string(BrowserKey::Space.dom_key()).expect("json"),
            "\" \""
        );
        assert_ne!(
            serde_json::to_string(&BrowserKey::Space).expect("enum json"),
            "\" \""
        );
    }
}
