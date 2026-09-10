use super::ControlTransport;
use crate::control::{
    CapabilityTokenStore, CommandRouter, ControlError, ControlErrorCode, ControlRequest,
    ControlResponse,
};
use serde::{Deserialize, Serialize};
use std::io;
use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};
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

const MAX_FRAME_BYTES: usize = 1024 * 1024;
const PREAMBLE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthenticatedRequest {
    token: String,
    request: ControlRequest,
}

pub struct NamedPipeServer {
    endpoint: String,
    stopping: Arc<AtomicBool>,
    thread: Option<JoinHandle<io::Result<()>>>,
}

impl NamedPipeServer {
    pub fn start_random(
        router: Arc<CommandRouter>,
        tokens: Arc<CapabilityTokenStore>,
    ) -> io::Result<Self> {
        let endpoint = format!(r"\\.\pipe\zli-{}", Uuid::new_v4().simple());
        let stopping = Arc::new(AtomicBool::new(false));
        let thread_endpoint = endpoint.clone();
        let thread_stopping = stopping.clone();
        let handle = thread::Builder::new()
            .name("zli-control-pipe".into())
            .spawn(move || serve(thread_endpoint, thread_stopping, router, tokens))?;
        Ok(Self {
            endpoint,
            stopping,
            thread: Some(handle),
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
        if let Some(handle) = self.thread.take() {
            handle
                .join()
                .map_err(|_| io::Error::other("control pipe thread panicked"))??;
        }
        Ok(())
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
        let timeout = u32::try_from(request.timeout_ms).unwrap_or(u32::MAX);
        let payload = serde_json::to_vec(&AuthenticatedRequest {
            token: self.token.clone(),
            request,
        })
        .map_err(io::Error::other)?;
        let mut response = vec![0_u8; MAX_FRAME_BYTES];
        let mut read = 0_u32;
        let endpoint = wide(&self.endpoint);
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
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        response.truncate(read as usize);
        let text = std::str::from_utf8(&response).map_err(|_| {
            io::Error::new(io::ErrorKind::InvalidData, "control response is not UTF-8")
        })?;
        ControlResponse::from_json(text).map_err(io::Error::other)
    }
}

fn serve(
    endpoint: String,
    stopping: Arc<AtomicBool>,
    router: Arc<CommandRouter>,
    tokens: Arc<CapabilityTokenStore>,
) -> io::Result<()> {
    let endpoint = wide(&endpoint);
    while !stopping.load(Ordering::Acquire) {
        let handle = unsafe {
            CreateNamedPipeW(
                endpoint.as_ptr(),
                PIPE_ACCESS_DUPLEX,
                PIPE_TYPE_MESSAGE
                    | PIPE_READMODE_MESSAGE
                    | PIPE_NOWAIT
                    | PIPE_REJECT_REMOTE_CLIENTS,
                1,
                MAX_FRAME_BYTES as u32,
                MAX_FRAME_BYTES as u32,
                100,
                ptr::null(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }

        let connected = wait_for_connection(handle, &stopping);
        if connected && !stopping.load(Ordering::Acquire) && same_user_client(handle) {
            let response = read_response(handle, &router, &tokens);
            let encoded = serde_json::to_vec(&response).map_err(io::Error::other)?;
            let mut written = 0_u32;
            unsafe {
                WriteFile(
                    handle,
                    encoded.as_ptr(),
                    encoded.len() as u32,
                    &mut written,
                    ptr::null_mut(),
                );
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
