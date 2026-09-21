import type { AttentionProjection } from "@zli-v2/contracts";

export function AttentionPanel({ items }: { items: readonly AttentionProjection[] }) {
  if (items.length === 0) return null;
  return <aside className="attention-panel" aria-label="Attention required"><span className="eyebrow">Needs attention</span>{items.map((item) => <div className="attention-item" key={item.id}><span className={`attention-mark attention-${item.kind}`} aria-hidden="true" /><div><strong>{item.title}</strong><span>{item.kind.replace("-", " ")}</span></div></div>)}</aside>;
}
