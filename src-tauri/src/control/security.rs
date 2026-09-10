use super::{CallerIdentity, ControlError, ControlErrorCode};
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IssuedCapabilityToken {
    pub token: String,
    pub expires_at: u64,
}

#[derive(Clone, Debug)]
struct TokenRecord {
    identity: CallerIdentity,
    expires_at: SystemTime,
}

#[derive(Debug, Default)]
pub struct CapabilityTokenStore {
    records: Mutex<HashMap<[u8; 32], TokenRecord>>,
}

impl CapabilityTokenStore {
    pub fn issue(&self, mut identity: CallerIdentity, lifetime: Duration) -> IssuedCapabilityToken {
        let mut bytes = [0_u8; 32];
        rand::thread_rng().fill_bytes(&mut bytes);
        let token = bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let expires_at = SystemTime::now() + lifetime;
        let unix_expiry = expires_at
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        identity.expires_at = Some(unix_expiry);
        self.records
            .lock()
            .expect("capability token store poisoned")
            .insert(
                hash_token(&token),
                TokenRecord {
                    identity,
                    expires_at,
                },
            );
        IssuedCapabilityToken {
            token,
            expires_at: unix_expiry,
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
        let Some(record) = records.get(&key) else {
            return Err(denied());
        };
        if record.expires_at <= SystemTime::now() {
            records.remove(&key);
            return Err(denied());
        }
        Ok(record.identity.clone())
    }

    pub fn revoke(&self, token: &str) {
        if let Ok(mut records) = self.records.lock() {
            records.remove(&hash_token(token));
        }
    }
}

fn hash_token(token: &str) -> [u8; 32] {
    Sha256::digest(token.as_bytes()).into()
}

fn denied() -> ControlError {
    ControlError::new(
        ControlErrorCode::CapabilityDenied,
        "Control token is invalid or expired",
    )
}
