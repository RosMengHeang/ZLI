mod manager;
mod process;

pub use manager::{
    EventSink, PtyManager, TerminalOutputEvent, TerminalSession, TerminalStatus,
    TerminalStatusEvent,
};
#[cfg(test)]
pub(crate) use process::capture as capture_process;
pub(crate) use process::{inspect as inspect_process, terminate_verified as terminate_process};
pub use process::{ProcessIdentity, ProcessInspection, ProcessTermination};

#[cfg(test)]
pub use manager::MemoryEventSink;

#[cfg(test)]
mod tests {
    use super::{MemoryEventSink, PtyManager, TerminalStatus};
    use std::fs;
    #[cfg(windows)]
    use std::process::Command;
    use std::time::{Duration, Instant};
    use tempfile::tempdir;

    #[test]
    fn manager_starts_with_no_sessions() {
        let manager = PtyManager::new();
        assert_eq!(manager.session_count(), 0);
        let _sink = MemoryEventSink::default();
    }

    #[test]
    fn shutdown_terminates_all_owned_sessions_and_is_idempotent() {
        let directory = tempdir().unwrap();
        let manager = PtyManager::new();
        let sink_a = MemoryEventSink::default();
        let sink_b = MemoryEventSink::default();
        let terminal_a = manager
            .create_shell(
                Some(directory.path().to_string_lossy().as_ref()),
                sink_a.clone(),
            )
            .unwrap();
        let terminal_b = manager
            .create_shell(
                Some(directory.path().to_string_lossy().as_ref()),
                sink_b.clone(),
            )
            .unwrap();

        manager.shutdown().unwrap();

        assert_eq!(manager.session_count(), 0);
        assert!(sink_a
            .statuses()
            .iter()
            .any(|event| event.terminal_id == terminal_a.id
                && event.status == super::TerminalStatus::Killed));
        assert!(sink_b
            .statuses()
            .iter()
            .any(|event| event.terminal_id == terminal_b.id
                && event.status == super::TerminalStatus::Killed));

        manager.shutdown().unwrap();
        assert_eq!(manager.session_count(), 0);
    }

    #[test]
    fn killing_an_already_removed_session_is_idempotent() {
        let directory = tempdir().unwrap();
        let manager = PtyManager::new();
        let terminal = manager
            .create_shell(
                Some(directory.path().to_string_lossy().as_ref()),
                MemoryEventSink::default(),
            )
            .unwrap();

        manager.kill(&terminal.id).unwrap();
        manager
            .kill(&terminal.id)
            .expect("repeated cleanup should be a no-op");
    }

    #[test]
    fn two_sessions_are_independent_and_git_status_runs_in_a_real_pty() {
        let directory = tempdir().unwrap();
        let manager = PtyManager::new();
        let sink_a = MemoryEventSink::default();
        let sink_b = MemoryEventSink::default();

        let terminal_a = manager
            .create_shell(
                Some(directory.path().to_string_lossy().as_ref()),
                sink_a.clone(),
            )
            .unwrap();
        let terminal_b = manager
            .create_shell(
                Some(directory.path().to_string_lossy().as_ref()),
                sink_b.clone(),
            )
            .unwrap();

        let marker_a = "PTY_SESSION_A_MARKER";
        let marker_b = "PTY_SESSION_B_MARKER";
        manager
            .write(&terminal_a.id, &format!("echo {marker_a}\r\n"))
            .unwrap();
        manager
            .write(&terminal_b.id, &format!("echo {marker_b}\r\n"))
            .unwrap();

        assert!(wait_for_marker(&sink_a, &terminal_a.id, marker_a));
        assert!(wait_for_marker(&sink_b, &terminal_b.id, marker_b));
        assert!(!sink_a.contains(&terminal_a.id, marker_b));
        assert!(!sink_b.contains(&terminal_b.id, marker_a));

        manager.resize(&terminal_a.id, 100, 30).unwrap();
        assert_eq!(manager.session_size(&terminal_a.id).unwrap(), (100, 30));
        assert_eq!(manager.session_size(&terminal_b.id).unwrap(), (120, 30));
        manager.kill(&terminal_a.id).unwrap();
        assert_eq!(manager.session_count(), 1);

        let marker_b_after_kill = "PTY_SESSION_B_AFTER_KILL";
        manager
            .write(&terminal_b.id, &format!("echo {marker_b_after_kill}\r\n"))
            .unwrap();
        assert!(wait_for_marker(
            &sink_b,
            &terminal_b.id,
            marker_b_after_kill
        ));

        let git_marker = "PTY_GIT_STATUS_COMPLETE";
        manager
            .write(
                &terminal_b.id,
                &format!("git status --short\r\necho {git_marker}\r\n"),
            )
            .unwrap();
        assert!(wait_for_marker(&sink_b, &terminal_b.id, git_marker));

        manager.kill(&terminal_b.id).unwrap();
    }

