import { Button } from "../ui/Button.js";
import "./compare.css";

/** A quiet line in the chat a best-of group started from: how its runs stand, and a way into Compare. */
export function RunsCard({ done, count, onCompare }: { done: number; count: number; onCompare(): void }) {
  const finished = done >= count;
  return (
    <div className="runs-card" role="status">
      <span className="runs-card-text">
        {finished ? `${count} runs finished` : `${done} of ${count} runs finished`}
      </span>
      <Button size="xs" variant={finished ? "secondary" : "ghost"} onClick={onCompare}>
        Compare
      </Button>
    </div>
  );
}
