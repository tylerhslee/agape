# Design — the readable gate (`decide`): intent on the surface, rigor in the engine

> Status: **proposal / design note.** Fixes the *model* before any grammar. The aim: a gate a
> non-programmer can read aloud and be right about, with the decision theory derived and
> **enforced** underneath — never authored.
>
> Scope/compat: a **surface** that *desugars* to the v1.0.0 gate engine (`endorse`/`attest`/
> `c by R`, §13). The engine does not change ("every sugar desugars", §14); every v1.0.0 gate
> property stays expressible; v1.0.0 programs stay valid. → **additive v1.1.0**, not a v2 break.

## 0. The one principle

The gate is where **human intent meets enforced rigor.** The user states *what they want* and
*one fact about stakes*; the language guarantees the decision is sound. The user only ever
writes what only they can know; thresholds, calibration, error control, and the abstain band are
the engine's job. Today's `confidence 0.9 margin 0.2` inverts this. That is the bug.

**Not a PPL** (reaffirmed): agape is a *decision* language; the provider does inference, the gate
collapses under cost + governance. The probabilistic boundary stays at §12 (forward fusion + one
gate; no conditioning).

## 1. Two modes — chosen by one keyword

There is exactly **one** stakes distinction, on the **action**, and it picks the gate's behavior:

| on the action | gate mode | behavior |
|---|---|---|
| `reversible action X` | **argmax** | commit the most-likely outcome; **never defers, never abstains**. No threshold, no number. |
| `action X` (unmarked) | **conformal-bootstrap** | while uncalibrated → **defer to a principal**; as human labels accrue, auto-switch to **autonomous conformal** at α. |

That's the entire asymmetry: a binary keyword, plus one global rigor dial (α, §3). The earlier
multi-rung stakes ladder is dropped as too arbitrary.

- **`reversible` = argmax, no number.** "Don't certify — pick the likely answer and go." Needs
  no principal, no calibration, not even logprobs (a text-only model's single answer *is* the
  argmax). For an enum, commit the top variant even if it's a plurality below 50%; exact tie →
  the `default:`/first arm. There is deliberately **nothing to configure** here — a tunable bar
  would re-introduce the arbitrariness we are removing.
- **Unmarked = fail-closed = rigorous.** A consequential action you *forgot* to annotate gets
  the cautious path, never the reckless one (§13 "absent a declaration, fail closed"). You write
  `reversible` to *relax*, never to tighten.

## 2. commit / default / defer (+ notify orthogonal)

- **commit** — act on a named outcome. Admitted by *its own action's* mode (argmax if that
  action is `reversible`; conformal-certified if not).
- **default** — the safe fallback arm (`default:`), a `reversible`/no-op action — the autonomous
  "let it go" path.
- **defer** — only the conformal path defers: while uncalibrated, or when a calibrated conformal
  set isn't a singleton (genuinely ambiguous), a **principal decides** (blocking); the ruling
  becomes a label. `reversible` gates never defer.

**Notify is orthogonal** (the "tell alice vs alice decides" distinction): a plain `emit` on any
path, non-blocking.

| you want | how |
|---|---|
| safe fallback, no human | a `default:` arm (a reversible/no-op action) |
| safe fallback **and** inform a human | a `default:` arm that `emit`s a notification |
| a human **must decide** the contested case | leave the action unmarked → it defers to the principal |

### The deference requirement (a static, compile-time rule)

> **If any arm of a `decide` performs (or transitively reaches) a non-`reversible` action, a
> principal must be reachable — via the `alice decide` subject or a `defer to` clause. Otherwise
> it is a compile error.**

Why it's an error, not a warning: the meaning of *unmarked/non-reversible* is "earn autonomy via
human supervision," and the labels that earn it come only from deferral. With no principal, the
action can never legitimately autonomize, and the cold-start uncertain case has nowhere safe to
go. A `default:` arm does **not** satisfy this — the default is the autonomous fallback, not the
supervision channel (you can, and usually will, have both). This is the v1.1.0 extension of the
consequential-action rule: v1.0.0 = *a non-reversible sink needs settled + endorsed values*;
v1.1.0 adds *+ a deference path*. It is scoped to the `decide` surface / `reversible` annotation,
so explicit v1.0.0 `endorse`/`attest` programs are unaffected (back-compat). One-line teach:
*"consequential actions need a human in the loop until they've earned trust; mark it `reversible`
if they truly don't."*

## 3. The only number: `conformal α`, set once (IaC-style)

The single knob is the conformal error level α, written **once at the top of an `.ag` file**:

```agape
conformal 0.05;          // file-level default error budget for all consequential gates
                         // typical 0.01 – 0.05; lower = stricter = more deferral
```

- Governs every unmarked (conformal) `decide` in the file. A gate may override locally with the
  explicit form; the manifest can set a project default — same precedence chain as v1.0.0 (§17).
- α is an **error guarantee**, not a threshold: "be wrong at most α of the time," finite-sample,
  distribution-free, calibrated from the gate's own labeled decisions on the spine (§13). The
  operating cutoff is whatever achieves α given the data — the user never sees or sets it.
