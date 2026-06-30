# Conformance Suite ↔ Spec Lockstep Audit

> **2026-06-30 — SPEC.md gate model finalized.** The decision gate was redesigned and locked:
> `decide c by r` → `Decision` (`.committed`/`.basis`/`.margin`), optional `p decide` principal
> prefix; `endorse s by d` → `Endorsement<T>` (the settled subject, coerces to T at a sink);
> arms are sugar over `if (e.committed == V)`; `case` removed; abstain-safety is static; one runtime
> sink check (margin floor → `MarginFloorViolation`). Two adversarial verification passes (90 → 8
> findings, all applied) converged with 0 critical. **The conformance suite below has NOT yet been
> re-aligned to this finalized spec** — that is Phase 2, and supersedes the gate-de-stale section.



> Date: 2026-06-29. Spec audited: `../SPEC.md` (v1.0.0-alpha.2026.6.29.0), including the
> runtime contract now folded into §16/§17. Method: full side-by-side, every spec section vs
> every `.ag` test (206 tests across 21 dirs). This file is the worklist for closing gaps.

## Verdict

The **static language kernel** (§3 types, §4 color, §13 authority/taint, §15.3 W-rules, §15.6
T1/T2/T5) is in tight lockstep — comprehensive accept/reject pairs. The **dynamic operational
layer** (§15.4 E-rules, lifecycle, messaging, queries, subscriptions) is fully covered. Three
areas are out of lockstep:

1. **Gate-syntax migration is incomplete** — ~45 tests (≈1 in 5) still use the *removed*
   `certify`/`attest`/`decide c { arms }` forms and dead event names. This is the dominant issue.
2. **The runtime contract (§16/§17) is essentially untested** — the memory envelope, isolation,
   artifact internalization, learning, API surface, and 7/10 §17.5 memory-conformance items have
   zero coverage, and most aren't even expressible with the current harness.
3. **The probabilistic/reproducibility layer (§15.5)** beyond recorded replay is untested and
   gated on a harness capability (multi-run / sampling / two-run-≈) that was specified but never built.

---

## 0. Suite hygiene (mechanical lockstep) — ✅ DONE 2026-06-29

- ✅ **Freshness check now passes.** Renamed `gov_certify_endorsement_allows_perform.ag` →
  `gov_certify_endorsed_decision_allows_perform.ag` to match its header id (the lone validation
  blocker). `build_manifests.py --check` is green.
- ✅ **All tests indexed.** Was 197 of 206; manifests regenerated → now **208** (added 2 MED-gap
  tests, below). The old 197 was a stale manifest from before the check started failing.
- ✅ **Version/filename refs fixed.** `build_manifests.py`, conformance `README.md`, and `COVERAGE.md`
  now say `v1.0.0-alpha.2026.6.29.0` and point at `../SPEC.md` (not the nonexistent `SPEC-1.0.md`).
  Also corrected two `§16.5 harness contract` comments → `§17.5` (the harness moved there in the merge).
- ✅ **Stale config-key tests fixed.** Dropped the fabricated `config.require_bindings` flag from
  `cfg_missing_{principal,prompt,tool}_binding_reject` + `cfg_strict_bindings_ok` (§17.1 makes an
  unbound dep an unconditional ConfigError); retargeted `cfg_eager_internalize` →
  `cfg_internalize_is_mandatory` (the `memory.internalize_on_receive` opt-in is gone; the envelope is
  mandatory, §16.7); fixed the stale note in `mem_store_internalizes_ok`.
- ✅ **2 testable-now MED-gap tests added** (clean of the gate surface): `ctrl_retry_unbounded_reject`
  (§11, ParseError — `retry` with no `(N)`), `agg_partial_dep_coverage_reject` (§12, TypeError —
  N≥3 with one pair uncovered).
- ⏳ **STILL OPEN — harness vocabulary is stale** (deferred to the gate-de-stale workstream, since the
  tests still *use* these): README ledger-matcher list + the `attest:` directive reference
  `Decided`/`Attestation`/`FailedAttestation`/`Certified` and `attest:` — none exist in current §9
  (now `Endorsed`/`Abstained`/`PrincipalDecision`/`Contradiction`, + `FailedPrincipalDecision`). Update
  these together with the stale gate tests. Also confirm error class `GateError` vs §20.3's bare
  "compile error".

---

## 1. Gate-syntax migration (DOMINANT — ~45 stale tests)

Current canonical gate (§13, §15.2, §20):
- `decide c by (rule|expr)` — an **expression**, `Credence<E> → Decision<E>`. No arms, no `default`,
  no `defer to`, no principal-prefix. Inline rule = `confidence θ [margin δ] | conformal α`.
- `endorse subject by d { Variant as e { block } } abstain { block }` — the **statement** with
  colon-free `Variant block` arms; deference = `decide c by principal` inside `abstain`.
