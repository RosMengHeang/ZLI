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
    if let (Some(caller_agent), Some(surface_agent)) =
        (identity.agent_id.as_deref(), surface.agent_id.as_deref())
    {
        if caller_agent != surface_agent {
            return Err(ControlError::new(
                ControlErrorCode::BrowserSurfaceForbidden,
                "Browser surface belongs to another agent",
            ));
        }
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
