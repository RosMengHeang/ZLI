//! Safe invocation of the `git` CLI: argument arrays only, never a shell
//! string, so nothing under `src-tauri/src/git` builds or runs a shell
//! command from frontend-supplied text.

use super::error::{sanitize_output, GitError};
use std::path::Path;
use std::process::Command;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub struct GitOutput {
    pub stdout: String,
}

impl GitOutput {
    pub fn stdout_trimmed(&self) -> &str {
        self.stdout.trim()
    }
}

/// Run `git <args>` with `cwd` as the working directory. Returns an error if
/// git cannot be spawned or exits with a non-zero status.
pub fn run_git(cwd: &Path, args: &[&str]) -> Result<GitOutput, GitError> {
    let mut cmd = Command::new("git");
    cmd.args(args).current_dir(cwd);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = cmd.output().map_err(|e| GitError::GitCommandFailed {
        command: format_command(args),
        message: format!("failed to launch git: {e}"),
    })?;

    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();

    if !output.status.success() {
        let raw = if !stderr.trim().is_empty() {
            &stderr
        } else {
            &stdout
        };
        return Err(GitError::GitCommandFailed {
            command: format_command(args),
            message: sanitize_output(raw),
        });
    }

    Ok(GitOutput { stdout })
}

/// Same as [`run_git`] but does not treat a non-zero exit as an error —
/// useful for probing commands like `rev-parse --verify` where "not found"
/// is an expected, non-exceptional outcome.
pub fn run_git_probe(cwd: &Path, args: &[&str]) -> (bool, GitOutput) {
    let mut cmd = Command::new("git");
    cmd.args(args).current_dir(cwd);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    match cmd.output() {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
            (output.status.success(), GitOutput { stdout })
        }
        Err(_) => (
            false,
            GitOutput {
                stdout: String::new(),
            },
        ),
    }
}

fn format_command(args: &[&str]) -> String {
    format!("git {}", args.join(" "))
}
