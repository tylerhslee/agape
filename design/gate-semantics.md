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
the engine's job. Today's `confidence 0.9 margin 0.2` inverts this (engine parameters leaked onto
the surface). That is the bug.

**Not a PPL** (reaffirmed): agape is a *decision* language; the provider does inference, the gate
collapses under cost + governance. The probabilistic boundary stays at §12 (forward fusion + one
gate; no conditioning).

## 1. Two modes — chosen by one keyword

There is exactly **one** stakes distinction, on the **action**, and it picks the gate's whole
behavior:

| on the action | gate mode | behavior |
|---|---|---|
| `reversible action X` | **majority** | commit the most-likely outcome; **never defer**. (Cheap to be wrong — act at >50%.) |
| `action X` (unmarked) | **conformal-bootstrap** | while uncalibrated → **defer to a principal**; as human labels accrue, auto-switch to **autonomous conformal** at α. |

That's the entire asymmetry: a binary keyword, plus one global rigor dial (α, §3). No
hand-tuned per-level thresholds — the earlier 4-rung ladder is dropped as too arbitrary.

- **`reversible` is an escape hatch:** "don't bother certifying — just pick the likely answer
  and go." It needs no principal and no calibration. For `bool`, commit `true` iff `P(true) >
  P(false)`; for an enum, commit the argmax. (Exact tie → the `default:`/first arm.)
- **Unmarked = fail-closed = rigorous.** A consequential action you *forgot* to annotate gets
  the cautious path, never the reckless one (§13 "absent a declaration, fail closed"). You write
  `reversible` to *relax*, never to tighten.

## 2. commit / default / defer (+ notify orthogonal)

The outcomes of any gate, unchanged from the prior note:

- **commit** — act on a named outcome. Admitted by *its own action's* mode (majority if that
  action is `reversible`; conformal-certified if not).
- **default** — the safe fallback arm (`default:`). Typically a `reversible`/no-op action, so it
  is admitted by the easy majority bar — the autonomous "let it go" path.
- **defer** — only the conformal path defers: while uncalibrated, or when even a calibrated
  conformal set isn't a singleton (genuinely ambiguous), a **principal decides** (blocking), and
  the ruling becomes a label. `reversible` gates never defer.

**Notify is orthogonal** (the "tell alice vs alice decides" distinction): notification is a plain
`emit` on any path (non-blocking). So:

| you want | how |
|---|---|
| safe fallback, no human | a `default:` arm (a reversible/no-op action) |
| safe fallback **and** inform a human | a `default:` arm that `emit`s a notification |
| a human **must decide** the contested case | leave the action unmarked → it defers to the named principal |

No principal named on an unmarked (deferring) gate → the defer zone **fails closed** to the
`default:` arm, or faults if there is none. It never silently acts.

## 3. The only number: `conformal α`, set once (IaC-style)

The single knob is the conformal error level α, written **once at the top of an `.ag` file**,
consistent with the infrastructure-as-code spirit:

```agape
conformal 0.05;          // file-level default error budget for all consequential gates
                         // typical range 0.01 – 0.05; lower = stricter = more deferral
```

- It governs every unmarked (conformal) `decide` in the file. A gate may still override locally
  with the explicit form (`endorse (c by conformal 0.01)`), and the manifest can set a
  project-wide default — same precedence chain as v1.0.0 (§16/§17).
- α is an **error guarantee**, not a hand-picked threshold: "be wrong at most α of the time,"
  finite-sample, distribution-free, calibrated from the gate's own labeled decisions on the
  spine (§13). The *operating threshold* is whatever achieves α given the data — the user never
  sees or sets it.
- **Cold start** (labels below readiness) → the gate cannot certify α → it **defers** to the
  principal. Those human rulings are the first labels; once enough accrue, conformal commits
  autonomously. The "switch to conformal" is this readiness crossing — automatic, recorded.

So the complete user-facing surface for stakes is: the word `reversible` (per action) and one
line `conformal 0.05` (per file). Nothing else.

## 4. Derive-and-enforce, and the desugaring (v1.0.0 completeness)

Given a `decide` block, the engine derives everything:

1. Each arm's admission bar = its worst action's **mode** (`reversible` → majority; unmarked →
   conformal at the file α, calibrated from the spine).
2. Commit iff exactly one outcome is admitted; else (conformal path) **defer** to the principal;
   `reversible`-only gates always commit the argmax.
3. **Enforced**, not advised: an unmarked action's arm cannot fire until conformal certifies α —
   a guarantee, not programmer discipline. Neyman–Pearson-style error control is structural.

**Desugaring** (the engine stays v1.0.0; this is pure sugar):

```
// reversible arm:
reversible action Warn(...)     →   that outcome admitted by   c by confidence 0.5

