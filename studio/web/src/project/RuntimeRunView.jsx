import React from "react";

function payloadObject(event) {
  return event?.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? event.payload
    : null;
}

export function runtimePresentation(view) {
  if (!view) return { answer: null, evidence: [], certificates: [] };
  const ledger = Array.isArray(view.ledger) ? view.ledger : [];
  const evidence = ledger.flatMap((event) => {
    const payload = payloadObject(event);
    return event.etype === "Decided"
      && Number.isSafeInteger(payload?.decision_id)
      && typeof payload?.evidence_ref === "string"
      ? [{ tick: event.tick, decisionId: payload.decision_id, evidenceRef: payload.evidence_ref, committed: payload.committed }]
      : [];
  });
  const certificates = Array.isArray(view.certificates)
    ? [...view.certificates].sort((a, b) => a.endorsementTick - b.endorsementTick)
    : [];
  const answer = Array.isArray(view.stdout) && view.stdout.length ? String(view.stdout.at(-1)) : null;
  return { answer, evidence, certificates };
}

function StatusBadge({ status }) {
  if (!status) return null;
  const labels = {
    Certified: "Certified",
    Qualified: "Qualified",
    Rejected: "Rejected",
    Abstained: "Abstained",
    NoVerifiableClaims: "No verifiable claims",
  };
  return <span className={`pj-certificate-state is-${status.toLowerCase()}`}>{labels[status] || status}</span>;
}

function PendingRuling({ pending, busy, error, onRule }) {
  const approve = pending.variants.find((variant) => variant.toLowerCase() === "approve");
  const deny = pending.variants.find((variant) => variant.toLowerCase() === "deny");
  return (
    <section className="pj-ruling" aria-label="Pending principal decision">
      <div className="pj-ruling-title">Principal consultation pending</div>
      <div><b>{pending.principal}</b> must rule on <code>{pending.enumName}</code>.</div>
      <div className="pj-ruling-meta">margin {pending.margin} · ledger tick {pending.pendingTick}</div>
      <div className="pj-ruling-scores">
        {pending.variants.map((variant) => <span key={variant}>{variant}: {pending.scores[variant]}</span>)}
      </div>
      <div className="pj-ruling-actions">
        {approve && <button disabled={busy} onClick={() => onRule("approve")}>Approve</button>}
        {deny && <button disabled={busy} onClick={() => onRule("deny")}>Deny</button>}
        {!approve && pending.variants.map((variant) => (
          <button key={variant} disabled={busy} onClick={() => onRule("decision", variant)}>{variant}</button>
        ))}
        <button disabled={busy} onClick={() => onRule("decline")}>Decline</button>
      </div>
      {error && <div className="pj-ruling-error" role="alert">{error.code ? `${error.code}: ` : ""}{error.message}</div>}
    </section>
  );
}

