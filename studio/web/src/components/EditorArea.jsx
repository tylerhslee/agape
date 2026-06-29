// The editor — Monaco, speaking real Agape. Edit the .ag program and hit Run to
// load it into the backend (which re-checks the three guarantees and resets the
// ledger). The editor is present but not the star: in an event cockpit the ledger
// and agents below carry top billing.
import Editor from "@monaco-editor/react";
import { registerAgape, AGAPE_LANG_ID } from "../agapeLanguage.js";

export default function EditorArea({ source, onChange, onRun, programPath, msg }) {
  const fileName = (programPath || "untitled.ag").split("/").pop();
  return (
    <div className="editor-wrap">
      <div className="tabs">
        <div className="tab active">
          <i className="ti ti-file-code" style={{ color: "#569cd6", fontSize: 13 }} /> {fileName}
        </div>
      </div>
      <div className="editor-toolbar">
        <button onClick={onRun} title="Load this source into the backend (resets the ledger)">
          <i className="ti ti-player-play" style={{ fontSize: 13, verticalAlign: -2 }} /> Run
        </button>
        {msg && <span className={"msg " + (msg.ok ? "ok" : "err")}>{msg.text}</span>}
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <Editor
          height="100%"
          language={AGAPE_LANG_ID}
          theme="agape-dark"
          value={source}
          onChange={(v) => onChange(v ?? "")}
          beforeMount={registerAgape}
          options={{
            fontSize: 13,
            fontFamily: "Cascadia Code, JetBrains Mono, monospace",
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            automaticLayout: true,
            tabSize: 4,
          }}
        />
      </div>
    </div>
  );
}
