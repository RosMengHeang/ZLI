use crate::error::BackendError;
use std::env;
#[cfg(windows)]
use std::ffi::OsString;
use std::path::{Path, PathBuf};

pub fn shell_candidates(is_windows: bool) -> Vec<&'static str> {
    if is_windows {
        vec!["pwsh", "powershell.exe", "cmd.exe"]
    } else {
        vec!["/bin/sh"]
    }
}

pub fn find_executable(candidates: &[&str]) -> Option<PathBuf> {
    let path_var = env::var_os("PATH")?;
    let path_entries: Vec<PathBuf> = env::split_paths(&path_var).collect();

    for candidate in candidates {
        let candidate_path = Path::new(candidate);
        if candidate_path.is_absolute() {
            if is_executable_file(candidate_path) {
                return Some(candidate_path.to_path_buf());
            }
            continue;
        }

        for directory in &path_entries {
            let direct = directory.join(candidate);
            #[cfg(windows)]
            if Path::new(candidate).extension().is_none() {
                if let Some(path) = find_with_pathext(directory, candidate) {
                    return Some(path);
                }
            }

            #[cfg(not(windows))]
            if is_executable_file(&direct) {
                return Some(direct);
            }

            #[cfg(windows)]
            if Path::new(candidate).extension().is_some() && is_executable_file(&direct) {
                return Some(direct);
            }
        }
    }
    None
}

#[cfg(windows)]
fn find_with_pathext(directory: &Path, candidate: &str) -> Option<PathBuf> {
    let extensions =
        env::var_os("PATHEXT").unwrap_or_else(|| OsString::from(".COM;.EXE;.BAT;.CMD"));
    let mut extension_values: Vec<String> = extensions
        .to_string_lossy()
        .split(';')
        .map(str::to_owned)
        .collect();
    if !extension_values
        .iter()
        .any(|extension| extension.eq_ignore_ascii_case(".PS1"))
    {
        extension_values.push(".PS1".to_owned());
    }
    for extension in extension_values {
        let path = directory.join(format!("{candidate}{extension}"));
        if is_executable_file(&path) {
            return Some(path);
        }
    }
    None
}

fn is_executable_file(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        return path
            .metadata()
            .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
            .unwrap_or(false);
    }
    #[cfg(not(unix))]
    {
        true
    }
}

pub fn detect_shell() -> Result<PathBuf, BackendError> {
    if cfg!(windows) {
        find_executable(&shell_candidates(true)).ok_or_else(|| {
            BackendError::ExecutableNotFound("pwsh, powershell.exe, or cmd.exe".into())
        })
    } else if let Some(shell) = env::var_os("SHELL") {
        let shell_text = shell.to_string_lossy();
        if let Some(path) = find_executable(&[shell_text.as_ref()]) {
            return Ok(path);
        }
        let shell_path = PathBuf::from(&shell);
        if is_executable_file(&shell_path) {
            return Ok(shell_path);
        }
        find_executable(&["/bin/sh", "sh"])
            .ok_or_else(|| BackendError::ExecutableNotFound("$SHELL or /bin/sh".into()))
    } else {
        find_executable(&["/bin/sh", "sh"])
            .ok_or_else(|| BackendError::ExecutableNotFound("/bin/sh".into()))
    }
}

pub fn detect_powershell() -> Result<PathBuf, BackendError> {
    find_executable(&["pwsh", "powershell.exe"])
        .ok_or_else(|| BackendError::ExecutableNotFound("pwsh or powershell.exe".into()))
}

pub fn default_cwd(requested: Option<&str>) -> Result<PathBuf, BackendError> {
    let path = match requested {
        Some(value) if !value.trim().is_empty() => PathBuf::from(value),
        _ => env::current_dir()?,
    };
    if !path.is_dir() {
        return Err(BackendError::InvalidWorkingDirectory(
            path.to_string_lossy().into_owned(),
        ));
    }
    dunce::canonicalize(&path).map_err(|error| {
        BackendError::InvalidWorkingDirectory(format!("{} ({error})", path.display()))
    })
}

#[cfg(test)]
mod tests {
    use super::shell_candidates;

    #[test]
    fn shell_candidates_prioritize_powershell_variants_on_windows() {
        assert_eq!(
            shell_candidates(true),
            vec!["pwsh", "powershell.exe", "cmd.exe"]
        );
    }

    #[test]
    fn shell_candidates_use_posix_fallback() {
        assert_eq!(shell_candidates(false), vec!["/bin/sh"]);
    }
}
