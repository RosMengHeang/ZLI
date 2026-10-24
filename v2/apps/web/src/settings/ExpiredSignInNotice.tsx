import { Button, IconButton } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { expiredSignInMessage, useExpiredSignIns } from "./expiredSignIns.js";

/** A banner for connectors whose sign-in expired. Sign in again opens the connector in Settings. */
export function ExpiredSignInNotice({ onSignInAgain }: { onSignInAgain(connectorId: string): void }) {
  const { expired, dismiss } = useExpiredSignIns();
  const first = expired[0];
  if (!first) return null;
  const dismissAll = () => {
    for (const entry of expired) dismiss(entry.name);
  };
  return (
    <div className="banner banner-warning" role="status">
      <Icon name="alert" size={14} />
      <span className="banner-message">{expiredSignInMessage(expired)}</span>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          onSignInAgain(first.connectorId ?? first.name);
          dismissAll();
        }}
      >
        Sign in again
      </Button>
      <IconButton label="Dismiss sign-in notice" icon="x" size="sm" onClick={dismissAll} />
    </div>
  );
}