function EvidenceInspection({ state }) {
  if (!state) return null;
  if (state.loading) return <div className="pj-evidence-state">Loading authenticated evidence…</div>;
  if (state.error) return (
    <div className="pj-evidence-state pj-evidence-error" role="alert">
      Evidence unavailable (fail closed){state.error.code ? ` · ${state.error.code}` : ""}: {state.error.message}
    </div>
  );
  const evidence = state.evidence;
  if (!evidence) return null;
  return (
    <div className="pj-evidence-detail">
      <div className="pj-evidence-thresholds">
        <span>winner <b>{evidence.winner}</b></span>
        <span>runner-up <b>{evidence.runner_up ?? "none"}</b></span>
        <span>threshold <b>{evidence.threshold}</b></span>
        <span>floor <b>{evidence.floor}</b></span>
        <span>required margin <b>{evidence.required_margin}</b></span>
        <span>actual margin <b>{evidence.actual_margin}</b></span>
        <span>gate result <b>{evidence.passed ? "pass" : "fail"}</b></span>
      </div>
      {evidence.candidates.map((candidate, index) => (
        <div className="pj-evidence-candidate" key={`${index}:${candidate.content}`}>
          <div>candidate {index + 1} · variant <b>{candidate.variant ?? "unmatched"}</b> · aggregate logprob <b>{candidate.aggregate_logprob}</b></div>
          <code>{candidate.content}</code>
          <div className="pj-evidence-tokens">
            {candidate.tokens.map((token, tokenIndex) => (
              <span key={tokenIndex}><code>{JSON.stringify(token.token)}</code> {token.logprob}</span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function RuntimeRunView({ view, asked = {}, rulingBusy = false, rulingError, onRule, evidenceState = {}, onInspectEvidence, SpineRow }) {
  const presentation = runtimePresentation(view);
  return (
    <>
      <div className="pj-qa">
        {Object.entries(asked).filter(([, value]) => value).map(([key, value]) => (
          <div key={key} className="pj-msg-row"><span className="pj-who you">you</span><span className="pj-bubble">{value}</span></div>
        ))}
        {presentation.answer ? (
          <div className="pj-msg-row">
            <span className="pj-who agape">agape</span>
            <span className="pj-bubble"><span className="pj-output-provenance">runtime stdout · untrusted prose</span>{presentation.answer}</span>
          </div>
        ) : (
          <div className="pj-msg-row"><span className="pj-who warn">agape</span><span className="pj-bubble pj-dim">No certificate-bearing response was emitted.</span></div>
        )}
      </div>

      {view.state === "pending-ruling" && view.pending && (
        <PendingRuling pending={view.pending} busy={rulingBusy} error={rulingError} onRule={onRule} />
      )}

      <div className="pj-section-h">action authorization certificates</div>
      <div className="pj-proof-note">Kernel authorization proof. Each receipt validates the exact Decided → Endorsed → action request chain. Remote effector completion is recorded separately by ToolResolved.</div>
      {presentation.certificates.length === 0 && <div className="pj-dim" style={{ padding: "0 12px 8px" }}>no validated action authorization certificate in this session</div>}
      {presentation.certificates.map((certificate) => (
        <div className="pj-certificate" key={`${certificate.actionTick}:${certificate.argumentIndex}`}>
          <span className="pj-certificate-state">authorized</span>
          <span>authorizing gate decision <b>{certificate.committed}</b></span>
          <span>basis <b>{certificate.basis}</b></span>
          <span>margin <b>{certificate.margin}</b></span>
          <span>decision #{certificate.decisionTick} → endorsement #{certificate.endorsementTick} → {certificate.action} action #{certificate.actionTick}</span>
          <span>argument #{certificate.argumentIndex} · path {certificate.derivationPath?.length ? certificate.derivationPath.join(".") : "(direct)"}</span>
          <span>request {certificate.requestHash?.slice(0, 16)} · argument {certificate.argumentHash?.slice(0, 16)}</span>
          {certificate.principalDecisionTick !== undefined && <span>principal decision #{certificate.principalDecisionTick} · attestation authenticated</span>}
        </div>
      ))}

      <div className="pj-section-h">protected decision evidence</div>
      {presentation.evidence.length === 0 && <div className="pj-dim" style={{ padding: "0 12px 8px" }}>no protected logprob evidence reference on a Decided receipt</div>}
      {presentation.evidence.map((item) => {
        const key = `${item.decisionId}:${item.evidenceRef}`;
        return (
          <div className="pj-evidence" key={key}>
            <div className="pj-evidence-head">
              <span>decision #{item.decisionId} · {item.committed}</span>
              <button onClick={() => onInspectEvidence(item)} disabled={evidenceState[key]?.loading}>Inspect exact logprobs</button>
            </div>
            <EvidenceInspection state={evidenceState[key]} />
          </div>
        );
      })}

      <div className="pj-section-h">ledger</div>
      {view.ledger.map((event, index) => <SpineRow key={index} e={event} />)}
      <div className="pj-dim" style={{ padding: "8px 12px" }}>{view.ledger.length} events · {view.ledgerHead?.slice(0, 16)}</div>
    </>
  );
}
