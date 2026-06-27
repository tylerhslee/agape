# Design — the readable gate (`decide`): intent on the surface, rigor in the engine

> Status: **proposal / design note.** Fixes the *model* before any grammar. The aim: a gate a
> non-programmer can read aloud and be right about, with the full decision theory derived and
> **enforced** underneath — never authored.
>
> Scope/compat: this is a **surface** that *desugars* to the existing v1.0.0 gate engine
> (`endorse`/`attest`/`c by R`, §13). The engine does not change; "every sugar desugars" (§14)
> holds. So this is a v1.1.x **additive** surface, not a v2 breaking change — the explicit
> `endorse (c by R)` form stays for power users. Coordinate with the §13 owner + agape-rs.

## 0. The one principle

The gate is where **human intent meets enforced rigor.** The user states *what they want* and
*what's at stake*; the language guarantees the decision is sound. Everything the user writes
must be something only they can know (the domain); everything derivable (thresholds, error
control, calibration, the abstain band) is the engine's job. Today's surface inverts this — it
makes the user hand-write engine parameters (`confidence 0.9 margin 0.2`) and re-declare
structure at every call. That is the bug we are fixing.

**Not a PPL (reaffirmed).** Agape is a *decision* language, not an *inference* language: the
provider produces the distribution; the gate collapses it under cost and governance. Becoming a
PPL would make the surface *less* legible, not more. The probabilistic boundary stays where §12
draws it (forward fusion + one gate; no conditioning/inference).

## 1. The model: commit / default / defer (+ notify)

Every gate chooses among three outcomes, separated by *confidence*:

- **commit** — act on a named outcome. Bar is **proportional to the stakes** of what that arm does.
- **default** — not confident enough to commit a costly arm, but confident the **safe fallback**
  applies. Runs **autonomously**, recorded. (The `default:` arm.)
- **defer** — can't even safely default (genuinely contested) **or** not yet calibrated
  (cold start). A **principal decides** (blocking). Their rulings become calibration labels (the
  §13 supervised→autonomous bootstrap).

**Notify is orthogonal.** Telling a human is not the same as a human deciding. Notification is a
plain `emit` on any path (non-blocking); the spine is always there for async review. This is the
answer to "default AND tell alice" vs "default, alice uninvolved":

| you want | how |
|---|---|
| safe fallback, no human | a `default:` arm |
| safe fallback **and** inform a human (non-blocking) | a `default:` arm that `emit`s a notification |
| a human **must decide** the contested case (blocking) | name a principal (the defer target) |

The **`default:` arm's bar is the line** between *autonomous fallback* and *human defer*: if the
credence clears the (low) default bar → default autonomously; if it doesn't → defer to the
principal. With **no** principal named, the defer zone **fails closed** to the default arm (or,
if none, the gate faults — never silently acts).

## 2. The stakes hierarchy (defined now, configured once)

Stakes are declared **once, on the consequence** (the `action`), as an **ordinal level**, never
as numbers at the gate. The level answers one human question: *how bad is it to do this and be
wrong?* (≈ how reversible is it).

| level | meaning | cost ratio `c_FA : c_FR` | **commit bar θ** | margin | defer-zone width |
|---|---|---|---|---|---|
| `trivial` | cosmetic; wrong costs ~nothing | 1 : 1 | **0.50** | 0.00 | ~none |
| `reversible` | easily undone | 2 : 1 | **0.67** | 0.05 | small |
| `costly` | expensive/painful to undo | 6 : 1 | **0.86** | 0.10 | wide |
| `irreversible` | cannot undo / catastrophic | 30 : 1 | **0.97** | 0.15 | very wide |

- **θ is the Bayes/Elkan threshold** `θ = c_FA / (c_FA + c_FR)` (cost-sensitive learning, Elkan
  2001), *not* an error rate. Low cost-of-wrong ⇒ low bar ⇒ act readily; high cost ⇒ high bar.
- **The numbers are defaults**, set in the manifest, so an org tunes its own risk posture once:

  ```toml
  [stakes]                       # cost ratio c_FA:c_FR per level → θ derived
  trivial      = 1
  reversible   = 2
  costly       = 6
  irreversible = 30
  # or set θ directly: reversible = { theta = 0.67, margin = 0.05 }
  ```
- **Fail-closed default:** an `action` with **no** level is treated as `irreversible` (the
  cautious bar). You annotate `reversible`/`trivial` to *relax*; forgetting the annotation can
  never make a gate reckless (§13 "absent a declaration, fail closed").
- **Start binary, keep the ladder.** A program may use only `reversible`/`irreversible` at
  first; the four-rung scale is there so finer postures don't require a redesign.

## 3. Where the bar actually is (the concrete answer)

For a costly/irreversible commit arm with a safe default, the three zones for "P(commit-outcome)":

```
irreversible Sanction:        reversible Warn:
  P ≥ 0.97   → commit           P ≥ 0.67   → commit
  P ≤ 0.50   → default          P ≤ 0.50   → default
  0.50<P<0.97 → DEFER (human)    0.50<P<0.67 → DEFER (human)
```

