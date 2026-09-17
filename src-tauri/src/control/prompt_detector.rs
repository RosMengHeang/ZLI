use super::utf8_stream::Utf8StreamDecoder;
use super::{AgentEventEnvelope, AgentEventKind, AgentEventPayload, AgentEventSource};
use uuid::Uuid;

const MAX_VISIBLE_LINE_BYTES: usize = 1024;
const MAX_CSI_PARAMETER_BYTES: usize = 16;

#[derive(Clone, Copy)]
enum PromptProvider {
    ClaudeCode,
    Codex,
    CursorAgent,
    OpenCode,
}

impl PromptProvider {
    fn from_id(provider_id: &str) -> Option<Self> {
        match provider_id {
            "claude" | "claude-code" => Some(Self::ClaudeCode),
            "codex" => Some(Self::Codex),
            "cursor-agent" | "cursor" => Some(Self::CursorAgent),
            "opencode" => Some(Self::OpenCode),
            _ => None,
        }
    }

    fn marker(self) -> Option<&'static [u8]> {
        match self {
            Self::ClaudeCode => Some("❯".as_bytes()),
            Self::Codex => Some("›".as_bytes()),
            Self::CursorAgent | Self::OpenCode => None,
        }
    }

    fn reason(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude_code_prompt_marker",
            Self::Codex => "codex_prompt_marker",
            Self::CursorAgent => "cursor_prompt_marker",
            Self::OpenCode => "opencode_prompt_marker",
        }
    }

    fn startup_blocker_reason(self, line: &[u8]) -> Option<&'static str> {
        match self {
            Self::ClaudeCode if contains_ascii_case_insensitive(line, b"sessionstart:startup hook error") => {
                Some("claude_startup_error")
            }
            Self::CursorAgent
                if contains_ascii_case_insensitive(line, b"workspace trust")
                    || contains_ascii_case_insensitive(line, b"do you trust the contents") =>
            {
                Some("cursor_workspace_trust_required")
            }
            Self::OpenCode
                if contains_ascii_case_insensitive(line, b"no provider configured")
                    || contains_ascii_case_insensitive(line, b"authentication required")
                    || contains_ascii_case_insensitive(line, b"api key required") =>
            {
                Some("opencode_provider_auth_required")
            }
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Default)]
enum EscapeState {
    #[default]
    Text,
    Escape,
    Csi,
    Osc,
    OscEscape,
}

struct ProviderPromptDetector {
    provider: Option<PromptProvider>,
    line: Vec<u8>,
    csi_parameters: Vec<u8>,
    escape_state: EscapeState,
    armed: bool,
    startup_blocker_armed: bool,
    active: bool,
}

impl ProviderPromptDetector {
    fn new(provider_id: &str) -> Self {
        Self {
            provider: PromptProvider::from_id(provider_id),
            line: Vec::with_capacity(128),
            csi_parameters: Vec::with_capacity(MAX_CSI_PARAMETER_BYTES),
            escape_state: EscapeState::Text,
            armed: true,
            startup_blocker_armed: true,
            active: true,
        }
    }

    fn accept(&mut self, chunk: &[u8]) -> Option<&'static str> {
        let provider = self.provider?;
        if !self.active {
            return None;
        }

        let mut evidence = None;
        for byte in chunk.iter().copied() {
            match self.escape_state {
                EscapeState::Text => match byte {
                    0x1b => self.escape_state = EscapeState::Escape,
                    b'\r' => {
                        evidence = evidence.or_else(|| self.observe_line(provider, false));
                        self.line.clear();
                    }
                    b'\n' => {
                        evidence = evidence.or_else(|| self.observe_line(provider, false));
                        self.line.clear();
                    }
                    0x08 => {
                        self.line.pop();
                    }
                    byte if byte >= 0x20 => {
                        self.line.push(byte);
                        if self.line.len() > MAX_VISIBLE_LINE_BYTES {
                            let overflow = self.line.len() - MAX_VISIBLE_LINE_BYTES;
                            self.line.drain(..overflow);
                        }
                    }
                    _ => {}
                },
                EscapeState::Escape => {
                    self.escape_state = match byte {
                        b'[' => {
                            self.csi_parameters.clear();
                            EscapeState::Csi
                        }
                        b']' => EscapeState::Osc,
                        _ => EscapeState::Text,
                    };
                }
                EscapeState::Csi => {
                    if (0x40..=0x7e).contains(&byte) {
                        match byte {
                            b'H' | b'f' | b'G' => {
                                evidence = evidence.or_else(|| self.observe_line(provider, false));
                                self.line.clear();
                            }
                            b'h' if self.csi_parameters == b"?25" => {
                                evidence = evidence.or_else(|| self.observe_line(provider, true));
                            }
                            b'K' => self.line.clear(),
                            _ => {}
                        }
                        self.csi_parameters.clear();
                        self.escape_state = EscapeState::Text;
                    } else if self.csi_parameters.len() < MAX_CSI_PARAMETER_BYTES {
                        self.csi_parameters.push(byte);
                    }
                }
                EscapeState::Osc => {
                    self.escape_state = match byte {
                        0x07 => EscapeState::Text,
                        0x1b => EscapeState::OscEscape,
                        _ => EscapeState::Osc,
                    };
                }
                EscapeState::OscEscape => {
                    self.escape_state = if byte == b'\\' {
                        EscapeState::Text
                    } else {
                        EscapeState::Osc
                    };
                }
            }
        }

