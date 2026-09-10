use serde::Serialize;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileReport {
    pub offline_session_ids: Vec<String>,
    pub retained_missing_worktrees: Vec<String>,
    pub stopped_owned_process_ids: Vec<String>,
}