- Needs a distribution (logprobs, or the §16 sampling fallback). **`reversible` needs none of
  this** — it's argmax. So α is the *only* number, and it's only for the cautious path.
- **Cold start** (labels below readiness) → cannot certify α → **defer** to the principal. Those
  rulings are the first labels; once enough accrue, conformal commits autonomously. The
  "switch to conformal" is this readiness crossing — automatic, recorded.

## 4. Where margin went

`margin` (the v1.0.0 `δ`, "lead over runner-up") leaves the surface entirely:

- **reversible** → no margin; argmax commits even on a near-tie (cheap to be wrong, so flips are
  fine — the §15.5.5 stability worry doesn't apply to a reversible action).
- **conformal** → margin is *subsumed*: two close-but-plausible variants make the calibrated set
  non-singleton → it **defers**. "Is the gap big enough" becomes "is the calibrated set a
  singleton," computed from data, not a hand-set δ.
- **explicit form only** → `confidence θ margin δ` keeps δ for power users.

So the `decide` surface has **zero margin knobs**.

## 5. Derive-and-enforce, and the desugaring (v1.0.0 completeness)

Given a `decide`, the engine derives everything:

1. Each arm's bar = its worst action's **mode** (`reversible` → argmax; unmarked → conformal at
   the file α, calibrated from the spine).
2. Commit iff exactly one outcome is admitted; else (conformal path) **defer**; `reversible`-only
   gates always commit the argmax.
3. **Enforced**, not advised: an unmarked arm cannot fire until conformal certifies α; and a
   non-reversible arm with no reachable principal does not compile (§2). Neyman–Pearson-style
   error control + the deference requirement are structural, not programmer discipline.

**Desugaring** (pure sugar over the frozen v1.0.0 engine):

```
reversible action Warn(...)     →  that outcome admitted by  c by confidence 0   // argmax, never abstains
action Sanction(...)            →  that outcome admitted by  c by conformal 0.05  // + readiness bootstrap
alice decide c { … }            →  endorse (c by <conformal α, readiness from policy>) { arms }
                                      abstain { default arm }
                                      by alice { deferred ruling re-enters the arms };
```

**Every v1.0.0 gate property is reachable** (so power users lose nothing; back-compat → v1.1.0):

| v1.0.0 property (§13) | how `decide` reaches it |
|---|---|
| `c by confidence θ [margin δ]` | `reversible` → `confidence 0` (argmax); arbitrary θ/δ → explicit `endorse` (retained) |
| `c by conformal α` | the unmarked-action default; α from the file/manifest line |
| `policy { readiness/floor/fallback }` | the conformal-bootstrap; explicit `policy` retained |
| `endorse … { arms } abstain { } by p { }` | `decide`'s arms / `default:` / principal subject |
| `attest e by p` | the cold-start defer path; explicit `attest` retained for always-human gates |
| margin floor `m` (consequential_margin) | unchanged; enforced at the sink (§13) |

Nothing in v1.0.0 is removed or reinterpreted. **This is v1.1.0.**

## 6. Surface candidates (judge by read-aloud)

**A — principal-as-subject (recommended):**
```agape
conformal 0.05;
reversible action Warn(...)
action Sanction(...)              // unmarked → conformal + bootstrap; REQUIRES a principal (§2)
principal alice;

alice decide c {
  Sanction: perform Sanction(...)   // conformal-certified; defers to alice until calibrated
  Warn:     perform Warn(...)        // reversible → argmax; just acts
  default:  clear(...)               // safe fallback
}
```
*Read:* "Alice decides c: sanction only when we can certify it, warn when it's the likely call,
otherwise clear — and until we've learned, Alice rules the unclear ones." ✅

**B — trailing defer clause** (no principal as subject): `decide c { … } defer to alice`.

**C — arrow style** (rejected): `unsure -> alice` blurs that the bands are mode-derived.

**Recommendation: A**, with `B`'s `defer to` as the alternate form.

## 7. Open questions

- **Word for "consequential".** Unmarked = cautious. Is an explicit `consequential`/
  `irreversible` keyword ever wanted for readability, or is unmarked enough?
- **Calibration scope.** Per-action-type, per-gate-site, or global? Affects how fast each gate
  earns autonomy and how the file-level α partitions its labels.
- **First-class `notify p`** vs a plain `emit` for the non-blocking "FYI".
- **`reversible` enum tie / no-plurality** — argmax with a deterministic tiebreak vs fall to
  `default:`. (Proposed: deterministic tiebreak → `default:`/first arm.)
- **Mixed-mode blocks** — handled per-outcome (each arm by its own mode). Confirm always intended.

## 8. What to lock before grammar

1. **Two modes by one keyword** — `reversible` (argmax, never defer) vs unmarked
   (conformal-bootstrap, defer→autonomous).
2. **commit/default/defer + orthogonal notify**, and the **deference-requirement compile rule**.
3. **One knob `conformal α`, file-level (IaC); margin off the surface.**
4. **Derive-and-enforce + complete desugaring to the v1.0.0 engine → v1.1.0.**

Surface (§6) is chosen last, against the read-aloud test.