So **reversible commits at ~0.67**, and the **defer zone widens with stakes** — an irreversible
action escalates the whole ambiguous middle (0.50–0.97) to a human; a reversible one escalates
almost nothing. That is exactly the desired behavior and it is *automatic* from the level.

**Calibration makes θ honest.** A raw model "0.67" is not 67% (LLM logits are overconfident,
§3). So the engine **calibrates against the spine** (conformal, §13): it maps raw credence to an
honest probability so the configured θ means what it says. Until enough labeled cases exist, the
gate cannot certify θ → it **defers to the principal**, whose rulings become the labels. This is
why naming the principal is part of the construct, not an afterthought.

## 4. The derive-and-enforce contract

Given a `decide` block, the engine derives the rule with **no input from the user beyond the
arms and the actions' levels**:

1. For each arm, find the **worst-stakes action** it performs (max over its body); a no-action
   arm is `trivial`. That sets the arm's **commit bar** (θ, margin) from the §2 table.
2. The **`default:` arm** gets the `trivial`/low bar — easy to reach.
3. Calibrate against the spine (conformal) so the bars are honest; below readiness, **defer**.
4. Enforce: an arm performing an `irreversible` action **cannot fire** unless its (high,
   calibrated) bar is met — a guarantee, not programmer discipline. This is Neyman–Pearson
   error-control made structural (the costly direction's error is *controlled*, not hoped).

**Desugaring (engine unchanged).** `alice decide c { warranted: perform Sanction(...) default:
clear(...) }` lowers to the §13 engine:

```
endorse (c by  <policy derived from Sanction's level, calibrated from the spine>) {
  warranted: perform Sanction(...);
  // 'default' arm = the low-bar fallback
} abstain { /* default arm here if its bar is met */ }
  by alice { /* the deferred human ruling re-enters the arms */ };
```

The user writes intent; the compiler writes the rule. The explicit `endorse (c by R)` remains
available for the rare case where someone genuinely wants to hand-set R.

## 5. Surface candidates (judge by read-aloud)

The test: *could a non-programmer read it and be right about what happens?*

**A — principal-as-subject (recommended):**
```agape
reversible action Warn(...)
action Sanction(...)              // unmarked → irreversible → cautious bar
principal alice;

alice decide c {
  Sanction: perform Sanction(...)   // fires only at ~0.97, calibrated
  Warn:     perform Warn(...)        // fires at ~0.67
  default:  clear(...)               // safe fallback, ~0.50; recorded as a no-action decision
}
```
*Read:* "Alice decides c: sanction only when we're very sure, warn when it's likely, otherwise
clear — and while we're still learning, Alice rules the unclear ones." ✅

**B — trailing defer clause:**
```agape
decide c {
  Sanction: perform Sanction(...)
  Warn:     perform Warn(...)
  default:  clear(...)
} defer to alice
```
Reads well; separates the decision from the escalation. Slightly more ceremony.

**C — arrow/policy style:**
```agape
decide c {
  warranted  -> sanction(...)
  likely     -> warn(...)
  otherwise  -> clear(...)
  unsure     -> alice
}
```
Most "english," but `unsure -> alice` blurs the commit/defer distinction and hides that the
bands are stakes-derived. Riskiest for correctness-by-reading.

**Recommendation:** **A**, with **B**'s `defer to` as the form when no principal is the subject.
Both desugar identically.

## 6. Open questions

- **Level granularity & names.** Is 4 rungs right? Are `trivial/reversible/costly/irreversible`
  the clearest words? (Alternative: `routine/reversible/serious/critical`.)
- **Per-arm vs per-action stakes.** Stakes live on the action; an arm performing several actions
  takes the max. Is "max" always right, or do some arms need an explicit override?
- **`default:` semantics when absent.** Fail-closed to the safest arm, or fault? Proposed: fault
  if no principal and no default and nothing commits (never silently act).
- **Notify form.** Is a plain `emit` enough, or do we want a first-class `notify p` that records
  a typed "FYI" distinct from a decision?
- **Calibration scope.** Is calibration per-action-type, per-gate-site, or global? (Affects how
  fast a gate earns autonomy.)
- **Cost-ratio vs coverage.** §2 uses the Bayes threshold (cost ratio → θ). Conformal gives a
  coverage guarantee instead. They can compose (level sets θ; conformal makes it honest), but a
  per-level *coverage* mode (`irreversible → ≤1% error`) may be wanted too — decide whether a
  level maps to a cost ratio, a coverage target, or both.

## 7. What to lock before grammar

1. the **commit/default/defer + orthogonal notify** model (§1),
2. the **stakes ladder + manifest configuration + fail-closed default** (§2),
3. the **bar = Bayes θ from stakes, calibrated by the spine, defer on cold-start** rule (§3–§4),
4. the **derive-and-enforce contract + desugaring to §13** (§4).

Surface (§5) is chosen last, against the read-aloud test.
