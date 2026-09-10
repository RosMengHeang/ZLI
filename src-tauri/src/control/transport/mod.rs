use std::io;

#[cfg(windows)]
pub mod named_pipe;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TransportHandle {
    pub endpoint: String,
}

pub trait ControlTransport: Send + Sync {
    fn endpoint(&self) -> &str;
    fn stop(self) -> io::Result<()>
    where
        Self: Sized;
}