    #[test]
    fn identifies_running_sessions_by_their_canonical_working_directory() {
        let directory = tempdir().unwrap();
        let manager = PtyManager::new();
        let sink = MemoryEventSink::default();
        let terminal = manager
            .create_shell(Some(directory.path().to_string_lossy().as_ref()), sink)
            .unwrap();
        let canonical = dunce::canonicalize(directory.path()).unwrap();

        assert_eq!(
            manager.running_session_at(&canonical).unwrap(),
            Some(terminal.id.clone())
        );

        manager.kill(&terminal.id).unwrap();
        assert_eq!(manager.running_session_at(&canonical).unwrap(), None);
    }

    #[cfg(windows)]
    #[test]
    fn natural_shell_exit_preserves_the_child_exit_code() {
        let directory = tempdir().unwrap();
        let manager = PtyManager::new();
        let sink = MemoryEventSink::default();
        let terminal = manager
            .spawn_agent_with_size_args(
                crate::system::find_executable(&["cmd.exe"]).expect("cmd.exe"),
                vec!["/C".into(), "exit".into(), "42".into()],
                Some(directory.path().to_string_lossy().as_ref()),
                120,
                30,
                std::sync::Arc::new(sink.clone()),
            )
            .unwrap();

        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline
            && !sink.statuses().iter().any(|event| {
                event.terminal_id == terminal.id && event.status == TerminalStatus::Exited
            })
        {
            std::thread::sleep(Duration::from_millis(20));
        }

        let exited = sink
            .statuses()
            .into_iter()
            .find(|event| {
                event.terminal_id == terminal.id && event.status == TerminalStatus::Exited
            })
            .expect("natural exit event");
        assert_eq!(exited.exit_code, Some(42));
    }

    #[cfg(windows)]
    #[test]
    fn owned_terminal_exposes_process_identity() {
        let directory = tempdir().unwrap();
        let manager = PtyManager::new();
        let terminal = manager
            .spawn_agent_with_size_args(
                crate::system::find_executable(&["cmd.exe"]).expect("cmd.exe"),
                vec![
                    "/C".into(),
                    "timeout".into(),
                    "/T".into(),
                    "5".into(),
                    "/NOBREAK".into(),
                    ">NUL".into(),
                ],
                Some(directory.path().to_string_lossy().as_ref()),
                120,
                30,
                std::sync::Arc::new(MemoryEventSink::default()),
            )
            .unwrap();

        let identity = manager
            .process_identity(&terminal.id)
            .unwrap()
            .expect("live terminal identity");
        assert!(identity.pid > 0);
        assert!(identity.start_time > 0);
        assert!(identity
            .executable
            .to_ascii_lowercase()
            .ends_with("cmd.exe"));

        manager
            .kill(&terminal.id)
            .expect("kill identity test shell");
    }

