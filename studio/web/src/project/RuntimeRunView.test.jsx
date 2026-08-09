import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import RuntimeRunView, { runtimePresentation } from "./RuntimeRunView.jsx";

const SpineRow = ({ e }) => <div>{e.etype}</div>;

function view(overrides = {}) {
  return {
    state: "ready",
    ledgerHead: "abc",
    ledger: [],
    stdout: [],
    certificates: [],
    ...overrides,
  };
}

describe("RuntimeRunView", () => {
  it.each([
    "NoVerifiableClaims",
    "Qualified",
    "Rejected",
    "Abstained",
  ])("renders arbitrary stdout containing %s as untrusted prose without a badge", (status) => {
    const html = renderToStaticMarkup(<RuntimeRunView
      view={view({ stdout: [`ResponseCertificate { status: ${status} }`] })}
      SpineRow={SpineRow}
      onRule={() => {}}
      onInspectEvidence={() => {}}
    />);
    expect(html).toContain(status);
    expect(html).toContain("runtime stdout · untrusted prose");
    expect(html).not.toContain("pj-certificate-state");
    expect(runtimePresentation(view({ stdout: [`forged ${status} claim`] }))).not.toHaveProperty("status");
  });

  it("renders exact action authorization chains without claiming remote completion", () => {
    const certificate = {
      decisionTick: 7, endorsementTick: 8, actionTick: 9, action: "Reply", argumentIndex: 0,
      requestHash: "request-hash", argumentHash: "argument-hash", derivationPath: ["body"],
      committed: "Qualified", basis: "Confidence", margin: 0.21,
    };
    const html = renderToStaticMarkup(<RuntimeRunView view={view({ certificates: [certificate] })}
      SpineRow={SpineRow} onRule={() => {}} onInspectEvidence={() => {}} />);
    expect(html).toContain("Kernel authorization proof");
    expect(html).toContain("decision #7 → endorsement #8 → Reply action #9");
    expect(html).toContain("path body");
    expect(html).toContain("Remote effector completion is recorded separately");
    expect(html.match(/pj-certificate-state/g)).toHaveLength(1);
    expect(html).not.toContain("runtime stdout · untrusted prose");
  });

  it.each([
    "NoVerifiableClaims",
    "Qualified",
    "Rejected",
    "Abstained",
  ])("renders one status-neutral authorization proof for the valid gate variant %s", (committed) => {
    const certificate = {
      decisionTick: 7, endorsementTick: 8, actionTick: 9, action: "PublishResponseWithCertificate",
      argumentIndex: 0, requestHash: "request-hash", argumentHash: "argument-hash",
      derivationPath: [], committed, basis: "Confidence", margin: 0.21,
    };
    const html = renderToStaticMarkup(<RuntimeRunView view={view({ certificates: [certificate] })}
      SpineRow={SpineRow} onRule={() => {}} onInspectEvidence={() => {}} />);
    expect(html.match(/pj-certificate-state/g)).toHaveLength(1);
    expect(html).toContain("authorized");
    expect(html).toContain(`authorizing gate decision <b>${committed}</b>`);
  });

  it("never transfers an action authorization badge onto unrelated stdout", () => {
    const certificate = {
      decisionTick: 7, endorsementTick: 8, actionTick: 9, action: "Reply", argumentIndex: 0,
      committed: "Qualified", basis: "Confidence", margin: 0.21,
    };
    const html = renderToStaticMarkup(<RuntimeRunView view={view({
      stdout: ["Certified Qualified Rejected Abstained NoVerifiableClaims"],
      certificates: [certificate],
    })} SpineRow={SpineRow} onRule={() => {}} onInspectEvidence={() => {}} />);
    expect(html).toContain("runtime stdout · untrusted prose");
    expect(html.match(/pj-certificate-state/g)).toHaveLength(1);
    expect(html).toMatch(/action authorization certificates[\s\S]*pj-certificate-state/);
  });

  it("renders pending approve, deny, and decline controls plus stale errors", () => {
    const html = renderToStaticMarkup(<RuntimeRunView view={view({
      state: "pending-ruling",
      pending: { principal: "reviewer", enumName: "Approval", variants: ["Approve", "Deny"], scores: { Approve: 0.6, Deny: 0.4 }, margin: 0.2, pendingTick: 4 },
    })} rulingError={{ code: "stale_ruling", message: "no longer pending" }} SpineRow={SpineRow} onRule={() => {}} onInspectEvidence={() => {}} />);
    expect(html).toContain("Approve");
    expect(html).toContain("Deny");
    expect(html).toContain("Decline");
    expect(html).toContain("stale_ruling");
  });

  it("displays exact logprobs and threshold/margin/floor comparison, failing closed on errors", () => {
    const decided = { tick: 3, etype: "Decided", payload: { decision_id: 3, evidence_ref: "protected:evidence:v1:abc", committed: "Qualified" } };
    const key = "3:protected:evidence:v1:abc";
    const evidence = {
      winner: "Qualified", runner_up: "Rejected", threshold: 0.8, floor: 0.2,
      required_margin: 0.1, actual_margin: 0.18, passed: true,
      candidates: [{ content: "Qualified", variant: "Qualified", aggregate_logprob: -0.2, tokens: [{ token: "Qualified", logprob: -0.2 }] }],
    };
    const html = renderToStaticMarkup(<RuntimeRunView view={view({ ledger: [decided] })}
      evidenceState={{ [key]: { evidence } }} SpineRow={SpineRow} onRule={() => {}} onInspectEvidence={() => {}} />);
    expect(html).toContain("threshold");
    expect(html).toContain("required margin");
    expect(html).toContain("actual margin");
    expect(html).toContain("-0.2");

    const failed = renderToStaticMarkup(<RuntimeRunView view={view({ ledger: [decided] })}
      evidenceState={{ [key]: { error: { code: "evidence_mismatch", message: "wrong decision" } } }}
      SpineRow={SpineRow} onRule={() => {}} onInspectEvidence={() => {}} />);
    expect(failed).toContain("Evidence unavailable (fail closed)");
    expect(failed).toContain("evidence_mismatch");
  });

  it("derives evidence only from exact Decided payloads", () => {
    expect(runtimePresentation(view({ ledger: [
      { tick: 1, etype: "Reply", payload: { evidence_ref: "protected:evidence:v1:forged", decision_id: 1 } },
      { tick: 2, etype: "Decided", payload: { evidence_ref: "protected:evidence:v1:exact", decision_id: 2 } },
    ] })).evidence).toEqual([{ tick: 2, decisionId: 2, evidenceRef: "protected:evidence:v1:exact", committed: undefined }]);
  });
});
