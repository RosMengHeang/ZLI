use super::ControlTransport;
use crate::control::{
    CapabilityTokenStore, CommandRouter, ControlError, ControlErrorCode, ControlRequest,
    ControlResponse, MAX_CONTROL_FRAME_BYTES,
};
use serde::{Deserialize, Serialize};
use std::io;
use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use uuid::Uuid;
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_MORE_DATA, ERROR_NO_DATA, ERROR_PIPE_CONNECTED,
    ERROR_PIPE_LISTENING, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Security::{
    EqualSid, GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER,
};
use windows_sys::Win32::Storage::FileSystem::{ReadFile, WriteFile, PIPE_ACCESS_DUPLEX};
use windows_sys::Win32::System::Pipes::{
    CallNamedPipeW, ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe,
    GetNamedPipeClientProcessId, PIPE_NOWAIT, PIPE_READMODE_MESSAGE, PIPE_REJECT_REMOTE_CLIENTS,
    PIPE_TYPE_MESSAGE,
};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
};

const MAX_FRAME_BYTES: usize = MAX_CONTROL_FRAME_BYTES;
const PIPE_INSTANCE_COUNT: u32 = 4;
const PIPE_SHUTDOWN_DEADLINE: Duration = Duration::from_secs(2);
const ERROR_PIPE_BUSY: i32 = 231;
const PREAMBLE_TIMEOUT: Duration = Duration::from_secs(5);
const PIPE_RETRY_DELAY: Duration = Duration::from_millis(50);
const MAX_PIPE_STARTUP_RETRIES: usize = 5;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthenticatedRequest {
    token: String,
    request: ControlRequest,
}

pub struct NamedPipeServer {
    endpoint: String,
    stopping: Arc<AtomicBool>,
    threads: Vec<JoinHandle<io::Result<()>>>,
}

impl NamedPipeServer {
    pub fn random_endpoint() -> String {
        format!(r"\\.\pipe\zli-{}", Uuid::new_v4().simple())
    }

    pub fn start_random(
        router: Arc<CommandRouter>,
        tokens: Arc<CapabilityTokenStore>,
    ) -> io::Result<Self> {
        Self::start(Self::random_endpoint(), router, tokens)
    }

    pub fn start(
        endpoint: String,
        router: Arc<CommandRouter>,
        tokens: Arc<CapabilityTokenStore>,
    ) -> io::Result<Self> {
        let stopping = Arc::new(AtomicBool::new(false));
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let ready_sent = Arc::new(AtomicBool::new(false));
        let mut threads = Vec::with_capacity(PIPE_INSTANCE_COUNT as usize);
        for index in 0..PIPE_INSTANCE_COUNT {
            let thread_endpoint = endpoint.clone();
            let thread_stopping = stopping.clone();
            let thread_router = router.clone();
            let thread_tokens = tokens.clone();
            let ready_tx = ready_tx.clone();
            let ready_sent = ready_sent.clone();
            let handle = thread::Builder::new()
                .name(format!("zli-control-pipe-{index}"))
                .spawn(move || {
                    serve_instance(
                        thread_endpoint,
                        thread_stopping,
                        thread_router,
                        thread_tokens,
                        move || {
                            if !ready_sent.swap(true, Ordering::AcqRel) {
                                let _ = ready_tx.send(());
                            }
                        },
                    )
                })?;
            threads.push(handle);
        }
        drop(ready_tx);
        if ready_rx.recv_timeout(Duration::from_secs(2)).is_err() {
            stopping.store(true, Ordering::Release);
            for handle in threads {
                let _ = join_with_deadline(handle, PIPE_SHUTDOWN_DEADLINE);
            }
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "control pipe did not become ready",
            ));
        }
        Ok(Self {
            endpoint,
            stopping,
            threads,
        })
    }

    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    pub fn stop(mut self) -> io::Result<()> {
        self.stop_inner()
    }

    fn stop_inner(&mut self) -> io::Result<()> {
        self.stopping.store(true, Ordering::Release);
        let mut first_error = None;
        for handle in self.threads.drain(..) {
            if let Err(error) = join_with_deadline(handle, PIPE_SHUTDOWN_DEADLINE) {
                first_error.get_or_insert(error);
            }
        }
        match first_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}

