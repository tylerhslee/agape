# The Cognition library — design

> A library that **enforces a cognitive-fusion pattern**: a panel of diverse, independent
> **faculties** (cognitive functions) each judge the same proposition; a **consolidator**
> (the prefrontal cortex) fuses their judgments and gates **once**. The consolidated ruling is
> provably more stable than any single faculty — *the whole beats the sum of the parts* — and
> the fused gate is the **only** door to a settled decision.
>
> Targets Agape **v1.1.0** (SPEC §19). Reference-only until `agape-rs` implements §19.

## 1. What this library adds (and what the earlier draft did not)

The earlier draft just wrapped a request/reply in a `Cognition` interface — it showed "agape
*can express* Jung," which is trivially true and adds nothing. This version adds the one thing
agape formally says makes a combination beat its parts:

> **§12 (fusion / `quorum`) + §15.5.5 (Stability theorem, Condorcet's jury theorem):**
> independent, diverse, better-than-chance judges fused under a declared dependence structure
> have error that collapses as judges are added, and the **fused margin exceeds any single
> judge's** (`β(δ_fused) ≤ minᵢ β(δᵢ)`).

The Jungian functions are the **diversity recipe** that makes fusion pay off. §12 is explicit:
fusion only amplifies when errors are *decorrelated* — "n calls to the same model with the same
prompt gain little." So the library's value rests entirely on the faculties being genuinely
different lenses, and the architecture is built to produce that.

## 2. Why each function is its own agent with its own memory

This is the crux, and it is the original instinct: **separate memories are the source of the
decorrelation that makes fusion work.** A faculty is a persistent agent seeded with one lens
directive; the provider conditions every reply on that agent's own memory (§6/§10), so:

- **Framing diversity** — each faculty judges the same proposition through a different question
  (Se: literal facts; Ti: internal consistency; Fe: stakeholder values; …).
- **Memory diversity** — each faculty accumulates its own history, so its judgments drift
  independently over time.

Both push the faculties' errors apart, which is exactly the precondition §12 needs. (All
agents share the one provider, §0 — so independence comes from *state + framing*, not from
different models. Per-faculty models would be stronger but need a spec change; out of scope.)

## 3. The architecture

```
proposition ─┬─▶ Se faculty (own memory, lens)  ─▶ Credence<bool>  ┐
             ├─▶ Ti faculty (own memory, lens)  ─▶ Credence<bool>  ├─ independent, graded
             └─▶ Fe faculty (own memory, lens)  ─▶ Credence<bool>  ┘
                                                       │
                                ┌───────────  CONSOLIDATOR (PFC)  ───────────┐
                                │  independent j1, j2, j3;                    │
                                │  fused = quorum(2, [j1, j2, j3]);  (fuse)   │
                                │  endorse (fused by PanelQuorum) { … }  (gate once) │
                                └────────────────────────────────────────────┘
                                                       │
                                                       ▼  the ONLY settled Ruling
```

- **Faculty** (`faculty.ag`) — one lens; an agent + private memory; replies a **graded**
  `Credence<bool>`. Cannot act alone.
- **Consolidator** (`consolidator.ag`) — fans the proposition to its panel, declares the
  panel **independent**, fuses with `quorum`, and gates **once**.

## 4. What the library enforces — vs what it cannot

**Enforced structurally (by the type system + the spec):**
- **The whole is the only door.** A faculty returns `graded`; by the consequential-action rule
  (§13) it cannot reach an action. The *only* producer of a settled `Ruling` is the
  consolidator's fused gate. You cannot get a decision out of one faculty.
- **You must declare the correlation assumption.** `quorum`/`all` are a compile error without a
  total `independent`/`dependent` declaration (§12). The assumption is explicit and recorded on
  the spine, so an overconfident ruling traces back to the `independent` claim that licensed it.

**NOT enforceable — the honest boundary:**
- **The library cannot prove the faculties are actually independent or better-than-chance.**
  §12 says it outright: declaring `independent` over same-source judges is a programmer error
  the spine records but the type system cannot detect. So *better-than-the-sum is contingent on
  real diversity*, which is a design choice (distinct lenses + divergent memory) and an
  **empirical** claim.

## 5. The ablation harness — how the claim is earned, not asserted

Because the benefit is empirical, the library's centerpiece is a **validation harness**, not
just code:

- Take a set of labeled cases (proposition + ground-truth pass/fail).
- Measure the **fused panel** vs **the best single faculty** vs **every leave-one-out subset**.
- The pattern earns its keep iff `accuracy(fused) > maxᵢ accuracy(facultyᵢ)` and each faculty's
  removal measurably hurts. Faculties that never move the result are paraphrases, not lenses —
  drop them.

This is the same falsifiable bet from the design discussion ("does the 8-function basis beat a
simpler set?"), now made measurable. The harness needs labeled data + accuracy computation
(host/tool work, §0.1), so it is driven by an eval tool over recorded runs, not pure agape.

## 6. Module layout

```
libs/cognition/
  agape.toml            # [package] name="cognition" lib="src/lib.ag"
  src/
    lib.ag              # module cognition             — vocabulary: Case, Ruling, Appraise, Ruled, Escalate
    faculty.ag          # module cognition.faculty     — the Faculty agent + the 8 canonical lenses
    consolidator.ag     # module cognition.consolidator — the PFC: fan-out → independent → quorum → gate once
  examples/
    panel.ag            # convene a 3-lens panel end-to-end
```

## 7. How the demos use it

A demo is a **panel configuration** — which lenses, what quorum, what the consequential arms
do. Same substrate, different governance:

- **Cognition demo** — `examples/panel.ag`: watch a fused ruling beat its parts.
- **Studio** — a panel whose `Pass` arm performs real work (a `write` tool / `perform`); the
  quorum is the team's review gate before acting.
- **Prison experiment** — a panel where the consolidator holds `perform Sanction` authority and
  the `abstain` (no-quorum) arm routes to `attest … by superintendent`. The grant asymmetry is
  the power structure; the spine is the audit trail; the quorum is the check on any one lens
  (e.g. a punitive Fe) running away.

## 8. Known gaps surfaced (v1.1.x candidates)

- **No re-export** (§19): `lib.ag` can't republish names, so users import each module.
- **One provider for all agents** (§0): faculties can't use different models; diversity is
  state+framing only. Per-faculty providers would need a provider-routing capability.
- **Quorum is over `Credence<bool>`** (§12): multi-variant fusion isn't expressed; the panel
  judges a yes/no proposition. Richer fusion is future work.
