use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use std::{io::Read, thread};

const SESSION_ID_MARKER: &str = "session id";
const SESSION_ID_REJECT: &[&str] = &["is", "the", "not", "none", "unknown", "na"];
const IDENTITY_PROBE_TIMEOUT: Duration = Duration::from_millis(1500);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DeliveryKind {
    MintedSlots,
    ExplicitPull,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum IdentityVerdict {
    Missing,
    #[serde(rename_all = "camelCase")]
    Verified {
        path: PathBuf,
        product: String,
        version: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Rejected {
        path: PathBuf,
        reason: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCapabilityReport {
    pub provider_id: String,
    pub display_name: String,
    pub executable_verified: bool,
    pub mcp_configured: bool,
    pub shell_tools_available: bool,
    pub readiness_reliable: bool,
    pub acknowledgement_available: bool,
    pub exact_resume_available: bool,
    pub delivery: DeliveryKind,
    pub executable_path: Option<PathBuf>,
    pub identity: IdentityVerdict,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ParsedSessionId(String);

impl ParsedSessionId {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionProvenance {
    pub marker: String,
    pub source_line: String,
    pub captured_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum ResumeRecord {
    Unsupported,
    #[serde(rename_all = "camelCase")]
    Unknown {
        reason: String,
        last_probe_at: String,
    },
    #[serde(rename_all = "camelCase")]
    Available {
        id: ParsedSessionId,
        provenance: SessionProvenance,
        resume_command_kind: String,
    },
}

impl ResumeRecord {
    pub fn from_probe(probe: ResumeProbe) -> Self {
        match probe {
            ResumeProbe::Unsupported => ResumeRecord::Unsupported,
            ResumeProbe::Miss { reason } | ResumeProbe::Rejected { reason } => ResumeRecord::Unknown {
                reason,
                last_probe_at: unix_timestamp_secs(),
            },
            ResumeProbe::Hit { id, provenance } => ResumeRecord::Available {
                id,
                provenance,
                resume_command_kind: "session_id".into(),
            },
        }
    }

    pub fn needs_probe(&self) -> bool {
        matches!(self, ResumeRecord::Unknown { .. })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ResumeProbe {
    Unsupported,
    Miss {
        reason: String,
    },
    Rejected {
        reason: String,
    },
    Hit {
        id: ParsedSessionId,
        provenance: SessionProvenance,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProviderContractFlags {
    pub delivery: DeliveryKind,
    pub readiness_reliable: bool,
    pub acknowledgement_available: bool,
    pub exact_resume_available: bool,
}

pub fn provider_contract_flags(provider_id: &str) -> ProviderContractFlags {
    match provider_id {
        "claude-code" | "codex" => ProviderContractFlags {
            delivery: DeliveryKind::MintedSlots,
            readiness_reliable: true,
            acknowledgement_available: true,
            exact_resume_available: true,
        },
        _ => ProviderContractFlags {
            delivery: DeliveryKind::ExplicitPull,
            readiness_reliable: false,
            acknowledgement_available: false,
            exact_resume_available: false,
        },
    }
}

pub fn parse_session_id(output: &str) -> ResumeProbe {
    let Some((line, marker_offset)) = output.lines().find_map(|line| {
        line.to_ascii_lowercase()
            .find(SESSION_ID_MARKER)
            .map(|offset| (line, offset))
    }) else {
        return ResumeProbe::Miss {
            reason: "no session id marker".into(),
        };
    };
    let after_marker = line.get(marker_offset + SESSION_ID_MARKER.len()..).unwrap_or("");
    let trimmed = after_marker.trim_start_matches([':', ' ', '\t']);
    let unquoted = strip_matching_quotes(trimmed);
    match parse_session_token(unquoted) {
        Ok(id) => ResumeProbe::Hit {
            id,
            provenance: SessionProvenance {
                marker: SESSION_ID_MARKER.into(),
                source_line: truncate_bytes(line, 256),
                captured_at: unix_timestamp_secs(),
            },
        },
        Err(reason) => ResumeProbe::Rejected { reason },
    }
}

pub fn probe_cursor_identity(path: &Path) -> IdentityVerdict {
    let combined = match run_identity_command(path, &["--version"])
        .or_else(|_| run_identity_command(path, &["--help"]))
    {
        Ok(output) => output,
        Err(reason) => {
            return IdentityVerdict::Rejected {
                path: path.to_path_buf(),
                reason,
            }
        }
    };
    if combined.contains("cursor-agent") || combined.contains("Cursor Agent") {
        IdentityVerdict::Verified {
            path: path.to_path_buf(),
            product: "Cursor Agent".into(),
            version: None,
        }
    } else {
        IdentityVerdict::Rejected {
            path: path.to_path_buf(),
            reason: "executable is not Cursor Agent".into(),
        }
    }
}

pub fn path_looks_like_cursor_agent(path: &Path) -> bool {
    file_name_eq(path, &["cursor-agent", "cursor-agent.exe", "cursor-agent.cmd", "cursor-agent.ps1"])
}

pub fn path_looks_like_agent_alias(path: &Path) -> bool {
    file_name_eq(path, &["agent", "agent.exe", "agent.cmd", "agent.ps1"])
}

pub fn named_cursor_identity(path: &Path) -> IdentityVerdict {
    IdentityVerdict::Verified {
        path: path.to_path_buf(),
        product: "Cursor Agent".into(),
        version: None,
    }
}

fn parse_session_token(token: &str) -> Result<ParsedSessionId, String> {
    let parsed: String = token
        .chars()
        .take_while(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
        .collect();
    if parsed.len() < 8 || parsed.len() > 128 {
        return Err(format!("session id length {}", parsed.len()));
    }
    if SESSION_ID_REJECT
        .iter()
        .any(|rejected| parsed.eq_ignore_ascii_case(rejected))
    {
        return Err(format!("session id token {parsed} is reserved"));
    }
    Ok(ParsedSessionId(parsed))
}

fn strip_matching_quotes(value: &str) -> &str {
    let bytes = value.as_bytes();
    if bytes.len() >= 2 {
        match (bytes[0], bytes[bytes.len() - 1]) {
            (b'\'', b'\'') | (b'"', b'"') => &value[1..value.len() - 1],
            _ => value,
        }
    } else {
        value
    }
}

fn truncate_bytes(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_owned();
    }
    let mut end = max_bytes;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_owned()
}

fn unix_timestamp_secs() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "0".into())
}

fn file_name_eq(path: &Path, names: &[&str]) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    names
        .iter()
        .any(|expected| name.eq_ignore_ascii_case(expected))
}

fn run_identity_command(path: &Path, extra_args: &[&str]) -> Result<String, String> {
    let (program, mut arguments) = crate::agents::launcher_for_executable(path.to_path_buf())
        .map_err(|error| error.to_string())?;
    arguments.extend(extra_args.iter().map(std::ffi::OsString::from));
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
            Ok(None) if started.elapsed() < IDENTITY_PROBE_TIMEOUT => {
                thread::sleep(Duration::from_millis(20));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("identity probe timed out".into());
            }
            Err(error) => return Err(error.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_session_id_accepts_a_validated_token_and_strips_quotes() {
        let probe = parse_session_id("Session ID: \"codex-session-123\"\n");
        match probe {
            ResumeProbe::Hit { id, provenance } => {
                assert_eq!(id.as_str(), "codex-session-123");
                assert_eq!(provenance.marker, "session id");
                assert!(provenance.source_line.contains("codex-session-123"));
            }
            other => panic!("expected hit, got {other:?}"),
        }
    }

    #[test]
    fn parse_session_id_rejects_prose_and_reserved_tokens() {
        assert!(matches!(
            parse_session_id("the session id is unknown\n"),
            ResumeProbe::Rejected { .. }
        ));
        assert!(matches!(
            parse_session_id("session id: none\n"),
            ResumeProbe::Rejected { .. }
        ));
        assert!(matches!(
            parse_session_id("no identifier here\n"),
            ResumeProbe::Miss { .. }
        ));
        assert!(matches!(
            parse_session_id("session id: ab\n"),
            ResumeProbe::Rejected { .. }
        ));
    }

    #[test]
    fn resume_record_reprobes_unknown_and_not_available() {
        let unknown = ResumeRecord::from_probe(ResumeProbe::Rejected {
            reason: "session id length 2".into(),
        });
        assert!(unknown.needs_probe());
        let available = ResumeRecord::from_probe(parse_session_id(
            "session id: 550e8400-e29b-41d4-a716-446655440000\n",
        ));
        assert!(!available.needs_probe());
        assert!(!ResumeRecord::Unsupported.needs_probe());
    }
}