impl ControlTransport for NamedPipeServer {
    fn endpoint(&self) -> &str {
        self.endpoint()
    }

    fn stop(self) -> io::Result<()> {
        NamedPipeServer::stop(self)
    }
}

impl Drop for NamedPipeServer {
    fn drop(&mut self) {
        let _ = self.stop_inner();
    }
}

#[derive(Clone, Debug)]
pub struct NamedPipeClient {
    endpoint: String,
    token: String,
}

impl NamedPipeClient {
    pub fn new(endpoint: String, token: String) -> Self {
        Self { endpoint, token }
    }

    pub fn request(&self, request: ControlRequest) -> io::Result<ControlResponse> {
        let request_timeout_ms = request.timeout_ms;
        let payload = serde_json::to_vec(&AuthenticatedRequest {
            token: self.token.clone(),
            request,
        })
        .map_err(io::Error::other)?;
        let endpoint = wide(&self.endpoint);
        let started = Instant::now();
        for attempt in 0..=MAX_PIPE_STARTUP_RETRIES {
            let elapsed_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
            let remaining_ms = request_timeout_ms.saturating_sub(elapsed_ms);
            if remaining_ms == 0 {
                break;
            }
            let timeout = u32::try_from(remaining_ms).unwrap_or(u32::MAX);
            let mut response = vec![0_u8; MAX_FRAME_BYTES];
            let mut read = 0_u32;
            let ok = unsafe {
                CallNamedPipeW(
                    endpoint.as_ptr(),
                    payload.as_ptr().cast(),
                    payload.len() as u32,
                    response.as_mut_ptr().cast(),
                    response.len() as u32,
                    &mut read,
                    timeout,
                )
            };
            if ok != 0 {
                response.truncate(read as usize);
                let text = std::str::from_utf8(&response).map_err(|_| {
                    io::Error::new(io::ErrorKind::InvalidData, "control response is not UTF-8")
                })?;
                return ControlResponse::from_json(text).map_err(io::Error::other);
            }

            let error = io::Error::last_os_error();
            if !is_retryable_pipe_error(&error) || attempt == MAX_PIPE_STARTUP_RETRIES {
                return Err(error);
            }
            let delay_ms = u64::try_from(PIPE_RETRY_DELAY.as_millis()).unwrap_or(0);
            std::thread::sleep(Duration::from_millis(delay_ms.min(remaining_ms)));
        }
        Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "control pipe request timed out before a server became ready",
        ))
    }
}

fn is_retryable_pipe_error(error: &io::Error) -> bool {
    matches!(error.raw_os_error(), Some(2) | Some(121) | Some(231))
}

fn join_with_deadline(
    handle: JoinHandle<io::Result<()>>,
    deadline: Duration,
) -> io::Result<()> {
    let (sender, receiver) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let _ = sender.send(handle.join());
    });
    match receiver.recv_timeout(deadline) {
        Ok(Ok(Ok(()))) => Ok(()),
        Ok(Ok(Err(error))) => Err(error),
        Ok(Err(_)) => Err(io::Error::other("control pipe thread panicked")),
        Err(_) => Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "control pipe shutdown timed out",
        )),
    }
}

pub(crate) fn encode_control_frame(response: ControlResponse) -> Vec<u8> {
    let id = response.id.clone();
    match serde_json::to_vec(&response) {
        Ok(bytes) if bytes.len() <= MAX_FRAME_BYTES => bytes,
        _ => serde_json::to_vec(&ControlResponse::failure(
            id,
            ControlError::new(
                ControlErrorCode::BrowserResultTooLarge,
                "Control response exceeds the frame limit",
            ),
        ))
        .unwrap_or_else(|_| {
            br#"{"id":"invalid","protocolVersion":1,"ok":false,"error":{"code":"BROWSER_RESULT_TOO_LARGE","message":"Control response exceeds the frame limit"}}"#
                .to_vec()
        }),
    }
}