// unmarked (consequential) arm, with file-level `conformal 0.05;` and `principal alice;`:
action Sanction(...)            →   that outcome admitted by   c by conformal 0.05
alice decide c { … }            →   endorse (c by <conformal 0.05, readiness from policy>) { arms }
                                       abstain { default arm }
                                       by alice { deferred ruling re-enters the arms };
```

**Every v1.0.0 gate property is accounted for** (so power users lose nothing and it's
backwards-compatible → v1.1.0):

| v1.0.0 property (§13) | how the `decide` surface reaches it |
|---|---|
| `c by confidence θ [margin δ]` | `reversible` → `confidence 0.5`; arbitrary θ/δ → explicit `endorse` (retained) |
| `c by conformal α` | the unmarked-action default; α from the file/manifest line |
| `policy { … readiness/floor/fallback }` | the conformal-bootstrap (readiness → defer); explicit `policy` retained |
| `endorse … { arms } abstain { } by p { }` | `decide`'s arms / `default:` / principal subject |
| `attest e by p` | the cold-start defer path; explicit `attest` retained for always-human gates |
| margin floor `m` (consequential_margin) | unchanged; still enforced at the sink (§13) |

Nothing in v1.0.0 is removed or reinterpreted; `decide`/`reversible`/top-level `conformal` are
additive sugar over the frozen engine. **This is v1.1.0.**

## 5. Surface candidates (judge by read-aloud)

**A — principal-as-subject (recommended):**
```agape
conformal 0.05;
reversible action Warn(...)
action Sanction(...)              // unmarked → conformal + bootstrap
principal alice;

alice decide c {
  Sanction: perform Sanction(...)   // conformal-certified; defers to alice until calibrated
  Warn:     perform Warn(...)        // reversible → majority; just acts
  default:  clear(...)               // safe fallback
}
```
*Read:* "Alice decides c: sanction only when we can certify it, warn when it's the likely call,
otherwise clear — and until we've learned, Alice rules the unclear ones." ✅

**B — trailing defer clause** (when no principal is the subject): `decide c { … } defer to alice`.

**C — arrow style** (rejected): `unsure -> alice` blurs that the bands are mode-derived; riskiest
to read.

**Recommendation: A**, `B`'s `defer to` as the alternate form. Both desugar identically.

## 6. Open questions

- **Word for "consequential".** `reversible` marks the cheap case; the cautious default is
  unmarked. Is an explicit `irreversible`/`consequential` keyword ever wanted (for readability),
  or is "unmarked = cautious" enough?
- **`default:` semantics when absent + no principal.** Proposed: fault (never silently act).
- **Calibration scope.** Per-action-type, per-gate-site, or global? Affects how fast each gate
  earns autonomy and how the file-level α partitions its labels.
- **First-class `notify p`** vs a plain `emit` for the non-blocking "FYI".
- **Exact-tie / no-majority handling for `reversible` enums** (no variant > others): argmax with
  a deterministic tiebreak, or fall to `default:`?
- **Mixed-mode blocks.** A block with both reversible and unmarked arms is handled per-outcome
  (each arm by its own mode). Confirm that's always the intended reading.

## 7. What to lock before grammar

1. **Two modes by one keyword** — `reversible` (majority, never defer) vs unmarked
   (conformal-bootstrap, defer→autonomous) (§1).
2. **commit/default/defer + orthogonal notify** (§2).
3. **One knob `conformal α`, file-level (IaC), cold-start defers to principal** (§3).
4. **Derive-and-enforce + complete desugaring to the v1.0.0 engine → v1.1.0** (§4).

Surface (§5) is chosen last, against the read-aloud test.
