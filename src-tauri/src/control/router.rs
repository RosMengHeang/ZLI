use super::{
    CallerIdentity, Capability, ControlError, ControlErrorCode, ControlMethod, ControlRequest,
    ControlResponse,
};
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

const MAX_IDEMPOTENCY_ENTRIES: usize = 1024;

pub trait ControlHandler: Send + Sync {
    fn handle(
        &self,
        request: &ControlRequest,
        identity: &CallerIdentity,
    ) -> Result<Value, ControlError>;
}

#[derive(Default)]
struct IdempotencyCache {
    responses: HashMap<(String, String), ControlResponse>,
    order: VecDeque<(String, String)>,
    in_flight: HashSet<(String, String)>,
}

impl IdempotencyCache {
    fn get(&self, caller_id: &str, request_id: &str) -> Option<ControlResponse> {
        self.responses
            .get(&(caller_id.to_owned(), request_id.to_owned()))
            .cloned()
    }

    fn insert(&mut self, caller_id: String, request_id: String, response: ControlResponse) {
        let key = (caller_id, request_id);
        if self.responses.contains_key(&key) {
            return;
        }
        self.order.push_back(key.clone());
        self.responses.insert(key, response);
        while self.order.len() > MAX_IDEMPOTENCY_ENTRIES {
            if let Some(expired) = self.order.pop_front() {
                self.responses.remove(&expired);
            }
        }
    }
}

pub struct CommandRouter {
    handler: Arc<dyn ControlHandler>,
    cache: Mutex<IdempotencyCache>,
    in_flight_changed: Condvar,
}

impl CommandRouter {
    pub fn new(handler: Arc<dyn ControlHandler>) -> Self {
        Self {
            handler,
            cache: Mutex::new(IdempotencyCache::default()),
            in_flight_changed: Condvar::new(),
        }
    }

    pub fn dispatch(&self, request: ControlRequest, identity: CallerIdentity) -> ControlResponse {
        let key = (identity.caller_id.clone(), request.id.clone());
        let mut cache = self
            .cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let deadline = Instant::now() + Duration::from_millis(request.timeout_ms);
        loop {
            if let Some(response) = cache.get(&key.0, &key.1) {
                return response;
            }
            if cache.in_flight.insert(key.clone()) {
                break;
            }
            let now = Instant::now();
            if now >= deadline {
                return ControlResponse::failure(
                    request.id.clone(),
                    ControlError::new(
                        ControlErrorCode::ControlTimeout,
                        "Control request timed out",
                    ),
                );
            }
            let remaining = deadline.saturating_duration_since(now);
            cache = self
                .in_flight_changed
                .wait_timeout(cache, remaining)
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .0;
        }
        drop(cache);

        let response = catch_unwind(AssertUnwindSafe(|| {
            match self.authorize(&request, &identity) {
                Ok(()) => {
                    let started = Instant::now();
                    let handled = self.handler.handle(&request, &identity);
                    if started.elapsed().as_millis() > u128::from(request.timeout_ms) {
                        ControlResponse::failure(
                            request.id.clone(),
                            ControlError::new(
                                ControlErrorCode::ControlTimeout,
                                "Control request timed out",
                            ),
                        )
                    } else {
                        match handled {
                            Ok(result) => ControlResponse::success(request.id.clone(), result),
                            Err(error) => ControlResponse::failure(request.id.clone(), error),
                        }
                    }
                }
                Err(error) => ControlResponse::failure(request.id.clone(), error),
            }
        }))
        .unwrap_or_else(|_| {
            ControlResponse::failure(
                request.id.clone(),
                ControlError::new(
                    ControlErrorCode::ControlRuntimeError,
                    "Control handler panicked",
                ),
            )
        });

        let mut cache = self
            .cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        cache.in_flight.remove(&key);
        cache.insert(identity.caller_id, request.id, response.clone());
        self.in_flight_changed.notify_all();
        response
    }

    fn authorize(
        &self,
        request: &ControlRequest,
        identity: &CallerIdentity,
    ) -> Result<(), ControlError> {
        request.validate()?;
        let required = capability_for(request.method);
        if !identity.allows(required) {
            return Err(ControlError::new(
                ControlErrorCode::CapabilityDenied,
                "Caller does not have permission for this command",
            ));
        }
        if let Some(project_id) = request.params.get("projectId").and_then(Value::as_str) {
            if identity.project_id != "*" && project_id != identity.project_id {
                return Err(ControlError::new(
                    ControlErrorCode::CapabilityDenied,
                    "Caller cannot access another project",
                ));
            }
        }
        Ok(())
    }
}

fn capability_for(method: ControlMethod) -> Capability {
    match method {
        ControlMethod::WorkspaceList => Capability::WorkspaceList,
        ControlMethod::WorkspaceOpen => Capability::WorkspaceOpen,
        ControlMethod::AgentList => Capability::AgentList,
        ControlMethod::AgentQueueStatus => Capability::AgentRead,
        ControlMethod::AgentSpawn => Capability::AgentSpawn,
        ControlMethod::AgentSend => Capability::AgentSend,
        ControlMethod::AgentPull => Capability::AgentSend,
        ControlMethod::AgentRead => Capability::AgentRead,
        ControlMethod::AgentFocus => Capability::AgentFocus,
        ControlMethod::AgentPause => Capability::AgentPause,
        ControlMethod::AgentStop => Capability::AgentStop,
        ControlMethod::WorktreeAudit => Capability::WorktreeRead,
        ControlMethod::AttentionList => Capability::AttentionRead,
        ControlMethod::AttentionAck => Capability::AttentionAck,
        ControlMethod::SessionList => Capability::SessionRead,
        ControlMethod::SessionReconcile => Capability::SessionReconcile,
        ControlMethod::SessionResume => Capability::SessionResume,
        ControlMethod::RuntimeHealth => Capability::RuntimeRead,
        ControlMethod::ProviderCapabilityReport => Capability::RuntimeRead,
        ControlMethod::TaxChatSend => Capability::TaxChatSend,
        ControlMethod::BrowserList
        | ControlMethod::BrowserStatus
        | ControlMethod::BrowserControlStatus
        | ControlMethod::BrowserWait
        | ControlMethod::BrowserSnapshot
        | ControlMethod::BrowserConsole
        | ControlMethod::BrowserErrors => Capability::BrowserRead,
        ControlMethod::BrowserOpen
        | ControlMethod::BrowserControlSet
        | ControlMethod::BrowserUse
        | ControlMethod::BrowserNavigate
        | ControlMethod::BrowserGoBack
        | ControlMethod::BrowserScroll
        | ControlMethod::BrowserClick
        | ControlMethod::BrowserFill
        | ControlMethod::BrowserPress
        | ControlMethod::BrowserScreenshot => Capability::BrowserControl,
        ControlMethod::BrowserEval => Capability::BrowserJavascript,
    }
}