- Events: `Endorsed` / `Abstained` / `PrincipalDecision` / `Contradiction`.

**Removed forms still present in tests:** `certify`, `attest`, `endorse(...)`-as-expression, bare
`c by R` (no `decide`), `decide c { A: ... }` (decide-with-colon-arms), principal-prefix `p decide c`,
`defer to p`, `default:` endorse arm. **Removed event names asserted:** `Decided`, `Attestation`,
`FailedAttestation`, `Certified`.

Stale tests to migrate to the two-step `decide`+`endorse`:
- **`22_gate/` — all 19** (gate_all_reversible_no_principal_accept, gate_cold_*, gate_decide_*,
  gate_decision_* ×3, gate_endorsement_* ×4, gate_file_conformal_decl_accept, gate_nonreversible_no_principal_reject,
  gate_per_gate_conformal_accept, gate_reversible_* ×3). `gate_reversible_tie_default` uses a
  `default:` arm that no longer exists → use `abstain`.
- **`13_governance/` — 15**: gov_attest_* ×3, gov_certify_* ×4, gov_conformal_coldstart_abstains,
  gov_conformal_gate_ok, gov_consequential_bare_collapse_reject, gov_endorse_abstain_ok,
  gov_endorse_records_decided_ok (`Decided`→`Endorsed`), gov_endorsed_perform_ok,
  gov_margin_floor_abstains (`absent: Decided`→`absent: Endorsed`), gov_grants_star_ok (gate body only).
- **`00_lexical`..`04_functions` — 6**: axes_collapse_is_decision, axes_credence_is_graded_judgment,
  type_enum_decl_and_case (bare `c by`); type_no_text_to_principal_reject, fn_sync_attest_by_principal_reject
  (removed `attest`); fn_sync_inhand_endorse_ok (`endorse(...)` returning a `Decision` — incoherent;
  spec ln409 wants `return decide c by confidence 0.9;`).
- **`21_interfaces` — 1**: iface_outcome_mismatch_reject uses inline `endorse (c by confidence …)` —
  risks ParseError instead of the asserted InterfaceError.
- **The `endorse (X by R) { true: ; false: ; }` subjectless+colon-arm convention** (~16 tests incl.
  ctrl_retry_bounded, agg_all_independent_ok, agg_dependent_fuse_ok, agg_quorum_independent_ok) —
  see §4 below: this one is **coupled to a spec bug** (the §12 examples sanction it).

The 10 CLEAN governance tests (do not touch): gov_perform_ungranted_reject, gov_reach_ungranted_reject,
gov_use_tool_ungranted_reject, gov_use_tool_granted_ok, gov_extend_use_subtractive_reject,
gov_perform_reach_subtractive_reject, gov_tool_requires_effect_class_reject,
gov_read_tool_settled_perform_ok, gov_tool_result_tainted_perform_reject,
gov_write_tool_settled_ok/unsettled_reject, gov_write_tool_replay_chain_head.

---

## 2. Runtime contract (§16/§17) — biggest coverage hole

**Stale config tests (non-spec keys in active use):**
- `cfg_eager_internalize` — `memory.internalize_on_receive` key does not exist; §16.7 makes the
  consult+internalize envelope **mandatory on every reaction**. Retarget to assert mandatory
  internalization with no flag. (`mem_store_internalizes_ok` note has the same stale claim.)
- `cfg_missing_{principal,prompt,tool}_binding_reject` + `cfg_strict_bindings_ok` — gate on a
  fabricated `config.require_bindings` flag; §17.1 says an unbound declared dependency is **always**
  a ConfigError. Drop the flag; reject unconditionally.

