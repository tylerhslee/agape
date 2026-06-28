import { useState } from "react";
import Review from "./review/Review.jsx";
import Learning from "./missioncontrol/Learning.jsx";

// The Studio surface — the studio *itself*, not the user's project. Reached via the
// gear in the rail. Its own sub-nav: settings (incl. the cognition provider, which
// is studio-level config), conformance inspection of the Agape implementation, and
// the studio's own agentic layer (fleet + memory).
const SECTIONS = [
  { id: "settings", label: "Settings", icon: "ti-adjustments" },
  { id: "conformance", label: "Conformance", icon: "ti-list-check" },
  { id: "agents", label: "Agents", icon: "ti-robot" },
];

export default function StudioSurface({ provider, setProvider, editorPrefs, setEditorPrefs, onExit }) {
  const [section, setSection] = useState("settings");

  return (
    <div className="studio">
      <aside className="studio-nav">
        <div className="studio-nav-head"><i className="ti ti-settings" /> Studio</div>
        <div className="studio-nav-sub">the studio itself — config, inspection, and its own agents</div>
        {SECTIONS.map((s) => (
          <div
            key={s.id}
            className={"studio-nav-item" + (section === s.id ? " active" : "")}
            onClick={() => setSection(s.id)}
          >
            <i className={"ti " + s.icon} /><span>{s.label}</span>
          </div>
        ))}
        <div className="studio-nav-spacer" />
        <div className="studio-nav-item subtle" onClick={onExit}>
          <i className="ti ti-arrow-back-up" /><span>Back to project</span>
        </div>
      </aside>

      <div className="studio-body">
        {section === "conformance" ? (
          <Review />
        ) : (
          <div className="app-scroll">
            {section === "agents" ? <StudioAgents /> : <Settings provider={provider} setProvider={setProvider} editorPrefs={editorPrefs} setEditorPrefs={setEditorPrefs} />}
          </div>
        )}
      </div>
    </div>
  );
}

function Settings({ provider, setProvider, editorPrefs, setEditorPrefs }) {
  const set = (patch) => setProvider({ ...provider, ...patch });
  return (
    <div className="studio-page">
      <h2 className="studio-h">Settings</h2>

      <section className="studio-card" style={{ marginBottom: 16 }}>
        <div className="studio-card-h">Editor</div>
        <div className="studio-card-sub">Keybindings and behavior for the code editor.</div>
        <label className="studio-row">
          <span>Vim mode <em>— modal editing, <code>:w</code> to save</em></span>
          <input type="checkbox" checked={!!editorPrefs?.vim}
            onChange={(e) => setEditorPrefs((p) => ({ ...p, vim: e.target.checked }))} />
        </label>
        <div className="studio-row-note">Also toggleable from the editor's status bar. Persists across sessions.</div>
      </section>

      <section className="studio-card">
        <div className="studio-card-h">Cognition provider</div>
        <div className="studio-card-sub">
          How the <code>&larr;</code> seam resolves graded judgments when you run a project. Applies to every run.
        </div>

        <label className="studio-row">
          <span>Live Claude</span>
          <input type="checkbox" checked={provider.claude} onChange={(e) => set({ claude: e.target.checked })} />
        </label>
        <div className="studio-row-note">
          {provider.claude
            ? "Graded judgments call a real Claude via the sampling fallback (needs ANTHROPIC_API_KEY on the backend)."
            : "Deterministic mock provider — no API key, fully offline and reproducible."}
        </div>

        {provider.claude && (
          <>
            <label className="studio-row">
              <span>Samples <em>— forced-choice draws per graded judgment</em></span>
              <input type="number" min="1" max="50" value={provider.samples}
                onChange={(e) => set({ samples: Math.max(1, Math.min(50, +e.target.value || 1)) })} />
            </label>
            <label className="studio-row">
              <span>Temperature <em>— 0 = provider default</em></span>
              <input type="number" min="0" max="1" step="0.1" value={provider.temp}
                onChange={(e) => set({ temp: Math.max(0, Math.min(1, +e.target.value || 0)) })} />
            </label>
          </>
        )}
      </section>
    </div>
  );
}

// The studio's own agents — distinct from the user's project. Today: an empty fleet
// (no agentic backend connected) plus the agent-memory inspector.
function StudioAgents() {
  return (
    <>
      <div className="mc-col" style={{ paddingBottom: 0 }}>
        <h2 className="studio-h" style={{ marginBottom: 10 }}>Agents</h2>
        <div className="studio-card-sub" style={{ marginBottom: 14 }}>
          The studio's own agentic layer — operators that route, delegate, and remember across your projects.
        </div>
        <div className="mc-fleet-empty">
          <i className="ti ti-plug-off" />
          <div>
            <div>no agents connected.</div>
            <div className="mc-muted-sm">Slot in the Agape agentic backend to see the studio's operators routing and delegating. Until then this is inspection-only.</div>
          </div>
        </div>
      </div>
      <Learning />
    </>
  );
}
