use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessIdentity {
    pub pid: u32,
    pub start_time: u64,
    pub executable: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProcessInspection {
    Matching,
    NotRunning,
    Mismatch,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProcessTermination {
    Terminated,
    NotRunning,
    Mismatch,
    Unknown,
}

#[cfg(windows)]
mod windows_impl {
    use super::{ProcessIdentity, ProcessInspection, ProcessTermination};
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use std::ptr::null;
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_INVALID_PARAMETER, FALSE, FILETIME, HANDLE, WAIT_OBJECT_0,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, TerminateProcess,
        WaitForSingleObject, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_SET_QUOTA, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
    };

    const ACCESS_QUERY: u32 = PROCESS_QUERY_LIMITED_INFORMATION;
    const ACCESS_TERMINATE: u32 =
        PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE | PROCESS_TERMINATE;
    const QUERY_PATH_CAPACITY: usize = 32_768;
    const TERMINATION_TIMEOUT_MS: u32 = 5_000;
    const ACCESS_JOB: u32 = PROCESS_SET_QUOTA | PROCESS_TERMINATE;

    struct ProcessHandle(HANDLE);

    impl Drop for ProcessHandle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    pub(crate) struct ProcessTree {
        handle: HANDLE,
    }

    // A process tree handle is an owned Windows kernel handle. It is safe to
    // move and share the handle because the OS synchronizes job operations.
    unsafe impl Send for ProcessTree {}
    unsafe impl Sync for ProcessTree {}

    impl Drop for ProcessTree {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.handle);
            }
        }
    }

    impl ProcessTree {
        pub(crate) fn terminate(&self) -> bool {
            (unsafe { TerminateJobObject(self.handle, 1) != 0 })
                && (unsafe {
                    WaitForSingleObject(self.handle, TERMINATION_TIMEOUT_MS) == WAIT_OBJECT_0
                })
        }
    }

    enum OpenError {
        NotRunning,
        Unknown,
    }

    fn open(pid: u32, access: u32) -> Result<ProcessHandle, OpenError> {
        let handle = unsafe { OpenProcess(access, FALSE, pid) };
        if handle.is_null() {
            if unsafe { GetLastError() } == ERROR_INVALID_PARAMETER {
                Err(OpenError::NotRunning)
            } else {
                Err(OpenError::Unknown)
            }
        } else {
            Ok(ProcessHandle(handle))
        }
    }

    fn file_time_value(time: FILETIME) -> u64 {
        (u64::from(time.dwHighDateTime) << 32) | u64::from(time.dwLowDateTime)
    }

    fn query(handle: HANDLE, pid: u32) -> Option<ProcessIdentity> {
        let mut creation = FILETIME::default();
        let mut exit = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        if unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) } == 0
        {
            return None;
        }

        let mut path = vec![0_u16; QUERY_PATH_CAPACITY];
        let mut length = u32::try_from(path.len()).ok()?;
        if unsafe {
            QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, path.as_mut_ptr(), &mut length)
        } == 0
        {
            return None;
        }
        path.truncate(usize::try_from(length).ok()?);
        let executable = OsString::from_wide(&path).to_string_lossy().into_owned();
        if executable.trim().is_empty() {
            return None;
        }
        Some(ProcessIdentity {
            pid,
            start_time: file_time_value(creation),
            executable,
        })
    }

    fn same_identity(expected: &ProcessIdentity, actual: &ProcessIdentity) -> bool {
        expected.pid == actual.pid
            && expected.start_time == actual.start_time
            && normalize_path(&expected.executable) == normalize_path(&actual.executable)
    }

    fn normalize_path(path: &str) -> String {
        path.replace('/', "\\")
            .trim_end_matches('\\')
            .to_ascii_lowercase()
    }

    pub(super) fn capture(pid: u32) -> Option<ProcessIdentity> {
        let handle = open(pid, ACCESS_QUERY).ok()?;
        query(handle.0, pid)
    }

    pub(super) fn attach_process_tree(pid: u32) -> Option<ProcessTree> {
        let job = unsafe { CreateJobObjectW(null(), null()) };
        if job.is_null() {
            return None;
        }

        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) != 0
        };
        if !configured {
            unsafe {
                CloseHandle(job);
            }
            return None;
        }

        let process = unsafe { OpenProcess(ACCESS_JOB, FALSE, pid) };
        if process.is_null() {
            unsafe {
                CloseHandle(job);
            }
            return None;
        }
        let assigned = unsafe { AssignProcessToJobObject(job, process) != 0 };
        unsafe {
            CloseHandle(process);
        }
        if !assigned {
            unsafe {
                CloseHandle(job);
            }
            return None;
        }

        Some(ProcessTree { handle: job })
    }

    pub(super) fn inspect(identity: &ProcessIdentity) -> ProcessInspection {
        let handle = match open(identity.pid, ACCESS_QUERY) {
            Ok(handle) => handle,
            Err(OpenError::NotRunning) => return ProcessInspection::NotRunning,
            Err(OpenError::Unknown) => return ProcessInspection::Unknown,
        };
        let Some(actual) = query(handle.0, identity.pid) else {
            return ProcessInspection::Unknown;
        };
        if same_identity(identity, &actual) {
            ProcessInspection::Matching
        } else {
            ProcessInspection::Mismatch
        }
    }

    pub(super) fn terminate_verified(identity: &ProcessIdentity) -> ProcessTermination {
        let handle = match open(identity.pid, ACCESS_TERMINATE) {
            Ok(handle) => handle,
            Err(OpenError::NotRunning) => return ProcessTermination::NotRunning,
            Err(OpenError::Unknown) => return ProcessTermination::Unknown,
        };
        let Some(actual) = query(handle.0, identity.pid) else {
            return ProcessTermination::Unknown;
        };
        if !same_identity(identity, &actual) {
            return ProcessTermination::Mismatch;
        }
        if unsafe { TerminateProcess(handle.0, 1) } == 0 {
            return ProcessTermination::Unknown;
        }
        if unsafe { WaitForSingleObject(handle.0, TERMINATION_TIMEOUT_MS) } == WAIT_OBJECT_0 {
            ProcessTermination::Terminated
        } else {
            ProcessTermination::Unknown
        }
    }
}

#[cfg(windows)]
pub(crate) use windows_impl::ProcessTree;

#[cfg(windows)]
pub fn capture(pid: u32) -> Option<ProcessIdentity> {
    windows_impl::capture(pid)
}

#[cfg(windows)]
pub(crate) fn attach_process_tree(pid: u32) -> Option<ProcessTree> {
    windows_impl::attach_process_tree(pid)
}

#[cfg(not(windows))]
pub(crate) fn attach_process_tree(_pid: u32) -> Option<()> {
    None
}

#[cfg(not(windows))]
pub fn capture(_pid: u32) -> Option<ProcessIdentity> {
    None
}

#[cfg(windows)]
pub fn inspect(identity: &ProcessIdentity) -> ProcessInspection {
    windows_impl::inspect(identity)
}

#[cfg(not(windows))]
pub fn inspect(_identity: &ProcessIdentity) -> ProcessInspection {
    ProcessInspection::Unknown
}

#[cfg(windows)]
pub fn terminate_verified(identity: &ProcessIdentity) -> ProcessTermination {
    windows_impl::terminate_verified(identity)
}

#[cfg(not(windows))]
pub fn terminate_verified(_identity: &ProcessIdentity) -> ProcessTermination {
    ProcessTermination::Unknown
}
