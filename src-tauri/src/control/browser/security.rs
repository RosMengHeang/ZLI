use super::commands::{BrowserCapability, BrowserCommandKind};
use super::BrowserSurfaceRecord;
use crate::control::{CallerIdentity, Capability, ControlError, ControlErrorCode};

pub fn required_capability(kind: BrowserCommandKind) -> (BrowserCapability, Capability) {
    match kind {
        BrowserCommandKind::Wait
        | BrowserCommandKind::Snapshot
        | BrowserCommandKind::Console
        | BrowserCommandKind::Errors => (BrowserCapability::Read, Capability::BrowserRead),
        BrowserCommandKind::Open
        | BrowserCommandKind::Navigate
        | BrowserCommandKind::GoBack
        | BrowserCommandKind::Scroll
        | BrowserCommandKind::Click
        | BrowserCommandKind::Fill
        | BrowserCommandKind::Press
        | BrowserCommandKind::Screenshot => {
            (BrowserCapability::Control, Capability::BrowserControl)
        }
        BrowserCommandKind::Eval => (BrowserCapability::Javascript, Capability::BrowserJavascript),
    }
}

pub fn authorize_surface(
    identity: &CallerIdentity,
    surface: &BrowserSurfaceRecord,
    kind: BrowserCommandKind,
) -> Result<(), ControlError> {
    if identity.project_id != "*" && identity.project_id != surface.project_id {
        return Err(ControlError::new(
            ControlErrorCode::BrowserSurfaceForbidden,
            "Browser surface belongs to another project",
        ));
    }
    if identity.agent_id.as_deref().is_some_and(|caller_agent| {
        surface.agent_id.as_deref() != Some(caller_agent)
    }) {
        return Err(ControlError::new(
            ControlErrorCode::BrowserSurfaceForbidden,
            "Browser surface belongs to another agent or to the user",
        ));
    }

    let (surface_capability, caller_capability) = required_capability(kind);
    if !identity.allows(caller_capability) || !surface.capabilities.contains(&surface_capability) {
        return Err(ControlError::new(
            ControlErrorCode::BrowserPermissionRequired,
            "Browser permission must be granted for this surface",
        ));
    }
    Ok(())
}
