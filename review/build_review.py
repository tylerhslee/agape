#!/usr/bin/env python3
"""Build a self-contained Agape review dashboard.

Reads SPEC.md + every conformance `.ag` test + the live `agape-rs` conformance
result, and emits one `review/dashboard.html` you open in a browser. Three views:
the spec (line-numbered, proofread + comment), the test suite (browse source +
status + spec ref), and the results scoreboard. Notes are kept in the browser and
exported as markdown to paste back as feedback.

    python3 review/build_review.py        # rebuild dashboard.html (runs the suite)
    python3 review/build_review.py --no-run   # skip running the suite (faster)
"""
import glob
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))      # review/
REPO = os.path.dirname(ROOT)                            # the worktree
SPEC = os.path.join(REPO, "SPEC.md")
TESTS = os.path.join(REPO, "agape-conformance", "tests")
AGAPE_RS = os.path.join(REPO, "agape-rs")


def run_conformance():
    """Run the conformance runner; return ({id: (status, reason)}, build_ok, summary)."""
    status, build_ok, summary = {}, True, ""
    try:
        out = subprocess.run(
            ["cargo", "run", "--quiet", "--bin", "conformance", "--", "--fails"],
            cwd=AGAPE_RS, capture_output=True, text=True, timeout=600,
        )
        text = out.stdout + "\n" + out.stderr
        if "error[" in text or "could not compile" in text:
            build_ok = False
        for line in text.splitlines():
            m = re.match(r"\s*✗\s+(\S+)\s+(\S+)\s+(.*)", line)
            if m:
                status[m.group(2)] = ("fail", m.group(3).strip())
            m2 = re.search(r"(\d+)\s+pass\b.*?(\d+)\s+fail", line)
            if m2:
                summary = line.strip()
    except Exception as e:  # noqa
        build_ok = False
        summary = f"could not run agape-rs: {e}"
    return status, build_ok, summary


def parse_test(path):
    header, body, in_body = {}, [], False
    with open(path, encoding="utf-8") as f:
        for line in f:
            if in_body:
                body.append(line.rstrip("\n"))
                continue
            s = line.strip()
            if s.startswith("//!"):
                c = s[3:].strip()
                if c == "---":
                    in_body = True
                    continue
                if ":" in c:
                    k, _, v = c.partition(":")
                    header[k.strip()] = v.strip()
            else:
                in_body = True
                body.append(line.rstrip("\n"))
    return header, "\n".join(body)


def collect_tests(status):
    tests = []
    for path in sorted(glob.glob(os.path.join(TESTS, "*", "*.ag"))):
        section = os.path.basename(os.path.dirname(path))
        h, body = parse_test(path)
        tid = h.get("id", os.path.splitext(os.path.basename(path))[0])
        st, reason = status.get(tid, ("pass", ""))
        directives = {k: h[k] for k in
                      ("provider", "attest", "manifest", "replay", "order", "spine", "contains", "absent")
                      if k in h}
        tests.append({
            "id": tid, "section": section, "expect": h.get("expect", ""),
            "error": h.get("error", ""), "spec": h.get("spec", ""),
            "note": h.get("note", ""), "body": body,
            "status": st, "reason": reason, "directives": directives,
            "rel": os.path.relpath(path, REPO).replace("\\", "/"),
        })
    return tests


def main():
    run = "--no-run" not in sys.argv
    status, build_ok, summary = run_conformance() if run else ({}, True, "(suite not run)")
    tests = collect_tests(status)
    spec = open(SPEC, encoding="utf-8").read()
    data = {
        "tests": tests,
        "spec_lines": spec.split("\n"),
        "build_ok": build_ok,
        "summary": summary,
        "passed": sum(1 for t in tests if t["status"] == "pass"),
        "total": len(tests),
    }
    blob = json.dumps(data).replace("</", "<\\/")
    out = TEMPLATE.replace("/*__DATA__*/", blob)
    dest = os.path.join(ROOT, "dashboard.html")
    with open(dest, "w", encoding="utf-8") as f:
        f.write(out)
    print(f"wrote {dest} — {data['passed']}/{data['total']} pass, build_ok={build_ok}")