**HIGH gaps (uncovered runtime obligations):**
- §16.1a per-instance memory isolation across two instances of one template (§17.5#2).
- §16.2 canonical-vs-non-canonical fields — wall-clock `ts` excluded from chain-head (vary `ts`, assert equal head).
- §16.5 replay must NOT re-invoke decomposition/summarization/embedding (§17.5#9).
- §16.7 mandatory consult incl. empty memory → `MemoryConsulted` (§17.5#1); no silent bypass.
- §16.7 memory cannot launder trust *through a turn*; memory cannot rewrite source `instruction`/`grants`/policy.
- §16.7b artifact ingest → `ArtifactObserved` + summary+chunks+facts+graph+vectors (§17.5#3); idempotent re-ingest (#4).
- §16.7c failure→lesson (#5), success→pattern (#6), user-correction precedence (#7).

**Harness capabilities that must be built first (P0 blockers):**
1. Ledger matchers for `MemoryConsulted` and `ArtifactObserved`.
2. An artifact-ingest directive (drives §16.7b).
3. A multi-instance driver (drives §16.1a isolation).
4. A memory-decomposition/embedding oracle script + replay "not re-invoked" assertion.
5. A user-correction injection directive.

**Runtime/metadata (separate harness, not `.ag`):** §16.9 API surface + the "`config.write` cannot
set a gate threshold/margin/floor/α" and "`memory.*` cannot launder trust" invariants; §17.6 six-part
release report / `health`; §16.8 profile invalidation; §16.7a Conflict projection.

---

## 3. Probabilistic / reproducibility layer (§15.5) — harness-gated

Recorded-replay/T4 is covered (`repro_chain_head_equal`, `gov_write_tool_replay_chain_head`).
Everything else in §15.5 is untested because the harness only shipped `chain_head_equal` — there is
no multi-run / N-sample / two-run-≈ mode:
- §15.5.2/.3 observational equivalence `≈` and stochastic consistency `∀R1,R2. R1≈R2`; `≈_Text := sim≥θ`.
- §15.5.5 Stability (ii) `Pr(obs≉) ≤ Σβ(δⱼ)` monotone in `m`; Lemma 2 quorum margin-tightening
  (`agg_quorum_independent_ok` covers only the type-level fuse).
- §15.5.6(A) conformal Coverage theorem `Pr(y∈Cα)≥1−α` (only the cold-start abstain path is tested).
- T3 non-interference bisimulation (only the static W-Consequential surrogate is tested).
- §15.5.5 exactly-gated vs bounded-gated (`==`-on-prose fragility) distinction.
- §15.5.4 idempotency (re-feed I ⇒ equal committed outcome; exactly-once dedup).

These need a sampling/two-run harness mode. Until then they cannot be black-box tested.

---

## 4. Other HIGH content gaps (testable now or with modest work)

- **§6 illegal-trace rejection — zero coverage.** No negative test for Delivered-without-Sent,
  Resolved-without-Delivered, or Delivered-after-Expired (the core §6 safety property, tested only on
  its legal side).
- **§10 recall taint never proven at a sink.** No test shows a `mem -> "q"` recall result rejected at
  a `perform`/write — the load-bearing "recall ALWAYS tainted, no laundering" invariant. The existing
  taint reject (`mem_queried_fact_taint_reject`) is over `select`, not `->`.
- **§13 subject-scope requirement** (a decision about X cannot endorse Y) — zero coverage.
- **§13/§20.3 distribution-source check**, **§13 GateProfile invalidation/staleness**, **§13/§16.8
  mature calibrated / `Basis::Calibrated` decision basis** — zero coverage.
- **§5 `instruction` injection-proof / append-only-under-extend** — only acceptance is tested; no
  child-cannot-weaken-parent, no memory-cannot-rewrite-system-prompt.
- **§6b replay never re-invokes (esp. write tool)** — asserted only via chain-head identity, not
  proven by non-invocation.
- **§19.1 "no second authority" negative test** — the section's headline safety invariant has no test.
- **§15.3 W-Call interprocedural κ rejection** — taint rejects fire only at depth-0 sinks, never
  through a user-fn consequential parameter (undercuts the "interprocedural" claim).

---

## 5. Representative MED gaps

- §2 `->` lexes-ok / non-mem-LHS TypeError has no test in the lexical dir (only §10 covers the reject).
- §3 "Rule is not a type" (Rule annotation reject); `decide c by "alice"` TypeError (only the dead-attest test).
- §8 Credence score-vector recording; array-operand judgment decomposition; TypeMismatch catchability.
- §10 QueryResult statement-form positive; match-hit-needs-endorsement; settled-when-origin-endorsed; ledger-is-not-memory (`ledger -> "q"` reject; Endorsed-reads-back-settled).
- §11 gated-case abstain path; retry assignment-persistence; unbounded-retry reject.
- §12 partial dependence coverage (N≥3 with one pair missing); async `|>` fan-out (current test pipes a `sync` fn).
- §19.2a whole-prefix `pub import m;`; §19.3 git/rev pinned dependency (and the `packages:` directive can't express it); §19.2 default module-path derivation; §15.2 explicit `module` header has no accept test.

---

## 6. Spec inconsistencies the audit surfaced (fix in SPEC.md for single-picture coherence)

1. **§12 endorse examples contradict the grammar.** §12 (the `quorum` example, ~line 1031/1036) uses
   `endorse (agreed by confidence 0.9) { ... }` — subjectless, parenthesized — but §15.2
   (`endorse ::= "endorse" expr "by" expr endorsearms`) requires a subject and §13 examples use
   `endorse subject by d { Variant as e block }`. Fix the §12 examples to the two-step canonical form.
   (This is what ~16 "stale" tests are tracking — fix spec and tests together.)
2. **§5 constructor-param binding contradiction.** The agent-template prose says params are "bound at
   `awake`, not `spawn`"; the Lifecycle prose and E-Spawn (§15.4) bind them at `spawn`, which the tests
   follow. Fix the template prose to say `spawn`.