    #[cfg(windows)]
    #[test]
    fn killing_terminal_terminates_provider_descendants() {
        let directory = tempdir().unwrap();
        let child_pid_file = directory.path().join("child.pid");
        let child_pid_path = child_pid_file.to_string_lossy().replace('\'', "''");
        let script = format!(
            "$child = Start-Process -FilePath $env:ComSpec -ArgumentList @('/c', 'ping 127.0.0.1 -n 30 127.0.0.1') -PassThru; Set-Content -LiteralPath '{child_pid_path}' -Value $child.Id; Wait-Process -Id $child.Id"
        );
        let manager = PtyManager::new();
        let terminal = manager
            .spawn_agent_with_size_args(
                crate::system::find_executable(&["powershell.exe"]).expect("powershell.exe"),
                vec!["-NoProfile".into(), "-Command".into(), script.into()],
                Some(directory.path().to_string_lossy().as_ref()),
                120,
                30,
                std::sync::Arc::new(MemoryEventSink::default()),
            )
            .unwrap();

        let deadline = Instant::now() + Duration::from_secs(5);
        let child_pid = loop {
            if let Ok(value) = fs::read_to_string(&child_pid_file) {
                if let Ok(pid) = value.trim().parse::<u32>() {
                    break pid;
                }
            }
            assert!(
                Instant::now() < deadline,
                "provider descendant did not start"
            );
            std::thread::sleep(Duration::from_millis(25));
        };
        assert!(windows_process_exists(child_pid));

        manager.kill(&terminal.id).expect("kill terminal tree");

        let deadline = Instant::now() + Duration::from_secs(5);
        while windows_process_exists(child_pid) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(25));
        }
        if windows_process_exists(child_pid) {
            let _ = Command::new("taskkill")
                .args(["/PID", &child_pid.to_string(), "/T", "/F"])
                .output();
        }
        assert!(
            !windows_process_exists(child_pid),
            "provider descendant survived terminal kill"
        );
    }

    #[cfg(unix)]
    #[test]
    fn killing_terminal_terminates_provider_process_group() {
        let directory = tempdir().unwrap();
        let child_pid_file = directory.path().join("child.pid");
        let manager = PtyManager::new();
        let terminal = manager
            .spawn_agent_with_size_args(
                crate::system::find_executable(&["/bin/sh"]).expect("/bin/sh"),
                vec![
                    "-c".into(),
                    "sleep 30 & child=$!; printf '%s' \"$child\" > \"$1\"; wait \"$child\"".into(),
                    "zli-process-group-test".into(),
                    child_pid_file.as_os_str().to_owned(),
                ],
                Some(directory.path().to_string_lossy().as_ref()),
                120,
                30,
                std::sync::Arc::new(MemoryEventSink::default()),
            )
            .unwrap();

        let deadline = Instant::now() + Duration::from_secs(5);
        let child_pid = loop {
            if let Ok(value) = fs::read_to_string(&child_pid_file) {
                if let Ok(pid) = value.trim().parse::<u32>() {
                    break pid;
                }
            }
            assert!(
                Instant::now() < deadline,
                "provider descendant did not start"
            );
            std::thread::sleep(Duration::from_millis(25));
        };
        assert!(unix_process_exists(child_pid));

        manager
            .kill(&terminal.id)
            .expect("kill terminal process group");

        let deadline = Instant::now() + Duration::from_secs(5);
        while unix_process_exists(child_pid) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(25));
        }
        assert!(
            !unix_process_exists(child_pid),
            "provider descendant survived terminal kill"
        );
    }

    #[cfg(windows)]
    fn windows_process_exists(pid: u32) -> bool {
        let output = Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .expect("tasklist");
        String::from_utf8_lossy(&output.stdout)
            .split_whitespace()
            .any(|token| token == pid.to_string())
    }

    #[cfg(unix)]
    fn unix_process_exists(pid: u32) -> bool {
        let Ok(pid) = libc::pid_t::try_from(pid) else {
            return false;
        };
        unsafe { libc::kill(pid, 0) == 0 }
        || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }

    #[test]
    fn shell_session_supports_spaces_and_unicode_in_cwd() {
        let directory = tempdir().unwrap();
        let nested = directory.path().join("folder with spaces-ユニコード");
        fs::create_dir_all(&nested).unwrap();
        let manager = PtyManager::new();
        let sink = MemoryEventSink::default();
        let terminal = manager
            .create_shell(Some(nested.to_string_lossy().as_ref()), sink.clone())
            .unwrap();
        let marker = "PTY_UNICODE_CWD_MARKER";
        manager
            .write(&terminal.id, &format!("echo {marker}\r\n"))
            .unwrap();
        assert!(wait_for_marker(&sink, &terminal.id, marker));
        manager.kill(&terminal.id).unwrap();
    }

    fn wait_for_marker(sink: &MemoryEventSink, id: &str, marker: &str) -> bool {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if sink.contains(id, marker) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }
}
