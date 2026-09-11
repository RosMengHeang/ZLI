use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionStatus {
    Starting,
    Running,
    Paused,
    Exited,
    Error,
    Stopped,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AttentionStatus {
    Working,
    WaitingForYou,
    Completed,
    Failed,
    Paused,
    Offline,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentEventSource {
    Runtime,
    Provider,
    Pty,
    Taxchat,
    Browser,
    User,
    Api,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentEventKind {
    AgentCreated,
    AgentStarted,
    AgentOutput,
    AgentPromptDetected,
    AgentWaiting,
    AgentMessageReceived,
    AgentMessageQueued,
    AgentMessageDelivered,
    AgentMessageFailed,
    AgentFocusRequested,
    AgentCompleted,
    AgentFailed,
    AgentPaused,
    AgentStopped,
    AgentExited,
    AgentResumeAvailable,
    AgentResumeUnavailable,
    AgentWorktreeCreated,
    AgentWorktreeCleanupFailed,
    BrowserSurfaceCreated,
    BrowserNavigationChanged,
    BrowserConsoleError,
    BrowserCommandStarted,
    BrowserCommandCompleted,
    BrowserCommandFailed,
    TaxchatRoomStarted,
    TaxchatMessageQueued,
    TaxchatMessageDelivered,
    TaxchatMessageSent,
    TaxchatMessageFailed,
    AttentionAck,
    AttentionMarkAllRead,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case", tag = "type")]
pub enum AgentEventPayload {
    Empty,
    Text {
        text: String,
    },
    Exit {
        code: Option<i32>,
    },
    Attention {
        reason: String,
    },
    Message {
        #[serde(rename = "messageId")]
        message_id: String,
    },
    Taxchat {
        #[serde(rename = "messageId")]
        message_id: String,
        body: String,
        #[serde(rename = "recipientIds")]
        recipient_ids: Vec<String>,
        #[serde(rename = "queuedIds")]
        queued_ids: Vec<String>,
        #[serde(rename = "deliveredIds")]
        delivered_ids: Vec<String>,
        #[serde(rename = "failedIds")]
        failed_ids: Vec<String>,
    },
    Agent {
        name: String,
        #[serde(rename = "providerId")]
        provider_id: String,
        #[serde(rename = "terminalId")]
        terminal_id: String,
        branch: String,
        #[serde(rename = "worktreePath")]
        worktree_path: String,
        paused: bool,
    },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventEnvelope {
    pub schema_version: u16,
    pub sequence: u64,
    pub event_id: String,
    pub project_id: String,
    pub agent_id: Option<String>,
    pub parent_agent_id: Option<String>,
    pub timestamp: String,
    pub source: AgentEventSource,
    pub kind: AgentEventKind,
    pub payload: AgentEventPayload,
}

impl AgentEventEnvelope {
    pub fn new(
        event_id: String,
        project_id: String,
        agent_id: Option<String>,
        kind: AgentEventKind,
        payload: AgentEventPayload,
    ) -> Self {
        Self {
            schema_version: 1,
            sequence: 0,
            event_id,
            project_id,
            agent_id,
            parent_agent_id: None,
            timestamp: utc_rfc3339_now(),
            source: AgentEventSource::Runtime,
            kind,
            payload,
        }
    }
}

pub(crate) fn utc_rfc3339_now() -> String {
    let seconds = i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock must be after the Unix epoch")
            .as_secs(),
    )
    .expect("system clock timestamp must fit in i64");
    let days = seconds.div_euclid(86_400);
    let seconds_of_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_date_from_days(days);
    let hour = seconds_of_day / 3_600;
    let minute = (seconds_of_day % 3_600) / 60;
    let second = seconds_of_day % 60;

    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

fn civil_date_from_days(days_since_epoch: i64) -> (i64, i64, i64) {
    let days = days_since_epoch + 719_468;
    let era = if days >= 0 { days } else { days - 146_096 } / 146_097;
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    (year, month, day)
}
