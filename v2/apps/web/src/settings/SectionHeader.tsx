import type { ReactNode } from "react";

export function SectionHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="settings-section-header">
      <h3 className="settings-section-title">{title}</h3>
      {children ? <p className="settings-section-note">{children}</p> : null}
    </header>
  );
}
