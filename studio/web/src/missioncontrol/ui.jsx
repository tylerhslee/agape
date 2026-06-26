import { STATUS_META } from "./store.js";

// Shared status presentation. One class per status keeps color consistent across
// the dashboard, board, and detail spoke (STUDIO.md §5.1).
export function StatusChip({ status }) {
  const m = STATUS_META[status];
  return <span className={`mc-chip mc-st-${status}`}>{m ? m.label : status}</span>;
}

export function StatusDot({ status }) {
  return <span className={`mc-dot mc-st-${status}`} />;
}

export function ModeChip({ mode }) {
  return mode === "delegated" ? (
    <span className="mc-chip mc-chip-delegated">delegated</span>
  ) : (
    <span className="mc-chip mc-chip-paired">paired</span>
  );
}
