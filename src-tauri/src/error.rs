use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "message")]
pub enum BackendError {
    #[error("invalid input: {0}")]
    InvalidInput(String),
    #[error("terminal session not found: {0}")]
    SessionNotFound(String),
    #[error("agent provider not found: {0}")]
    ProviderNotFound(String),
    #[error("executable not found: {0}")]
    ExecutableNotFound(String),
    #[error("invalid working directory: {0}")]
    InvalidWorkingDirectory(String),
    #[error("PTY error: {0}")]
    Pty(String),
    #[error("I/O error: {0}")]
    Io(String),
    #[error("internal error: {0}")]
    Internal(String),
}

impl From<std::io::Error> for BackendError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value.to_string())
    }
}
