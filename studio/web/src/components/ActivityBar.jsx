// The far-left activity bar — VS Code's primary navigation. Event-cockpit first:
// the views are Agents (the population), Spine (the live event log), and Query
// (the agape> console), not Explorer/Search/Git.
const ITEMS = [
  { id: "agents", icon: "ti-users-group", label: "Agents" },
  { id: "spine", icon: "ti-timeline-event", label: "Event spine" },
  { id: "query", icon: "ti-database-search", label: "Query console" },
];

export default function ActivityBar({ active, onSelect }) {
  return (
    <div className="activitybar">
      {ITEMS.map((it) => (
        <div
          key={it.id}
          className={"item" + (active === it.id ? " active" : "")}
          title={it.label}
          aria-label={it.label}
          onClick={() => onSelect(it.id)}
        >
          <i className={"ti " + it.icon} />
        </div>
      ))}
      <div className="spacer" />
      <div className="item" title="Agape Studio" aria-label="about">
        <i className="ti ti-diamond" />
      </div>
    </div>
  );
}
