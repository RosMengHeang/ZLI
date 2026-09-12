use super::protocol::{ControlError, ControlErrorCode};
use super::team::{AgentMessageInbox, QueuedAgentMessage, TeamAgent, TeamBackend};
use crate::agents::providers::DeliveryKind;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

pub struct AcceptSlot {
    #[allow(dead_code)]
    agent_id: String,
    #[allow(dead_code)]
    minted_at_ms: u64,
    origin: SlotOrigin,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SlotOrigin {
    GlyphPrompt,
    ExplicitPull,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum ReadinessView {
    Ready,
    Busy,
    Unknown,
    Unsupported,
}

pub enum DeliveryStance {
    Gated {
        phase: GatedPhase,
    },
    Pull {
        phase: PullPhase,
    },
}

pub enum GatedPhase {
    Unknown,
    Ready(AcceptSlot),
    Busy,
}

pub enum PullPhase {
    Idle,
    Armed(AcceptSlot),
    InFlight,
}

pub enum ReadinessObservation {
    MintGlyph {
        agent_id: String,
        #[allow(dead_code)]
        reason: &'static str,
    },
    LocalInput {
        agent_id: String,
    },
    Exited {
        agent_id: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullReceipt {
    pub minted: bool,
    pub delivered: bool,
    pub message_id: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScheduleDecision {
    Dispatch,
    Hold,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PullDecision {
    Arm,
    AlreadyArmed,
    InFlight,
    DeniedGated,
}

pub fn decide_schedule(paused: bool, has_slot: bool) -> ScheduleDecision {
    if paused || !has_slot {
        ScheduleDecision::Hold
    } else {
        ScheduleDecision::Dispatch
    }
}

pub fn decide_pull(stance: &DeliveryStance) -> PullDecision {
    match stance {
        DeliveryStance::Gated { .. } => PullDecision::DeniedGated,
        DeliveryStance::Pull {
            phase: PullPhase::Idle,
        } => PullDecision::Arm,
        DeliveryStance::Pull {
            phase: PullPhase::Armed(_),
        } => PullDecision::AlreadyArmed,
        DeliveryStance::Pull {
            phase: PullPhase::InFlight,
        } => PullDecision::InFlight,
    }
}

pub fn stance_has_slot(stance: &DeliveryStance) -> bool {
    matches!(
        stance,
        DeliveryStance::Gated {
            phase: GatedPhase::Ready(_),
        } | DeliveryStance::Pull {
            phase: PullPhase::Armed(_),
        }
    )
}

pub struct DeliveryDesk {
    stances: Mutex<HashMap<String, DeliveryStance>>,
}

impl DeliveryDesk {
    pub fn new() -> Self {
        Self {
            stances: Mutex::new(HashMap::new()),
        }
    }

    pub fn bind(&self, agent_id: &str, kind: DeliveryKind) -> Result<(), ControlError> {
        let mut stances = self.stances.lock().map_err(desk_lock_error)?;
        if stances.contains_key(agent_id) {
            return Ok(());
        }
        let stance = match kind {
            DeliveryKind::MintedSlots => DeliveryStance::Gated {
                phase: GatedPhase::Unknown,
            },
            DeliveryKind::ExplicitPull => DeliveryStance::Pull {
                phase: PullPhase::Idle,
            },
        };
        stances.insert(agent_id.to_owned(), stance);
        Ok(())
    }

    pub fn view(&self, agent_id: &str) -> ReadinessView {
        let Ok(stances) = self.stances.lock() else {
            return ReadinessView::Unknown;
        };
        match stances.get(agent_id) {
            Some(DeliveryStance::Gated {
                phase: GatedPhase::Ready(_),
            })
            | Some(DeliveryStance::Pull {
                phase: PullPhase::Armed(_),
            }) => ReadinessView::Ready,
            Some(DeliveryStance::Gated {
                phase: GatedPhase::Busy,
            })
            | Some(DeliveryStance::Pull {
                phase: PullPhase::InFlight,
            }) => ReadinessView::Busy,
            Some(DeliveryStance::Gated {
                phase: GatedPhase::Unknown,
            })
            | None => ReadinessView::Unknown,
            Some(DeliveryStance::Pull {
                phase: PullPhase::Idle,
            }) => ReadinessView::Unsupported,
        }
    }

    pub fn apply(&self, observation: ReadinessObservation) -> Result<(), ControlError> {
        let mut stances = self.stances.lock().map_err(desk_lock_error)?;
        match observation {
            ReadinessObservation::MintGlyph { agent_id, .. } => {
                if let Some(DeliveryStance::Gated { phase }) = stances.get_mut(&agent_id) {
                    if !matches!(phase, GatedPhase::Ready(_)) {
                        *phase = GatedPhase::Ready(AcceptSlot::mint(agent_id, SlotOrigin::GlyphPrompt));
                    }
                }
            }
            ReadinessObservation::LocalInput { agent_id } => match stances.get_mut(&agent_id) {
                Some(DeliveryStance::Gated {
                    phase: phase @ GatedPhase::Ready(_),
                }) => *phase = GatedPhase::Busy,
                Some(DeliveryStance::Pull {
                    phase: phase @ PullPhase::Armed(_),
                }) => *phase = PullPhase::Idle,
                _ => {}
            },
            ReadinessObservation::Exited { agent_id } => {
                stances.remove(&agent_id);
            }
        }
        Ok(())
    }

    pub fn arm_pull(&self, agent_id: &str) -> Result<(), ControlError> {
        let mut stances = self.stances.lock().map_err(desk_lock_error)?;
        let Some(stance) = stances.get_mut(agent_id) else {
            return Err(ControlError::new(
                ControlErrorCode::SessionNotFound,
                "Agent session was not found",
            ));
        };
        match decide_pull(stance) {
            PullDecision::DeniedGated => Err(ControlError::new(
                ControlErrorCode::CapabilityDenied,
                "This provider mints delivery slots from its prompt; pull is not available",
            )),
            PullDecision::Arm => {
                if let DeliveryStance::Pull { phase } = stance {
                    *phase = PullPhase::Armed(AcceptSlot::mint(
                        agent_id.to_owned(),
                        SlotOrigin::ExplicitPull,
                    ));
                }
                Ok(())
            }
            PullDecision::AlreadyArmed | PullDecision::InFlight => Ok(()),
        }
    }

    pub fn try_dispatch(
        &self,
        inbox: &AgentMessageInbox,
        backend: &dyn TeamBackend,
        record: &TeamAgent,
        ack_pending: &Mutex<HashMap<(String, String), QueuedAgentMessage>>,
        requeue_pending: &Mutex<HashMap<(String, String), QueuedAgentMessage>>,
    ) -> Result<Option<QueuedAgentMessage>, ControlError> {
        if record.paused {
            return Ok(None);
        }
        let origin = {
            let mut stances = self.stances.lock().map_err(desk_lock_error)?;
            let Some(stance) = stances.get_mut(&record.agent_id) else {
                return Ok(None);
            };
            if decide_schedule(record.paused, stance_has_slot(stance)) == ScheduleDecision::Hold {
                return Ok(None);
            }
            match stance {
                DeliveryStance::Gated {
                    phase: phase @ GatedPhase::Ready(_),
                } => {
                    let GatedPhase::Ready(slot) = std::mem::replace(phase, GatedPhase::Busy) else {
                        return Ok(None);
                    };
                    slot.origin
                }
                DeliveryStance::Pull {
                    phase: phase @ PullPhase::Armed(_),
                } => {
                    let PullPhase::Armed(slot) = std::mem::replace(phase, PullPhase::InFlight) else {
                        return Ok(None);
                    };
                    slot.origin
                }
                _ => return Ok(None),
            }
        };

        let message = match inbox.take_next(&record.agent_id) {
            Ok(Some(message)) => message,
            Ok(None) => {
                self.restore_slot(&record.agent_id, origin)?;
                return Ok(None);
            }
            Err(error) => {
                self.restore_slot(&record.agent_id, origin)?;
                return Err(error);
            }
        };
        if message.project_id != record.project_id {
            let _ = inbox.ack(&record.agent_id, &message.message_id);
            self.finish_spend(&record.agent_id, origin)?;
            return Ok(None);
        }

        if let Err(error) = backend.deliver(&record.terminal_id, &message.body) {
            match inbox.requeue(&record.agent_id, &message.message_id) {
                Ok(_) => {}
                Err(_) => {
                    if let Ok(mut pending) = requeue_pending.lock() {
                        pending.insert(
                            (record.agent_id.clone(), message.message_id.clone()),
                            message,
                        );
                    }
                }
            }
            self.restore_slot(&record.agent_id, origin)?;
            return Err(error);
        }

        if inbox.ack(&record.agent_id, &message.message_id).is_err() {
            if let Ok(mut pending) = ack_pending.lock() {
                pending.insert(
                    (record.agent_id.clone(), message.message_id.clone()),
                    message,
                );
            }
            self.finish_spend(&record.agent_id, origin)?;
            return Ok(None);
        }

        self.finish_spend(&record.agent_id, origin)?;
        Ok(Some(message))
    }

    fn restore_slot(&self, agent_id: &str, origin: SlotOrigin) -> Result<(), ControlError> {
        let mut stances = self.stances.lock().map_err(desk_lock_error)?;
        if let Some(stance) = stances.get_mut(agent_id) {
            match origin {
                SlotOrigin::GlyphPrompt => {
                    if let DeliveryStance::Gated { phase } = stance {
                        *phase = GatedPhase::Ready(AcceptSlot::mint(agent_id.to_owned(), origin));
                    }
                }
                SlotOrigin::ExplicitPull => {
                    if let DeliveryStance::Pull { phase } = stance {
                        *phase = PullPhase::Armed(AcceptSlot::mint(agent_id.to_owned(), origin));
                    }
                }
            }
        }
        Ok(())
    }

    fn finish_spend(&self, agent_id: &str, origin: SlotOrigin) -> Result<(), ControlError> {
        let mut stances = self.stances.lock().map_err(desk_lock_error)?;
        if let Some(stance) = stances.get_mut(agent_id) {
            match origin {
                SlotOrigin::GlyphPrompt => {
                    if let DeliveryStance::Gated { phase } = stance {
                        *phase = GatedPhase::Busy;
                    }
                }
                SlotOrigin::ExplicitPull => {
                    if let DeliveryStance::Pull { phase } = stance {
                        *phase = PullPhase::Idle;
                    }
                }
            }
        }
        Ok(())
    }
}

impl Default for DeliveryDesk {
    fn default() -> Self {
        Self::new()
    }
}

impl AcceptSlot {
    fn mint(agent_id: String, origin: SlotOrigin) -> Self {
        Self {
            agent_id,
            minted_at_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_millis() as u64)
                .unwrap_or(0),
            origin,
        }
    }
}

fn desk_lock_error<T>(_: std::sync::PoisonError<T>) -> ControlError {
    ControlError::new(
        ControlErrorCode::ControlRuntimeError,
        "Delivery desk is unavailable",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gated_unknown() -> DeliveryStance {
        DeliveryStance::Gated {
            phase: GatedPhase::Unknown,
        }
    }

    fn pull_idle() -> DeliveryStance {
        DeliveryStance::Pull {
            phase: PullPhase::Idle,
        }
    }

    #[test]
    fn decide_schedule_holds_without_a_slot_or_when_paused() {
        assert_eq!(decide_schedule(false, false), ScheduleDecision::Hold);
        assert_eq!(decide_schedule(true, true), ScheduleDecision::Hold);
        assert_eq!(decide_schedule(false, true), ScheduleDecision::Dispatch);
    }

    #[test]
    fn decide_pull_denies_gated_and_arms_idle_pull() {
        assert_eq!(decide_pull(&gated_unknown()), PullDecision::DeniedGated);
        assert_eq!(decide_pull(&pull_idle()), PullDecision::Arm);
        let armed = DeliveryStance::Pull {
            phase: PullPhase::Armed(AcceptSlot::mint("agent-1".into(), SlotOrigin::ExplicitPull)),
        };
        assert_eq!(decide_pull(&armed), PullDecision::AlreadyArmed);
        let inflight = DeliveryStance::Pull {
            phase: PullPhase::InFlight,
        };
        assert_eq!(decide_pull(&inflight), PullDecision::InFlight);
    }

    #[test]
    fn desk_mints_a_glyph_slot_and_burns_it_on_local_input() {
        let desk = DeliveryDesk::new();
        desk.bind("agent-1", DeliveryKind::MintedSlots).unwrap();
        assert_eq!(desk.view("agent-1"), ReadinessView::Unknown);
        desk.apply(ReadinessObservation::MintGlyph {
            agent_id: "agent-1".into(),
            reason: "codex_prompt_marker",
        })
        .unwrap();
        assert_eq!(desk.view("agent-1"), ReadinessView::Ready);
        desk.apply(ReadinessObservation::LocalInput {
            agent_id: "agent-1".into(),
        })
        .unwrap();
        assert_eq!(desk.view("agent-1"), ReadinessView::Busy);
    }

    #[test]
    fn desk_ignores_glyph_mints_on_pull_agents() {
        let desk = DeliveryDesk::new();
        desk.bind("cursor-1", DeliveryKind::ExplicitPull).unwrap();
        desk.apply(ReadinessObservation::MintGlyph {
            agent_id: "cursor-1".into(),
            reason: "should_not_mint",
        })
        .unwrap();
        assert_eq!(desk.view("cursor-1"), ReadinessView::Unsupported);
        desk.arm_pull("cursor-1").unwrap();
        assert_eq!(desk.view("cursor-1"), ReadinessView::Ready);
    }
}
