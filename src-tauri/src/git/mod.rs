//! Git subsystem: repository validation, worktree lifecycle, status/diff,
//! commit, and merge — the backend half of v0.3/v0.4. All filesystem- and
//! process-sensitive work happens here; the frontend only ever sees
//! serializable request/response structs via `commands.rs`.

pub mod commands;
pub mod commit;
pub mod diff;
pub mod error;
pub mod merge;
pub mod paths;
pub mod process;
pub mod repo;
pub mod status;
pub mod worktree;

#[cfg(test)]
mod workflow_tests;