fn write_checked(handle: *mut core::ffi::c_void, bytes: &[u8]) -> bool {
    let mut written = 0_u32;
    let ok = unsafe {
        WriteFile(
            handle,
            bytes.as_ptr(),
            bytes.len() as u32,
            &mut written,
            ptr::null_mut(),
        )
    };
    ok != 0 && written as usize == bytes.len()
}

fn serve_instance(
    endpoint: String,
    stopping: Arc<AtomicBool>,
    router: Arc<CommandRouter>,
    tokens: Arc<CapabilityTokenStore>,
    mut on_listen: impl FnMut(),
) -> io::Result<()> {
    let endpoint = wide(&endpoint);
    let mut announced = false;
    while !stopping.load(Ordering::Acquire) {
        let handle = unsafe {
            CreateNamedPipeW(
                endpoint.as_ptr(),
                PIPE_ACCESS_DUPLEX,
                PIPE_TYPE_MESSAGE
                    | PIPE_READMODE_MESSAGE
                    | PIPE_NOWAIT
                    | PIPE_REJECT_REMOTE_CLIENTS,
                PIPE_INSTANCE_COUNT,
                MAX_FRAME_BYTES as u32,
                MAX_FRAME_BYTES as u32,
                100,
                ptr::null(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(ERROR_PIPE_BUSY) {
                thread::sleep(Duration::from_millis(10));
                continue;
            }
            return Err(error);
        }
        if !announced {
            announced = true;
            on_listen();
        }

        let connected = wait_for_connection(handle, &stopping);
        if connected && !stopping.load(Ordering::Acquire) && same_user_client(handle) {
            let encoded = encode_control_frame(read_response(handle, &router, &tokens));
            let _ = write_checked(handle, &encoded);
            unsafe {
                DisconnectNamedPipe(handle);
            }
        }
        unsafe { CloseHandle(handle) };
    }
    Ok(())
}

fn wait_for_connection(handle: *mut core::ffi::c_void, stopping: &AtomicBool) -> bool {
    loop {
        if stopping.load(Ordering::Acquire) {
            return false;
        }
        let connected = unsafe { ConnectNamedPipe(handle, ptr::null_mut()) };
        if connected != 0 {
            return true;
        }
        let error = unsafe { GetLastError() };
        if error == ERROR_PIPE_CONNECTED {
            return true;
        }
        if error != ERROR_PIPE_LISTENING {
            return false;
        }
        thread::sleep(Duration::from_millis(10));
    }
}

fn read_response(
    handle: *mut core::ffi::c_void,
    router: &CommandRouter,
    tokens: &CapabilityTokenStore,
) -> ControlResponse {
    let mut payload = Vec::new();
    let started = Instant::now();
    loop {
        if payload.len() >= MAX_FRAME_BYTES {
            return failure("invalid", "Control request exceeds the frame limit");
        }
        let mut chunk = [0_u8; 8192];
        let mut read = 0_u32;
        let ok = unsafe {
            ReadFile(
                handle,
                chunk.as_mut_ptr(),
                chunk.len() as u32,
                &mut read,
                ptr::null_mut(),
            )
        };
        if read > 0 {
            payload.extend_from_slice(&chunk[..read as usize]);
        }
        if ok != 0 {
            break;
        }
        let error = unsafe { GetLastError() };
        if error == ERROR_MORE_DATA {
            continue;
        }
        if error == ERROR_NO_DATA && started.elapsed() < PREAMBLE_TIMEOUT {
            thread::sleep(Duration::from_millis(10));
            continue;
        }
        return failure("invalid", "Control request could not be read");
    }

    let envelope: AuthenticatedRequest = match serde_json::from_slice(&payload) {
        Ok(envelope) => envelope,
        Err(_) => return failure("invalid", "Control request is malformed"),
    };
    let identity = match tokens.verify(&envelope.token) {
        Ok(identity) => identity,
        Err(error) => return ControlResponse::failure(envelope.request.id, error),
    };
    router.dispatch(envelope.request, identity)
}

fn failure(id: &str, message: &str) -> ControlResponse {
    ControlResponse::failure(
        id,
        ControlError::new(ControlErrorCode::InvalidControlRequest, message),
    )
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn same_user_client(pipe: *mut core::ffi::c_void) -> bool {
    let mut client_pid = 0_u32;
    if unsafe { GetNamedPipeClientProcessId(pipe, &mut client_pid) } == 0 {
        return false;
    }
    let client_process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, client_pid) };
    if client_process.is_null() {
        return false;
    }

    let mut client_token = ptr::null_mut();
    let mut server_token = ptr::null_mut();
    let opened = unsafe {
        OpenProcessToken(client_process, TOKEN_QUERY, &mut client_token) != 0
            && OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut server_token) != 0
    };
    let matches = if opened {
        match (
            token_user_buffer(client_token),
            token_user_buffer(server_token),
        ) {
            (Some(client), Some(server)) => {
                let client_user = unsafe { &*(client.as_ptr().cast::<TOKEN_USER>()) };
                let server_user = unsafe { &*(server.as_ptr().cast::<TOKEN_USER>()) };
                unsafe { EqualSid(client_user.User.Sid, server_user.User.Sid) != 0 }
            }
            _ => false,
        }
    } else {
        false
    };
    unsafe {
        if !client_token.is_null() {
            CloseHandle(client_token);
        }
        if !server_token.is_null() {
            CloseHandle(server_token);
        }
        CloseHandle(client_process);
    }
    matches
}

