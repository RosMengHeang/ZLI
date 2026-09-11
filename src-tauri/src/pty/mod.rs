mod manager;

pub use manager::{
    EventSink, PtyManager, TerminalOutputEvent, TerminalSession, TerminalStatus,
    TerminalStatusEvent,
};

#[cfg(test)]
pub use manager::MemoryEventSink;

#[cfg(test)]
mod tests {
    use super::{MemoryEventSink, PtyManager, TerminalStatus};
    use std::fs;
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
            .any(|event| event.terminal_id == terminal_a.id && event.status == super::TerminalStatus::Killed));
        assert!(sink_b
            .statuses()
            .iter()
            .any(|event| event.terminal_id == terminal_b.id && event.status == super::TerminalStatus::Killed));

        manager.shutdown().unwrap();
        assert_eq!(manager.session_count(), 0);
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
            .create_shell(
                Some(directory.path().to_string_lossy().as_ref()),
                sink,
            )
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
