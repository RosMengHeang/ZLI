//! `git status` in structured form, with best-effort per-file line counts.

use super::error::GitError;
use super::paths::canonical_dir;
use super::process::run_git;
use super::repo::{current_branch, is_clean};
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    Untracked,
    TypeChanged,
    Unmerged,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    /// Present only for renames/copies.
    pub original_path: Option<String>,
    pub status: FileStatus,
    pub staged: bool,
    /// `None` when line counts aren't practical to compute (binary files,
    /// or the numstat lookup failed).
    pub additions: Option<u32>,
    pub deletions: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub branch: Option<String>,
    pub clean: bool,
    pub changed_files: Vec<ChangedFile>,
    pub additions: u32,
    pub deletions: u32,
}

pub fn get_status(worktree_path: &str) -> Result<GitStatus, GitError> {
    let dir = canonical_dir(worktree_path)?;
    ensure_is_repo(&dir, worktree_path)?;

    let (branch, _detached) = current_branch(&dir);
    let mut changed_files = parse_porcelain(&dir)?;

    let numstat = collect_numstat(&dir);
    for file in &mut changed_files {
        if file.status == FileStatus::Untracked {
            if let Some((add, del)) = untracked_numstat(&dir, &file.path) {
                file.additions = Some(add);
                file.deletions = Some(del);
            }
            continue;
        }
        let key = file.original_path.as_deref().unwrap_or(&file.path);
        if let Some((add, del)) = numstat.get(key).or_else(|| numstat.get(file.path.as_str())) {
            file.additions = Some(*add);
            file.deletions = Some(*del);
        }
    }

    let additions = changed_files.iter().filter_map(|f| f.additions).sum();
    let deletions = changed_files.iter().filter_map(|f| f.deletions).sum();
    let clean = changed_files.is_empty();
    debug_assert_eq!(clean, is_clean(&dir).unwrap_or(clean));

    Ok(GitStatus {
        branch,
        clean,
        changed_files,
        additions,
        deletions,
    })
}

fn ensure_is_repo(dir: &Path, original: &str) -> Result<(), GitError> {
    run_git(dir, &["rev-parse", "--is-inside-work-tree"]).map_err(|_| {
        GitError::NotGitRepository {
            path: original.to_string(),
        }
    })?;
    Ok(())
}

/// Parse `git status --porcelain=v1 -z` (null-separated, stable across
/// locales, handles filenames with spaces/unicode without quoting games).
fn parse_porcelain(dir: &Path) -> Result<Vec<ChangedFile>, GitError> {
    let out = run_git(dir, &["status", "--porcelain=v1", "-z"])?;
    let mut entries: Vec<&str> = out.stdout.split('\0').filter(|s| !s.is_empty()).collect();
    entries.reverse(); // pop() from the front in original order
    let mut result = Vec::new();

    while let Some(entry) = entries.pop() {
        if entry.len() < 3 {
            continue;
        }
        let mut chars = entry.chars();
        let x = chars.next().unwrap_or(' ');
        let y = chars.next().unwrap_or(' ');
        let rest = &entry[2..];
        let path = rest.strip_prefix(' ').unwrap_or(rest);

        if x == '?' && y == '?' {
            result.push(ChangedFile {
                path: path.to_string(),
                original_path: None,
                status: FileStatus::Untracked,
                staged: false,
                additions: None,
                deletions: None,
            });
            continue;
        }
        if x == 'U' || y == 'U' || (x == 'A' && y == 'A') || (x == 'D' && y == 'D') {
            result.push(ChangedFile {
                path: path.to_string(),
                original_path: None,
                status: FileStatus::Unmerged,
                staged: false,
                additions: None,
                deletions: None,
            });
            continue;
        }

        // Renames/copies consume an extra NUL-separated "original path" field.
        if x == 'R' || x == 'C' || y == 'R' || y == 'C' {
            let original_path = entries.pop().map(|s| s.to_string());
            let status = if x == 'C' || y == 'C' {
                FileStatus::Copied
            } else {
                FileStatus::Renamed
            };
            let staged = x != ' ' && x != '?';
            result.push(ChangedFile {
                path: path.to_string(),
                original_path,
                status,
                staged,
                additions: None,
                deletions: None,
            });
            continue;
        }

        // Prefer the staged (index) status code when both index and worktree
        // changed the same file; otherwise fall back to the worktree code.
        let (code, staged) = if x != ' ' { (x, true) } else { (y, false) };
        let status = match code {
            'A' => FileStatus::Added,
            'D' => FileStatus::Deleted,
            'T' => FileStatus::TypeChanged,
            _ => FileStatus::Modified,
        };
        result.push(ChangedFile {
            path: path.to_string(),
            original_path: None,
            status,
            staged,
            additions: None,
            deletions: None,
        });
    }

    Ok(result)
}

/// Combine `git diff --numstat` (working tree vs index) and `git diff
/// --cached --numstat` (index vs HEAD) into one path -> (additions,
/// deletions) map. Binary files report "-" for both counts and are skipped
/// (left as `None` on the caller's [`ChangedFile`]).
fn collect_numstat(dir: &Path) -> HashMap<String, (u32, u32)> {
    let mut map = HashMap::new();
    for args in [
        vec!["diff", "--numstat", "-z"],
        vec!["diff", "--cached", "--numstat", "-z"],
    ] {
        if let Ok(out) = run_git(dir, &args) {
            merge_numstat(&out.stdout, &mut map);
        }
    }
    map
}

fn merge_numstat(raw: &str, map: &mut HashMap<String, (u32, u32)>) {
    let fields: Vec<&str> = raw.split('\0').filter(|s| !s.is_empty()).collect();
    let mut i = 0;
    while i < fields.len() {
        let line = fields[i];
        let mut parts = line.splitn(3, '\t');
        let add = parts.next().unwrap_or("0");
        let del = parts.next().unwrap_or("0");
        let path_field = parts.next();
        i += 1;
        let path = match path_field {
            Some(p) if !p.is_empty() => p.to_string(),
            _ => {
                // Rename: numstat emits an empty third field, then old-path,
                // then new-path as separate NUL-terminated records.
                let new_path = fields.get(i + 1).map(|s| s.to_string());
                i += 2;
                match new_path {
                    Some(p) => p,
                    None => continue,
                }
            }
        };
        if let (Ok(a), Ok(d)) = (add.parse::<u32>(), del.parse::<u32>()) {
            map.insert(path, (a, d));
        }
    }
}

/// Best-effort insertion count for an untracked file via `git diff --no-index`
/// against the OS null device. Returns `None` for binary files or if the
/// probe fails for any reason — callers treat that as "not available".
fn untracked_numstat(dir: &Path, rel_path: &str) -> Option<(u32, u32)> {
    let null_device = if cfg!(windows) { "NUL" } else { "/dev/null" };
    let out = run_git(
        dir,
        &["diff", "--no-index", "--numstat", null_device, rel_path],
    );
    // --no-index intentionally exits 1 when a diff exists, which run_git
    // treats as failure; re-run manually via the probe helper semantics.
    let stdout = match out {
        Ok(o) => o.stdout,
        Err(GitError::GitCommandFailed { .. }) => {
            let (_, probe) = super::process::run_git_probe(
                dir,
                &["diff", "--no-index", "--numstat", null_device, rel_path],
            );
            probe.stdout
        }
        Err(_) => return None,
    };
    let line = stdout.lines().next()?;
    let mut parts = line.splitn(3, '\t');
    let add = parts.next()?.parse::<u32>().ok()?;
    let del = parts.next()?.parse::<u32>().ok()?;
    Some((add, del))
}