fn token_user_buffer(token: *mut core::ffi::c_void) -> Option<Vec<usize>> {
    let mut byte_len = 0_u32;
    unsafe {
        GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut byte_len);
    }
    if byte_len == 0 {
        return None;
    }
    let words = (byte_len as usize).div_ceil(std::mem::size_of::<usize>());
    let mut buffer = vec![0_usize; words];
    let ok = unsafe {
        GetTokenInformation(
            token,
            TokenUser,
            buffer.as_mut_ptr().cast(),
            byte_len,
            &mut byte_len,
        )
    };
    (ok != 0).then_some(buffer)
}

#[cfg(test)]
mod tests {
    use super::{encode_control_frame, is_retryable_pipe_error, MAX_FRAME_BYTES};
    use crate::control::ControlResponse;
    use serde_json::json;
    use std::io;

    #[test]
    fn retries_only_transient_pipe_startup_errors() {
        assert!(is_retryable_pipe_error(&io::Error::from_raw_os_error(2)));
        assert!(is_retryable_pipe_error(&io::Error::from_raw_os_error(121)));
        assert!(is_retryable_pipe_error(&io::Error::from_raw_os_error(231)));
        assert!(!is_retryable_pipe_error(&io::Error::from_raw_os_error(5)));
    }

    #[test]
    fn encode_control_frame_keeps_payloads_that_fit() {
        let response = ControlResponse::success("pipe-1", json!({ "ok": true }));
        let encoded = encode_control_frame(response);
        assert!(encoded.len() < MAX_FRAME_BYTES);
        assert!(encoded.starts_with(b"{"));
        assert!(std::str::from_utf8(&encoded).unwrap().contains("pipe-1"));
    }

    #[test]
    fn encode_control_frame_rejects_oversize_payloads() {
        let huge = "x".repeat(MAX_FRAME_BYTES);
        let response = ControlResponse::success("pipe-oversize", json!({ "blob": huge }));
        let encoded = encode_control_frame(response);
        assert!(encoded.len() <= MAX_FRAME_BYTES);
        let body = std::str::from_utf8(&encoded).expect("utf8");
        assert!(body.contains("BROWSER_RESULT_TOO_LARGE"));
        assert!(body.contains("pipe-oversize"));
        assert!(!body.contains(&"x".repeat(1024)));
    }
}
