// The bottom panel in "Query" mode — the agape> console. VS Code's integrated
// terminal, reimagined: instead of a shell, you run Agape source against the live
// program. Sends, lifecycle, and the three query modalities (find/select/match)
// all work here; each command's new ledger events are summarized back.
import { useState, useRef, useEffect } from "react";

export default function QueryConsole({ log, onRun }) {
  const [src, setSrc] = useState("");
  const logRef = useRef(null);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log.length]);

  const submit = () => {
    const s = src.trim();
    if (!s) return;
    onRun(s);
    setSrc("");
  };

  return (
    <div className="query">
      <div className="log" ref={logRef}>
        {log.length === 0 && (
          <div className="line res">
            Run Agape against the live program. Try:&nbsp;
            <span style={{ color: "#9cdcfe" }}>find n where {"{"} Helper is_named n {"}"};</span>
          </div>
        )}
        {log.map((l, i) => (
          <div className={"line " + (l.kind === "err" ? "err" : l.kind === "res" ? "res" : "")} key={i}>
            {l.kind === "cmd" && <span className="sigil">agape&gt; </span>}
            {l.text}
          </div>
        ))}
      </div>
      <div className="input-row">
        <span className="sigil">agape&gt;</span>
        <input
          type="text"
          value={src}
          placeholder='event<text> r = ada <- "What is your name?";'
          onChange={(e) => setSrc(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          autoFocus
        />
        <button onClick={submit}>run</button>
      </div>
    </div>
  );
}
