// The bottom panel in "Spine" mode — the hero of the event cockpit. A live,
// auto-tailing view of the append-only event spine (SPEC §7). Color encodes kind:
// errors red, Think pairs blue, emits/internalize teal, verifications amber.
import { useEffect, useRef } from "react";

function evClass(e) {
  if (e.is_error) return "error";
  if (e.etype.startsWith("Think")) return "think";
  if (e.etype === "Event" || e.etype === "Internalize") return "emit";
  if (e.etype.includes("Verification") || e.etype === "CalibratorAttest") return "verify";
  return "";
}

function fmtPayload(p) {
  if (p === null || p === undefined) return "";
  return typeof p === "object" ? JSON.stringify(p) : String(p);
}

export default function SpinePanel({ events }) {
  const ref = useRef(null);
  const stick = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [events.length]);

  const onScroll = () => {
    const el = ref.current;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  return (
    <div className="panel-body" ref={ref} onScroll={onScroll}>
      {events.length === 0 && <div className="empty">the spine is empty — Run a program</div>}
      {events.map((e) => (
        <div className={"ev " + evClass(e)} key={e.tick} title={e.corr ? "corr " + e.corr : ""}>
          <span className="tick">{e.tick}</span>
          <span className="etype">{e.etype}</span>
          <span className="pay">
            {e.subject != null && <span className="subj">{String(e.subject)} </span>}
            {fmtPayload(e.payload)}
          </span>
          <span className="ag">{e.agent ? "@" + e.agent : ""}</span>
        </div>
      ))}
    </div>
  );
}
