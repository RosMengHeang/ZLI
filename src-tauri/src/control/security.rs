use super::{CallerIdentity, ControlError, ControlErrorCode};
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fmt;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Opaque handle to one issued credential. Revocable without the plaintext.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct CredentialHandle([u8; 32]);

impl fmt::Debug for CredentialHandle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("CredentialHandle(..)")
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IssuedCapabilityToken {
    pub token: String,
    pub expires_at: u64,
    pub handle: CredentialHandle,
}

#[derive(Clone, Debug)]
struct TokenRecord {
    identity: CallerIdentity,
    expires_at: SystemTime,
    lease: Duration,
}

#[derive(Debug, Default)]
pub struct CapabilityTokenStore {
    records: Mutex<HashMap<[u8; 32], TokenRecord>>,
}

impl CapabilityTokenStore {
    pub fn issue(&self, mut identity: CallerIdentity, lease: Duration) -> IssuedCapabilityToken {
        let mut bytes = [0_u8; 32];
        rand::thread_rng().fill_bytes(&mut bytes);
        let token = bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let expires_at = SystemTime::now() + lease;
        let unix_expiry = unix_secs(expires_at);
        identity.expires_at = Some(unix_expiry);
        let handle = CredentialHandle(hash_token(&token));
        self.records
            .lock()
            .expect("capability token store poisoned")
            .insert(
                handle.0,
                TokenRecord {
                    identity,
                    expires_at,
                    lease,
                },
            );
        IssuedCapabilityToken {
            token,
            expires_at: unix_expiry,
            handle,
        }
    }

    pub fn verify(&self, token: &str) -> Result<CallerIdentity, ControlError> {
        let key = hash_token(token);
        let mut records = self.records.lock().map_err(|_| {
            ControlError::new(
                ControlErrorCode::ControlRuntimeError,
                "Token store is unavailable",
            )
        })?;
        let Some(record) = records.get_mut(&key) else {
            return Err(denied());
        };
        let now = SystemTime::now();
        if record.expires_at <= now {
            records.remove(&key);
            return Err(denied());
        }
        record.expires_at = now + record.lease;
        record.identity.expires_at = Some(unix_secs(record.expires_at));
        Ok(record.identity.clone())
    }

    pub fn revoke(&self, token: &str) {
        self.revoke_handle(CredentialHandle(hash_token(token)));
    }

    pub fn revoke_handle(&self, handle: CredentialHandle) -> bool {
        self.records
            .lock()
            .map(|mut records| records.remove(&handle.0).is_some())
            .unwrap_or(false)
    }

    pub fn revoke_agent(&self, agent_id: &str) -> usize {
        let Ok(mut records) = self.records.lock() else {
            return 0;
        };
        let before = records.len();
        records.retain(|_, record| record.identity.agent_id.as_deref() != Some(agent_id));
        before - records.len()
    }

    pub fn revoke_agent_except(&self, agent_id: &str, keep: CredentialHandle) -> usize {
        let Ok(mut records) = self.records.lock() else {
            return 0;
        };
        let before = records.len();
        records.retain(|key, record| {
            record.identity.agent_id.as_deref() != Some(agent_id) || *key == keep.0
        });
        before - records.len()
    }

    pub fn touch_agent(&self, agent_id: &str, lease: Duration) -> usize {
        let Ok(mut records) = self.records.lock() else {
            return 0;
        };
        let now = SystemTime::now();
        let mut touched = 0;
        for record in records.values_mut() {
            if record.identity.agent_id.as_deref() != Some(agent_id) || record.expires_at <= now {
                continue;
            }
            record.expires_at = now + lease;
            record.identity.expires_at = Some(unix_secs(record.expires_at));
            touched += 1;
        }
        touched
    }
}

fn hash_token(token: &str) -> [u8; 32] {
    Sha256::digest(token.as_bytes()).into()
}

fn unix_secs(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

fn denied() -> ControlError {
    ControlError::new(
        ControlErrorCode::CapabilityDenied,
        "Control token is invalid or expired",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::control::Capability;

    fn agent_identity(agent_id: &str) -> CallerIdentity {
        CallerIdentity {
            caller_id: agent_id.to_owned(),
            project_id: "project-1".to_owned(),
            agent_id: Some(agent_id.to_owned()),
            parent_agent_id: None,
            capabilities: vec![Capability::AgentRead],
            expires_at: None,
        }
    }

    #[test]
    fn revoke_agent_invalidates_the_token_without_the_plaintext() {
        let store = CapabilityTokenStore::default();
        let issued = store.issue(agent_identity("agent-a"), Duration::from_secs(60));
        let token = issued.token.clone();
        assert_eq!(store.revoke_agent("agent-a"), 1);
        assert_eq!(
            store.verify(&token).expect_err("revoked without plaintext").code,
            "CAPABILITY_DENIED"
        );
        assert_eq!(store.revoke_agent("agent-a"), 0);
    }

    #[test]
    fn reissue_then_revoke_agent_except_leaves_only_the_keep_handle_valid() {
        let store = CapabilityTokenStore::default();
        let first = store.issue(agent_identity("agent-a"), Duration::from_secs(60));
        let second = store.issue(agent_identity("agent-a"), Duration::from_secs(60));
        let other = store.issue(agent_identity("agent-b"), Duration::from_secs(60));

        assert_eq!(store.revoke_agent_except("agent-a", second.handle), 1);
        assert_eq!(
            store
                .verify(&first.token)
                .expect_err("superseded generation")
                .code,
            "CAPABILITY_DENIED"
        );
        store
            .verify(&second.token)
            .expect("keep handle must remain valid");
        store
            .verify(&other.token)
            .expect("other agents must be untouched");
    }

    #[test]
    fn verify_slides_expiry_forward_for_a_used_token() {
        let store = CapabilityTokenStore::default();
        let issued = store.issue(agent_identity("agent-a"), Duration::from_millis(250));
        std::thread::sleep(Duration::from_millis(120));
        store
            .verify(&issued.token)
            .expect("token still valid before original idle window");
        std::thread::sleep(Duration::from_millis(200));
        store
            .verify(&issued.token)
            .expect("verify must slide expiry forward for a used token");
        assert_eq!(format!("{:?}", issued.handle), "CredentialHandle(..)");
        assert!(!format!("{:?}", issued.handle).contains(&issued.token));
    }
}
