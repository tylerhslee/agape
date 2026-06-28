import { useState } from "react";
import Review from "./review/Review.jsx";
import Learning from "./missioncontrol/Learning.jsx";
import { STUDIO, RUNTIME, LANGUAGE } from "virtual:agape-versions";

const SECTIONS = [
  { id: "builder", label: "Builder", icon: "ti-sparkles" },
  { id: "conformance", label: "Conformance", icon: "ti-list-check" },
  { id: "settings", label: "Settings", icon: "ti-adjustments" },
];

export default function StudioSurface({ provider, setProvider, editorPrefs, setEditorPrefs, onExit }) {
  const [section, setSection] = useState("builder");

  return (
    <div className="studio">
      <aside className="studio-nav">
        <div className="studio-nav-head"><i className="ti ti-settings" /> Studio</div>
        <div className="studio-nav-sub">builder memory, conformance, and project-wide settings</div>
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
            {section === "builder" ? (
              <StudioBuilder />
            ) : (
              <Settings
                provider={provider}
                setProvider={setProvider}
                editorPrefs={editorPrefs}
                setEditorPrefs={setEditorPrefs}
              />
            )}
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
          <span>Vim mode <em>- modal editing, <code>:w</code> save, <code>:q</code> close</em></span>
          <input
            type="checkbox"
            checked={!!editorPrefs?.vim}
            onChange={(e) => setEditorPrefs((p) => ({ ...p, vim: e.target.checked }))}
          />
        </label>
        <label className="studio-row">
          <span>Word wrap <em>- wrap long lines instead of scrolling</em></span>
          <input
            type="checkbox"
            checked={!!editorPrefs?.wrap}
            onChange={(e) => setEditorPrefs((p) => ({ ...p, wrap: e.target.checked }))}
          />
        </label>
        <div className="studio-row-note">Both also toggle from the editor status bar and persist across sessions.</div>
      </section>

      <section className="studio-card">
        <div className="studio-card-h">Cognition provider</div>
        <div className="studio-card-sub">
          How the provider seam resolves graded judgments when you run a project. Applies to every run.
        </div>

        <label className="studio-row">
          <span>Live Claude</span>
          <input type="checkbox" checked={provider.claude} onChange={(e) => set({ claude: e.target.checked })} />
        </label>
        <div className="studio-row-note">
          {provider.claude
            ? "Graded judgments call a real Claude via the sampling fallback. The backend needs ANTHROPIC_API_KEY."
            : "Deterministic mock provider: no API key, fully offline, reproducible."}
        </div>

        {provider.claude && (
          <>
            <label className="studio-row">
              <span>Samples <em>- forced-choice draws per graded judgment</em></span>
              <input
                type="number"
                min="1"
                max="50"
                value={provider.samples}
                onChange={(e) => set({ samples: Math.max(1, Math.min(50, +e.target.value || 1)) })}
              />
            </label>
            <label className="studio-row">
              <span>Temperature <em>- 0 = provider default</em></span>
              <input
                type="number"
                min="0"
                max="1"
                step="0.1"
                value={provider.temp}
                onChange={(e) => set({ temp: Math.max(0, Math.min(1, +e.target.value || 0)) })}
              />
            </label>
          </>
        )}
      </section>

      <section className="studio-card" style={{ marginTop: 16 }}>
        <div className="studio-card-h">About</div>
        <div className="studio-card-sub">Versions running in this studio.</div>
        <div className="studio-row"><span>Studio</span><code className="studio-ver">v{STUDIO}</code></div>
        <div className="studio-row"><span>Runtime <em>- agape-rs</em></span><code className="studio-ver">v{RUNTIME}</code></div>
        <div className="studio-row"><span>Language <em>- spec</em></span><code className="studio-ver">v{LANGUAGE}</code></div>
      </section>
    </div>
  );
}

function StudioBuilder() {
  return (
    <>
      <div className="mc-col" style={{ paddingBottom: 0 }}>
        <h2 className="studio-h" style={{ marginBottom: 10 }}>Builder</h2>
        <div className="studio-card-sub" style={{ marginBottom: 14 }}>
          The studio's Agape coding agent: recall grounded language knowledge, draft programs, run conformance feedback, and store lessons.
        </div>
        <div className="mc-fleet-empty ready">
          <i className="ti ti-route" />
          <div>
            <div>Memory and conformance loop connected.</div>
            <div className="mc-muted-sm">
              The live agent uses the current spec, local memory, and the Agape runner behind the same seam the future Agape backend will own.
            </div>
          </div>
        </div>
      </div>
      <Learning />
    </>
  );
}
