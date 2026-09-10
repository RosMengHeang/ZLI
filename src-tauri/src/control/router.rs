use super::{
    CallerIdentity, Capability, ControlError, ControlErrorCode, ControlMethod, ControlRequest,
    ControlResponse,
};
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Instant;

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
}

impl CommandRouter {
    pub fn new(handler: Arc<dyn ControlHandler>) -> Self {
        Self {
            handler,
            cache: Mutex::new(IdempotencyCache::default()),
        }
    }

    pub fn dispatch(&self, request: ControlRequest, identity: CallerIdentity) -> ControlResponse {
        if let Ok(cache) = self.cache.lock() {
            if let Some(response) = cache.get(&identity.caller_id, &request.id) {
                return response;
            }
        }

        let response = match self.authorize(&request, &identity) {
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
        };

        if let Ok(mut cache) = self.cache.lock() {
            cache.insert(identity.caller_id, request.id, response.clone());
        }
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
        ControlMethod::AgentSpawn => Capability::AgentSpawn,
        ControlMethod::AgentSend => Capability::AgentSend,
        ControlMethod::AgentRead => Capability::AgentRead,
        ControlMethod::AgentFocus => Capability::AgentFocus,
        ControlMethod::AgentPause => Capability::AgentPause,
        ControlMethod::AgentStop => Capability::AgentStop,
        ControlMethod::AttentionList => Capability::AttentionRead,
        ControlMethod::AttentionAck => Capability::AttentionAck,
        ControlMethod::SessionList => Capability::SessionRead,
        ControlMethod::SessionResume => Capability::SessionResume,
        ControlMethod::TaxChatSend => Capability::TaxChatSend,
        ControlMethod::BrowserList
        | ControlMethod::BrowserWait
        | ControlMethod::BrowserSnapshot
        | ControlMethod::BrowserConsole
        | ControlMethod::BrowserErrors => Capability::BrowserRead,
        ControlMethod::BrowserOpen
        | ControlMethod::BrowserNavigate
        | ControlMethod::BrowserClick
        | ControlMethod::BrowserFill
        | ControlMethod::BrowserPress
        | ControlMethod::BrowserScreenshot => Capability::BrowserControl,
        ControlMethod::BrowserEval => Capability::BrowserJavascript,
    }
}