        evidence
    }

    fn observe_line(
        &mut self,
        provider: PromptProvider,
        allow_placeholder: bool,
    ) -> Option<&'static str> {
        let line = trim_ascii(&self.line);
        if self.startup_blocker_armed {
            if let Some(reason) = provider.startup_blocker_reason(line) {
                self.startup_blocker_armed = false;
                return Some(reason);
            }
        }
        let marker = provider.marker();
        if marker.is_some_and(|marker| {
            line == marker
                || (allow_placeholder && prompt_row_has_placeholder(line, marker))
        }) {
            if self.armed {
                self.armed = false;
                return Some(provider.reason());
            }
            return None;
        }

        None
    }

    fn note_input(&mut self) {
        if self.active && self.provider.is_some() {
            self.line.clear();
            self.csi_parameters.clear();
            self.escape_state = EscapeState::Text;
            self.armed = true;
            self.startup_blocker_armed = true;
        }
    }

    fn clear(&mut self) {
        self.line.clear();
        self.csi_parameters.clear();
        self.escape_state = EscapeState::Text;
        self.armed = false;
        self.startup_blocker_armed = false;
        self.active = false;
    }
}

fn prompt_row_has_placeholder(line: &[u8], marker: &[u8]) -> bool {
    let Some(suffix) = line.strip_prefix(marker) else {
        return false;
    };
    suffix.starts_with(b" ") || suffix.starts_with("\u{00a0}".as_bytes())
}

fn contains_ascii_case_insensitive(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty()
        && haystack
            .windows(needle.len())
            .any(|window| window.eq_ignore_ascii_case(needle))
}

fn trim_ascii(mut bytes: &[u8]) -> &[u8] {
    while bytes.first().is_some_and(u8::is_ascii_whitespace) {
        bytes = &bytes[1..];
    }
    while bytes.last().is_some_and(u8::is_ascii_whitespace) {
        bytes = &bytes[..bytes.len() - 1];
    }
    bytes
}

pub(crate) struct AgentOutputNormalizer {
    project_id: String,
    agent_id: String,
    detector: ProviderPromptDetector,
    utf8: Utf8StreamDecoder,
}

impl AgentOutputNormalizer {
    pub(crate) fn new(project_id: &str, agent_id: &str, provider_id: &str) -> Self {
        Self {
            project_id: project_id.to_owned(),
            agent_id: agent_id.to_owned(),
            detector: ProviderPromptDetector::new(provider_id),
            utf8: Utf8StreamDecoder::new(),
        }
    }

    pub(crate) fn accept_output(&mut self, chunk: &[u8]) -> Vec<AgentEventEnvelope> {
        // Prompt detection stays byte-based so split markers still match.
        let text = self.utf8.push(chunk);
        let mut events = Vec::new();
        if !text.is_empty() {
            events.push(self.event(
                AgentEventKind::AgentOutput,
                AgentEventPayload::Text { text },
                AgentEventSource::Pty,
            ));
        }
        if let Some(reason) = self.detector.accept(chunk) {
            events.push(self.event(
                AgentEventKind::AgentPromptDetected,
                AgentEventPayload::Attention {
                    reason: reason.to_owned(),
                },
                AgentEventSource::Provider,
            ));
        }
        events
    }

    pub(crate) fn clear(&mut self) {
        self.detector.clear();
        self.utf8.clear();
    }

    pub(crate) fn accept_input(&mut self, input: &[u8]) {
        if input.iter().any(|byte| matches!(byte, b'\r' | b'\n')) {
            self.detector.note_input();
        }
    }

    fn event(
        &self,
        kind: AgentEventKind,
        payload: AgentEventPayload,
        source: AgentEventSource,
    ) -> AgentEventEnvelope {
        let mut event = AgentEventEnvelope::new(
            Uuid::new_v4().to_string(),
            self.project_id.clone(),
            Some(self.agent_id.clone()),
            kind,
            payload,
        );
        event.source = source;
        event
    }
}