TEMPLATE = r"""<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agape — Review Dashboard</title>
<style>
:root{--bg:#0f1115;--panel:#161a22;--panel2:#1d2330;--ink:#e6e9ef;--dim:#9aa4b2;--line:#2a3140;
--ok:#3fb950;--bad:#f85149;--accent:#58a6ff;--warn:#d29922;--mono:'SF Mono',ui-monospace,Menlo,Consolas,monospace}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif}
header{display:flex;align-items:center;gap:16px;padding:12px 18px;border-bottom:1px solid var(--line);background:var(--panel)}
header h1{font-size:15px;margin:0;font-weight:600;letter-spacing:.2px}
.badge{font:600 12px/1 var(--mono);padding:5px 9px;border-radius:6px;background:var(--panel2)}
.badge.ok{color:var(--ok)} .badge.bad{color:var(--bad)}
.tabs{display:flex;gap:4px;margin-left:8px}
.tab{padding:6px 14px;border-radius:7px;cursor:pointer;color:var(--dim);font-weight:500}
.tab.on{background:var(--panel2);color:var(--ink)}
.spacer{flex:1}
button{font:inherit;cursor:pointer;border:1px solid var(--line);background:var(--panel2);color:var(--ink);border-radius:7px;padding:6px 12px}
button.primary{background:var(--accent);border-color:var(--accent);color:#04101f;font-weight:600}
main{height:calc(100vh - 53px);overflow:hidden}
.view{display:none;height:100%} .view.on{display:flex}
/* spec */
#specNav{width:240px;overflow:auto;border-right:1px solid var(--line);padding:10px 0;background:var(--panel)}
#specNav a{display:block;padding:3px 16px;color:var(--dim);text-decoration:none;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#specNav a.h3{padding-left:30px;font-size:12px}
#specNav a:hover{color:var(--ink);background:var(--panel2)}
#specBody{flex:1;overflow:auto;padding:0 0 200px}
.sline{display:flex;font:13px/1.6 var(--mono);white-space:pre-wrap}
.sline:hover{background:#12161d}
.sline .ln{width:54px;text-align:right;padding-right:12px;color:#48515f;user-select:none;flex:none;cursor:pointer}
.sline .tx{flex:1;padding-right:18px}
.sline.hd .tx{color:var(--accent);font-weight:600}
.sline.noted{background:#1a1d12} .sline.noted .ln{color:var(--warn)}
/* tests */
#testsWrap{flex:1;display:flex;flex-direction:column}
.filters{display:flex;gap:8px;align-items:center;padding:10px 16px;border-bottom:1px solid var(--line);background:var(--panel)}
.filters input,.filters select{font:inherit;background:var(--panel2);border:1px solid var(--line);color:var(--ink);border-radius:7px;padding:6px 10px}
.filters input{flex:1;max-width:320px}
.tlist{flex:1;overflow:auto}
.trow{display:grid;grid-template-columns:18px 1fr 130px 90px 110px;gap:10px;align-items:center;padding:8px 16px;border-bottom:1px solid #1b2230;cursor:pointer}
.trow:hover{background:var(--panel2)}
.dot{width:9px;height:9px;border-radius:50%}
.dot.pass{background:var(--ok)} .dot.fail{background:var(--bad)}
.tid{font:600 13px/1 var(--mono)}
.tsec{color:var(--dim);font-size:12px}
.pill{font:600 11px/1 var(--mono);padding:3px 7px;border-radius:5px;background:var(--panel2);color:var(--dim);justify-self:start}
.pill.accept{color:var(--ok)} .pill.reject{color:var(--warn)}
.detail{background:#0c0e13;border-bottom:1px solid var(--line);padding:14px 16px 16px 44px}
.detail pre{margin:8px 0 0;font:12.5px/1.55 var(--mono);background:var(--panel);padding:12px 14px;border-radius:8px;overflow:auto;border:1px solid var(--line)}
.detail .meta{color:var(--dim);font-size:12.5px}
.detail .reason{color:var(--bad);font:12.5px/1.5 var(--mono);margin-top:8px;white-space:pre-wrap}
.k{color:var(--accent)} .c{color:#7d8a99} .s{color:var(--ok)}
/* results */
#results{flex:1;overflow:auto;padding:22px 26px}
.rrow{display:grid;grid-template-columns:170px 1fr 70px;gap:14px;align-items:center;margin:7px 0}
.bar{height:18px;border-radius:5px;background:#241b1d;overflow:hidden;display:flex}
.bar i{display:block;height:100%;background:var(--ok)}
.rsec{font:600 13px/1 var(--mono);color:var(--dim)}
.rnum{font:12px/1 var(--mono);color:var(--dim);text-align:right}
/* notes */
#fbBtn{position:fixed;right:18px;bottom:18px;z-index:20}
#fbPanel{position:fixed;right:18px;bottom:64px;width:380px;max-height:60vh;background:var(--panel);border:1px solid var(--line);border-radius:12px;display:none;flex-direction:column;z-index:20;box-shadow:0 12px 40px #0008}
#fbPanel.on{display:flex}
#fbPanel h3{margin:0;padding:12px 14px;border-bottom:1px solid var(--line);font-size:13px}
#fbList{overflow:auto;padding:8px} .fbItem{background:var(--panel2);border-radius:8px;padding:8px 10px;margin:6px 0;font-size:13px}
.fbItem .loc{color:var(--accent);font:600 11px/1 var(--mono)} .fbItem .x{float:right;color:var(--dim);cursor:pointer}
#fbActions{display:flex;gap:8px;padding:10px 12px;border-top:1px solid var(--line)}
dialog{background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:12px;width:460px;padding:0}
dialog h3{margin:0;padding:12px 16px;border-bottom:1px solid var(--line);font-size:13px}
dialog .loc{color:var(--accent);font:600 12px/1 var(--mono);padding:10px 16px 0}
dialog textarea{width:calc(100% - 32px);margin:10px 16px;height:90px;background:var(--panel2);color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:10px;font:inherit;resize:vertical}
dialog .row{display:flex;gap:8px;justify-content:flex-end;padding:0 16px 14px}
.toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:var(--ok);color:#04101f;font-weight:600;padding:8px 16px;border-radius:8px;z-index:40;opacity:0;transition:.2s}
.toast.on{opacity:1}
</style></head>
<body>
<header>
  <h1>Agape · Review</h1>
  <span id="score" class="badge"></span>
  <span id="build" class="badge"></span>
  <div class="tabs">
    <div class="tab on" data-v="spec">Spec</div>
    <div class="tab" data-v="tests">Tests</div>
    <div class="tab" data-v="results">Results</div>
  </div>
  <div class="spacer"></div>
  <span class="badge" id="ts"></span>
</header>
<main>
  <div class="view on" id="v-spec">
    <nav id="specNav"></nav>
    <div id="specBody"></div>
  </div>
  <div class="view" id="v-tests">
    <div id="testsWrap">
      <div class="filters">
        <input id="q" placeholder="search id / spec / source…">
        <select id="fSec"></select>
        <select id="fStat"><option value="">all</option><option value="pass">pass</option><option value="fail">fail</option></select>
        <span class="badge" id="tcount"></span>
      </div>
      <div class="tlist" id="tlist"></div>
    </div>
  </div>
  <div class="view" id="v-results"><div id="results"></div></div>
</main>

<button id="fbBtn" class="primary">Feedback (<span id="fbN">0</span>)</button>
<div id="fbPanel">
  <h3>Review notes</h3>
  <div id="fbList"></div>
  <div id="fbActions"><button class="primary" id="fbExport">Copy as markdown</button><button id="fbClear">Clear all</button></div>
</div>
<dialog id="noteDlg">
  <h3>Add a review note</h3>
  <div class="loc" id="noteLoc"></div>
  <textarea id="noteText" placeholder="what's wrong / a suggestion / a question…"></textarea>
  <div class="row"><button id="noteCancel">Cancel</button><button class="primary" id="noteSave">Save</button></div>
</dialog>
<div class="toast" id="toast"></div>

<script>
const DATA = /*__DATA__*/;
const NK = "agape-review-notes";
let notes = JSON.parse(localStorage.getItem(NK) || "[]");
const $ = s => document.querySelector(s);
const esc = s => s.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

/* ---- header ---- */
$("#score").textContent = `${DATA.passed}/${DATA.total} pass`;
$("#score").classList.add(DATA.passed===DATA.total?"ok":"bad");
$("#build").textContent = DATA.build_ok ? "build ok" : "BUILD FAILED";
$("#build").classList.add(DATA.build_ok?"ok":"bad");
$("#ts").textContent = new Date().toLocaleString();

/* ---- tabs ---- */
document.querySelectorAll(".tab").forEach(t=>t.onclick=()=>{
  document.querySelectorAll(".tab").forEach(x=>x.classList.remove("on"));
  document.querySelectorAll(".view").forEach(x=>x.classList.remove("on"));
  t.classList.add("on"); $("#v-"+t.dataset.v).classList.add("on");
});

/* ---- spec view ---- */
function specKey(n){return "SPEC.md:"+n}
function renderSpec(){
  const nav=$("#specNav"), body=$("#specBody"); nav.innerHTML=""; body.innerHTML="";
  DATA.spec_lines.forEach((ln,i)=>{
    const n=i+1, hd=/^#{1,3}\s/.test(ln);
    const row=document.createElement("div"); row.className="sline"+(hd?" hd":"");
    if(noteAt(specKey(n))) row.classList.add("noted");
    row.innerHTML=`<span class="ln" title="comment on line ${n}">${n}</span><span class="tx">${esc(ln)||" "}</span>`;
    row.querySelector(".ln").onclick=()=>openNote(specKey(n), ln.trim().slice(0,80));
    body.appendChild(row);
    const m=ln.match(/^(#{2,3})\s+(.*)/);
    if(m){const a=document.createElement("a");a.textContent=m[2];a.href="#";a.className=m[1].length>2?"h3":"";
      a.onclick=e=>{e.preventDefault();row.scrollIntoView({block:"start"})};nav.appendChild(a);}
  });
}

/* ---- tests view ---- */
function highlight(src){
  return esc(src)
    .replace(/(^\/\/!.*$)/gm,'<span class="c">$1</span>')
    .replace(/\b(agent|action|event|struct|enum|read|write|tool|grants|perform|emit|endorse|attest|abstain|policy|spawn|awake|sleep|on|when|case|if|else|return|retry|self|prompt|principal|sync|store|embed|Credence|Decision)\b/g,'<span class="k">$1</span>');
}
function renderTests(){
  const sel=$("#fSec"); const secs=[...new Set(DATA.tests.map(t=>t.section))].sort();
  sel.innerHTML='<option value="">all sections</option>'+secs.map(s=>`<option>${s}</option>`).join("");
  drawTests();
}
function drawTests(){
  const q=$("#q").value.toLowerCase(), fs=$("#fSec").value, fst=$("#fStat").value;
  const list=$("#tlist"); list.innerHTML="";
  const rows=DATA.tests.filter(t=>
    (!fs||t.section===fs)&&(!fst||t.status===fst)&&
    (!q||t.id.toLowerCase().includes(q)||(t.spec||"").toLowerCase().includes(q)||t.body.toLowerCase().includes(q)));
  $("#tcount").textContent=`${rows.length} shown`;
  rows.forEach(t=>{
    const row=document.createElement("div"); row.className="trow";
    row.innerHTML=`<span class="dot ${t.status}"></span>
      <span><span class="tid">${t.id}</span> ${noteAt("test:"+t.id)?'<span style="color:var(--warn)">●</span>':''}<div class="tsec">${t.section} · ${esc(t.spec||"")}</div></span>
      <span class="pill ${t.expect}">${t.expect}${t.error?" · "+t.error:""}</span>
      <span class="tsec">${Object.keys(t.directives).join(", ")}</span>
      <span class="pill ${t.status}" style="color:${t.status==='pass'?'var(--ok)':'var(--bad)'}">${t.status}</span>`;
    row.onclick=()=>toggleDetail(row,t);
    list.appendChild(row);
  });
}
function toggleDetail(row,t){
  if(row.nextSibling&&row.nextSibling.className==="detail"){row.nextSibling.remove();return;}
  const d=document.createElement("div"); d.className="detail";
  d.innerHTML=`<div class="meta">${t.rel}</div>
    ${t.note?`<div class="meta">note: ${esc(t.note)}</div>`:""}
    <pre>${highlight(t.body)}</pre>
    ${t.status==='fail'?`<div class="reason">✗ ${esc(t.reason)}</div>`:'<div class="meta" style="color:var(--ok)">✓ passing</div>'}
    <div style="margin-top:10px"><button data-c="1">Comment on this test</button></div>`;
  d.querySelector("[data-c]").onclick=()=>openNote("test:"+t.id, t.id);
  row.after(d);
}

/* ---- results view ---- */
function renderResults(){
  const bySec={};
  DATA.tests.forEach(t=>{(bySec[t.section]=bySec[t.section]||{p:0,n:0}); bySec[t.section][t.status==='pass'?'p':'n']++;});
  const r=$("#results"); r.innerHTML=`<div style="margin-bottom:18px;color:var(--dim)">${esc(DATA.summary||"")}</div>`;
  Object.keys(bySec).sort().forEach(s=>{
    const {p,n}=bySec[s], tot=p+n, pct=tot?Math.round(p/tot*100):0;
    const row=document.createElement("div"); row.className="rrow";
    row.innerHTML=`<span class="rsec">${s}</span><div class="bar"><i style="width:${pct}%"></i></div><span class="rnum">${p}/${tot}</span>`;
    r.appendChild(row);
  });
}

/* ---- notes ---- */
function noteAt(loc){return notes.find(n=>n.loc===loc)}
function saveNotes(){localStorage.setItem(NK,JSON.stringify(notes));$("#fbN").textContent=notes.length;renderFb();}
let pendingLoc=null;
function openNote(loc,ctx){pendingLoc=loc;$("#noteLoc").textContent=loc+(ctx?"  —  "+ctx:"");
  $("#noteText").value=(noteAt(loc)||{}).text||"";$("#noteDlg").showModal();$("#noteText").focus();}
$("#noteSave").onclick=()=>{const t=$("#noteText").value.trim();notes=notes.filter(n=>n.loc!==pendingLoc);
  if(t)notes.push({loc:pendingLoc,text:t,ts:Date.now()});saveNotes();$("#noteDlg").close();
  renderSpec();drawTests();};
$("#noteCancel").onclick=()=>$("#noteDlg").close();
function renderFb(){const l=$("#fbList");l.innerHTML=notes.length?"":'<div style="color:var(--dim);padding:10px">No notes yet. Click a spec line number or a test to comment.</div>';
  notes.slice().reverse().forEach(n=>{const d=document.createElement("div");d.className="fbItem";
    d.innerHTML=`<span class="x" title="delete">✕</span><div class="loc">${n.loc}</div>${esc(n.text)}`;
    d.querySelector(".x").onclick=()=>{notes=notes.filter(x=>x!==n);saveNotes();renderSpec();drawTests();};l.appendChild(d);});}
$("#fbBtn").onclick=()=>$("#fbPanel").classList.toggle("on");
$("#fbClear").onclick=()=>{if(confirm("Delete all notes?")){notes=[];saveNotes();renderSpec();drawTests();}};
$("#fbExport").onclick=()=>{
  const md="## Agape review feedback\n\n"+notes.map(n=>`- **${n.loc}** — ${n.text}`).join("\n")+"\n";
  navigator.clipboard.writeText(md).then(()=>toast("Feedback copied — paste it in chat"));
};
function toast(m){const t=$("#toast");t.textContent=m;t.classList.add("on");setTimeout(()=>t.classList.remove("on"),2200);}

$("#q").oninput=drawTests;$("#fSec").onchange=drawTests;$("#fStat").onchange=drawTests;
renderSpec();renderTests();renderResults();renderFb();$("#fbN").textContent=notes.length;
</script>
</body></html>
"""

if __name__ == "__main__":
    main()
