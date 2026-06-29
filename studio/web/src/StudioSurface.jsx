import { useEffect, useMemo, useState } from "react";
import Editor from "@monaco-editor/react";
import Review from "./review/Review.jsx";
import Learning from "./missioncontrol/Learning.jsx";
import { registerAgape, AGAPE_LANG_ID } from "./agapeLanguage.js";
import * as project from "./project/projectApi.js";

const SECTIONS = [
  { id: "settings", label: "Settings", icon: "ti-adjustments" },
  { id: "syntax", label: "Syntax", icon: "ti-braces" },
  { id: "conformance", label: "Conformance", icon: "ti-list-check" },
];

export default function StudioSurface({ provider, setProvider, runtime, setRuntime, info, studioVersion, editorPrefs, setEditorPrefs, onExit }) {
  const [section, setSection] = useState(() => {
    try {
      const saved = localStorage.getItem("agape.studioSection");
      return SECTIONS.some((s) => s.id === saved) ? saved : "settings";
    }
    catch { return "settings"; }
  });

  useEffect(() => {
    try { localStorage.setItem("agape.studioSection", section); } catch {}
  }, [section]);

  return (
    <div className="studio">
      <aside className="studio-nav">
        <div className="studio-nav-head"><i className="ti ti-settings" /> Studio</div>
        <div className="studio-nav-sub">providers, runtime, editor, syntax, and conformance</div>
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
            {section === "syntax" ? (
              <SyntaxInspector />
            ) : (
              <Settings
                provider={provider}
                setProvider={setProvider}
                runtime={runtime}
                setRuntime={setRuntime}
                info={info}
                studioVersion={studioVersion}
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

const SYNTAX_SAMPLE = `module factcheck;

principal reviewer;

enum Verdict { True, False, Unclear }
event Claim(text body);
event VerdictReady(verdict: Verdict, reason: text);

agent Checker grants { emit VerdictReady } {
  when (Claim c) {
    Credence<Verdict> v = self <- c.body;

    reviewer decide v {
      True:    emit VerdictReady(True, "criteria supported");
      False:   emit VerdictReady(False, "criteria contradicted");
      Unclear: defer reviewer;
      default: defer reviewer;
    }
  }
}

spawn Checker checker;
awake checker;
emit Claim("The Eiffel Tower is in Paris");
`;

function SyntaxInspector() {
  const [src, setSrc] = useState(SYNTAX_SAMPLE);
  const [monacoApi, setMonacoApi] = useState(null);
  const [line, setLine] = useState(1);

  const tokenLines = useMemo(() => {
    if (!monacoApi) return [];
    try {
      return monacoApi.editor.tokenize(src, AGAPE_LANG_ID);
    } catch {
      return [];
    }
  }, [monacoApi, src]);

  useEffect(() => {
    if (!tokenLines.length) return;
    setLine((n) => Math.min(Math.max(1, n), tokenLines.length));
  }, [tokenLines.length]);

  const selectedTokens = tokenLines[line - 1] || [];
  const selectedText = src.split(/\r?\n/)[line - 1] || "";
  const coverage = flattenTokens(tokenLines);
  const seen = new Set(coverage.map((t) => t.type));
  const checks = [
    ["keyword", "language keywords", seen],
    ["type", "built-in and named types", seen],
    ["operator", "arrows and operators", seen],
    ["string", "strings", seen],
    ["comment", "comments", seen],
  ];

  return (
    <div className="syntax-page">
      <div className="syntax-head">
        <div>
          <h2 className="studio-h">Syntax Inspector</h2>
          <div className="studio-card-sub">
            Check how the Agape language pack classifies source in Monaco. Click a line to inspect token offsets and classes.
          </div>
        </div>
        <button onClick={() => setSrc(SYNTAX_SAMPLE)}><i className="ti ti-restore" /> Reset sample</button>
      </div>

      <div className="syntax-grid">
        <section className="syntax-editor">
          <Editor
            height="520px"
            language={AGAPE_LANG_ID}
            theme="agape-dark"
            value={src}
            beforeMount={registerAgape}
            onMount={(editor, monaco) => {
              setMonacoApi(monaco);
              editor.onDidChangeCursorPosition((e) => setLine(e.position.lineNumber));
            }}
            onChange={(v) => setSrc(v || "")}
            options={{
              fontSize: 13,
              minimap: { enabled: false },
              lineNumbersMinChars: 3,
              scrollBeyondLastLine: false,
              wordWrap: "on",
              automaticLayout: true,
            }}
          />
        </section>

        <aside className="syntax-panel">
          <div className="canvas-head">
            <span>Line {line}</span>
            <em>{selectedTokens.length} tokens</em>
          </div>
          <pre className="syntax-line">{selectedText || " "}</pre>

          <div className="syntax-token-list">
            {selectedTokens.map((t, i) => (
              <div key={i} className="syntax-token-row">
                <code>{t.offset}</code>
                <span>{t.type || "(plain)"}</span>
              </div>
            ))}
            {!selectedTokens.length && <div className="signal-empty">No tokens for this line.</div>}
          </div>

          <div className="canvas-head syntax-check-head">
            <span>Coverage</span>
            <em>{coverage.length} total</em>
          </div>
          <div className="syntax-checks">
            {checks.map(([needle, label, types]) => (
              <div key={needle} className="syntax-check">
                <i className={"ti " + (hasToken(types, needle) ? "ti-check" : "ti-minus")} />
                <span>{label}</span>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}

function flattenTokens(lines) {
  return lines.flatMap((line) => line.map((t) => ({ ...t, type: t.type || "" })));
}

function hasToken(types, needle) {
  for (const t of types) if (String(t).includes(needle)) return true;
  return false;
}

function Settings({ provider, setProvider, runtime, setRuntime, info, studioVersion, editorPrefs, setEditorPrefs }) {
  const set = (patch) => {
    const next = { ...provider, ...patch };
    if (patch.cognitionProvider !== undefined) next.judgeProvider = judgeProviderForCognition(next.cognitionProvider);
    setProvider(next);
    project.saveAgentConfig({
      cognitionProvider: next.cognitionProvider,
      judgeProvider: judgeProviderForCognition(next.cognitionProvider),
      samples: next.samples,
      temperature: next.temp,
      openaiTopLogprobs: next.openaiTopLogprobs,
    })
      .then((cfg) => setProvider((p) => ({ ...p, ...cfg, temp: cfg.temperature ?? p.temp })))
      .catch(() => {});
  };
  const setRuntimeConfig = (patch) => {
    const next = { ...runtime, ...patch };
    setRuntime(next);
    project.saveRuntimeConfig(next)
      .then((cfg) => setRuntime((p) => ({ ...p, ...cfg })))
      .catch(() => {});
  };
  const cognition = provider.cognitionProvider || "mock";
  const calibration = calibrationFor(cognition, provider);
  const keys = provider.keys || {};
  const runtimeMode = runtime?.mode || "local";
  const languageVersion = info?.languageVersion || info?.manifest?.languageVersion || "unknown";
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
          The selected provider drives agent replies and produces schema-constrained Credence values for fixed choices.
        </div>

        <div className="provider-grid">
          <button className={"provider-option" + (cognition === "mock" ? " active" : "")} onClick={() => set({ cognitionProvider: "mock" })}>
            <i className="ti ti-cpu-off" />
            <b>Mock</b>
            <span>offline deterministic runs</span>
          </button>
          <button className={"provider-option" + (cognition === "anthropic" ? " active" : "")} onClick={() => set({ cognitionProvider: "anthropic" })}>
            <i className="ti ti-brand-claude" />
            <b>Claude</b>
            <span>{keys.anthropic ? "ANTHROPIC_API_KEY found" : "needs ANTHROPIC_API_KEY"}</span>
          </button>
          <button className={"provider-option" + (cognition === "openai" ? " active" : "")} onClick={() => set({ cognitionProvider: "openai" })}>
            <i className="ti ti-brand-openai" />
            <b>OpenAI</b>
            <span>{keys.openai ? "OPENAI_API_KEY found" : "needs OPENAI_API_KEY"}</span>
          </button>
        </div>
        <div className="studio-row-note">
          Active completion model: <code>{provider.cognitionModel || (cognition === "openai" ? "gpt-4o-mini" : cognition === "anthropic" ? "claude-haiku-4-5" : "mock")}</code>
        </div>

        <div className="studio-card-h subhead">Credence calibration</div>
        <div className="studio-card-sub">
          Gates apply rules to an existing Credence. The provider capability below determines how that distribution is materialized.
        </div>
        <div className="calibration-strip">
          <div>
            <span>Source</span>
            <b>{calibration.source}</b>
          </div>
          <div>
            <span>Method</span>
            <b>{calibration.method}</b>
          </div>
          <div>
            <span>Model</span>
            <b>{calibration.model}</b>
          </div>
        </div>

        {cognition === "anthropic" && (
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
        {cognition === "openai" && (
          <label className="studio-row">
            <span>Top logprobs <em>- alternatives requested for the first decision token</em></span>
            <input
              type="number"
              min="1"
              max="20"
              value={provider.openaiTopLogprobs ?? 5}
              onChange={(e) => set({ openaiTopLogprobs: Math.max(1, Math.min(20, +e.target.value || 5)) })}
            />
          </label>
        )}
        <div className="studio-row-note">
          The gate itself remains uniform: it applies <code>confidence</code>, <code>conformal</code>, or a named policy to the Credence it receives.
        </div>
      </section>

      <section className="studio-card" style={{ marginTop: 16 }}>
        <div className="studio-card-h">Runtime deployment</div>
        <div className="studio-card-sub">
          Studio can point at a local runtime today and a cloud runtime later. This is deployment metadata, separate from Studio's own version.
        </div>
        <div className="provider-grid two">
          <button className={"provider-option" + (runtimeMode === "local" ? " active" : "")} onClick={() => setRuntimeConfig({ mode: "local", label: runtime?.label || "Local runtime" })}>
            <i className="ti ti-device-desktop" />
            <b>Local</b>
            <span>current machine or packaged bundle</span>
          </button>
          <button className={"provider-option" + (runtimeMode === "cloud" ? " active" : "")} onClick={() => setRuntimeConfig({ mode: "cloud", label: runtime?.label === "Local runtime" ? "Cloud runtime" : runtime?.label || "Cloud runtime" })}>
            <i className="ti ti-cloud" />
            <b>Cloud</b>
            <span>Soma or hosted Agape runtime</span>
          </button>
        </div>
        <label className="studio-row">
          <span>Runtime label <em>- display name for this deployment</em></span>
          <input
            type="text"
            value={runtime?.label || ""}
            onChange={(e) => setRuntimeConfig({ label: e.target.value })}
          />
        </label>
        <label className="studio-row">
          <span>Runtime endpoint <em>- optional local or cloud control-plane URL</em></span>
          <input
            type="text"
            value={runtime?.endpoint || ""}
            placeholder={runtimeMode === "cloud" ? "https://soma.example/agape" : "http://127.0.0.1:8799"}
            onChange={(e) => setRuntimeConfig({ endpoint: e.target.value })}
          />
        </label>
        <label className="studio-row">
          <span>Runtime version <em>- reported by deployment, override only when needed</em></span>
          <input
            type="text"
            value={runtime?.version || ""}
            placeholder="reported by runtime"
            onChange={(e) => setRuntimeConfig({ version: e.target.value })}
          />
        </label>
      </section>

      <section className="studio-card" style={{ marginTop: 16 }}>
        <div className="studio-card-h">About</div>
        <div className="studio-card-sub">Studio is versioned independently; language and runtime come from the active project and deployment.</div>
        <div className="studio-row"><span>Studio <em>- UI application</em></span><code className="studio-ver">v{studioVersion || "unknown"}</code></div>
        <div className="studio-row"><span>Project language <em>- active project manifest</em></span><code className="studio-ver">{formatVersion(languageVersion)}</code></div>
        <div className="studio-row"><span>Runtime <em>- {runtime?.label || "deployment"}</em></span><code className="studio-ver">{formatVersion(runtime?.version || "unknown")}</code></div>
      </section>
    </div>
  );
}

function judgeProviderForCognition(cognitionProvider) {
  return cognitionProvider === "openai" ? "openai" : "anthropic";
}

function formatVersion(value) {
  if (!value || value === "unknown") return "unknown";
  return String(value).startsWith("v") ? String(value) : `v${value}`;
}

function calibrationFor(cognitionProvider, provider) {
  if (cognitionProvider === "openai") {
    return {
      source: "OpenAI",
      method: `token logprobs · top ${provider.openaiTopLogprobs || 5}`,
      model: provider.judgeModel || provider.cognitionModel || "gpt-4o-mini",
    };
  }
  if (cognitionProvider === "anthropic") {
    return {
      source: "Claude",
      method: `sampling fallback · ${provider.samples || 5} draws`,
      model: provider.judgeModel || provider.cognitionModel || "claude-haiku-4-5",
    };
  }
  return {
    source: "Mock",
    method: "deterministic fixture",
    model: "mock",
  };
}

export function StudioBuilder() {
  return (
    <>
      <div className="mc-col" style={{ paddingBottom: 0 }}>
        <h2 className="studio-h" style={{ marginBottom: 10 }}>Builder</h2>
        <div className="studio-card-sub" style={{ marginBottom: 14 }}>
          Project coding agent: recall grounded language knowledge, draft programs, run conformance feedback, and store lessons for this workspace.
        </div>
        <div className="mc-fleet-empty ready">
          <i className="ti ti-route" />
          <div>
            <div>Memory and conformance loop connected.</div>
            <div className="mc-muted-sm">
              The live agent uses the current project, spec, local memory, and the Agape runner behind the same seam the future Agape backend will own.
            </div>
          </div>
        </div>
      </div>
      <Learning />
    </>
  );
}
