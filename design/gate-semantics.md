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
*one fact about stakes*; the language guarantees the decision is sound. The user only ever writes
what only they can know; thresholds, calibration, error control, and the abstain band are the
engine's job. Today's `confidence 0.9 margin 0.2` inverts this. That is the bug.

**Not a PPL** (reaffirmed): agape is a *decision* language; the provider does inference, the gate
collapses under cost + governance. The probabilistic boundary stays at §12 (forward fusion + one
gate; no conditioning).

## 1. Two modes — chosen by one keyword

One stakes distinction, on the **action**, picks the gate's behavior:

| on the action | gate mode | the decision is… | needs logprobs? |
|---|---|---|---|
| `reversible action X` | **face value** | the model's structured answer, taken as-is (= argmax at temp 0). Never defers/abstains. | **no** |
| `action X` (unmarked) | **conformal-bootstrap** | the model's answer **certified to ≤ α**; defers to a principal while uncalibrated, autonomizes as labels accrue. | **yes** (or sampling fallback) |

The entire asymmetry: a binary keyword + one global rigor dial (α, §3). The earlier multi-rung
stakes ladder is dropped as too arbitrary.

- **`reversible` = take the answer, no number.** "Don't certify — act." Needs no principal, no
  calibration, not even logprobs (a text-only model's single reply *is* the face-value answer).
  Enum: commit the top variant even if a sub-50% plurality; exact tie → `default:`/first arm.
  There is deliberately **nothing to configure** — a tunable bar would re-introduce arbitrariness.
- **Unmarked = fail-closed = rigorous.** A consequential action you *forgot* to annotate gets the
  cautious path (§13 "absent a declaration, fail closed"). You write `reversible` to *relax*.

## 2. commit / default / defer (+ notify orthogonal)

- **commit** — act on a named outcome (admitted by its action's mode: face-value if `reversible`,
  conformal-certified if not).
- **default** — the safe fallback arm (`default:`), a `reversible`/no-op action — the autonomous
  "let it go" path.
- **defer** — only the conformal path defers: while uncalibrated, or when a calibrated set isn't a
  singleton, a **principal decides** (blocking); the ruling becomes a label. `reversible` never defers.

**Notify is orthogonal** — a plain `emit` on any path, non-blocking:

| you want | how |
|---|---|
| safe fallback, no human | a `default:` arm |
| safe fallback **and** inform a human | a `default:` arm that `emit`s a notification |
| a human **must decide** | leave the action unmarked → it defers to the principal |

### The deference requirement (a static, compile-time rule)

> **If any arm of a `decide` performs (or transitively reaches) a non-`reversible` action, a
> principal must be reachable (the `decide` subject or a `defer to` clause). Otherwise it is a
> compile error.**

Autonomy is *earned* via human-label deferral; with no principal an unmarked action can never
legitimately autonomize, and the cold-start uncertain case has nowhere safe to go. A `default:`
arm does **not** satisfy this (it is the autonomous fallback, not the supervision channel; you can
have both). This extends the consequential-action rule: v1.0.0 = *non-reversible sink needs
settled + endorsed*; v1.1.0 adds *+ a deference path*. Scoped to the `decide` surface, so explicit
v1.0.0 programs are unaffected.

## 3. The only number: `conformal α`, set once (IaC-style)

```agape
conformal 0.05;          // file-level error budget for all consequential gates; typical 0.01–0.05
```

α is an **error guarantee**, not a threshold: "wrong at most α of the time," finite-sample,
distribution-free, calibrated from the gate's own labeled decisions on the spine (§13). The
operating cutoff is whatever achieves α — never seen or set by the user. Local override via the
explicit form; project default via the manifest (same precedence as v1.0.0, §17). **Only this
path needs the distribution** (logprobs / sampling fallback). **Cold start** → can't certify α →
defer; rulings become the first labels; readiness crossing flips it to autonomous — automatic,
recorded.

## 4. What the gate provides — and what actually needs logprobs

The gate is the **membrane**, and most of its value is *governance*, not arithmetic. *Every* gate,
reversible or not:

1. **settles** the model's answer (`raw`/`graded` → `settled` + endorsed) — *required* for it to
   drive a `perform`/`write` at all; a bare `event<E>` reply is `raw` and cannot act (§13);
2. **records** it on the spine (`Decided`) — auditable, replayable;
3. **dispatches** to the typed arms;
4. **governs** it (capabilities + the consequential-action rule).

The **only** thing that needs logprobs is the **conformal certification** — forming a calibrated
prediction set to guarantee error ≤ α. That is the gate's probabilistic value-add, and it lives
*only* on the unmarked path. So "why a gate at all for `reversible`?" — not for the decision (that
is the model's), but to make that decision **actionable and auditable** under the membrane.

| | `reversible` | unmarked (conformal) |
|---|---|---|
| the decision | model's answer, face value | model's answer, **certified to ≤ α** |
| settle + record + govern + dispatch | ✅ | ✅ |
| finite-sample error guarantee | — | ✅ |
| needs logprobs | — | ✅ |

## 5. Reproducibility & the Stability theorem (not at risk)

Two guarantees, very different exposure to `reversible`:

- **Recorded replay (T4): unconditional, untouched.** Every gate decision is recorded and
  re-served on replay; chain-head equality holds *always*, independent of margin. The audit /
  debug / forensic guarantee is fully intact for reversible gates.
- **Live re-run (Stability (ii)): `P(flip) ≤ Σⱼ β(δⱼ)` — governed by `temperature`, not bare
  margin.** At `temperature = 0` (the reproducibility default, §16.4) constrained decoding
  concentrates (assumption O ⇒ `β(δ_max) = 0`), so a reversible 51/49 argmax is **still
  deterministic** — greedy picks the same variant every run. Flips appear only at `temperature >
  0`, which is itself a deliberate opt-out of determinism.

The theorem is a *conditional bound*, not a claim of always-reproducible; `reversible` does not
falsify it, and at temp 0 the bound is ~0 even for reversible gates. The alignment is the point:
**reversible = low-stakes = reproducibility-non-critical (one axis).** The strong guarantees
concentrate on consequential gates (conformal + the margin floor `m`, so `β(δ) ≤ β(m)`, small).
The default is reproducible; `reversible` is a *visible, spine-recorded* opt-out, never hidden.

> **Rule this surfaces:** `reversible` must also **relax the consequential margin floor `m`** for
> that action (→ 0). Otherwise an argmax decision with margin ≈ 0 driving a reversible `perform`
> would be rejected at the sink. So `reversible` lowers *both* the gate mode (→ face value) and the
> sink floor (`m` → 0).

## 6. Margin is off the surface

- **reversible** → no margin (commits even on a near-tie; bounded by `temperature`, §5).
- **conformal** → margin *subsumed*: two close-but-plausible variants make the set non-singleton →
  defer. "Is the gap big enough" becomes "is the calibrated set a singleton."
- **explicit form only** → `confidence θ margin δ` keeps δ for power users.

## 7. Derive-and-enforce, and the desugaring (v1.0.0 completeness)

1. Each arm's bar = its worst action's **mode** (`reversible` → face value; unmarked → conformal α,
   calibrated from the spine).
2. Commit iff one outcome is admitted; else (conformal) **defer**; reversible always commits.
3. **Enforced**: an unmarked arm cannot fire until conformal certifies α; a non-reversible arm
   with no reachable principal does not compile (§2); `reversible` relaxes the margin floor `m` (§5).

```
reversible action Warn(...)   →  outcome admitted by  c by confidence 0   // face value, never abstains; m→0
action Sanction(...)          →  outcome admitted by  c by conformal 0.05  // + readiness bootstrap
alice decide c { … }          →  endorse (c by <conformal α, readiness>) { arms }
                                    abstain { default arm } by alice { ruling re-enters arms };
```

| v1.0.0 property (§13) | how `decide` reaches it |
|---|---|
| `c by confidence θ [margin δ]` | `reversible` → `confidence 0`; arbitrary θ/δ → explicit `endorse` |
| `c by conformal α` | the unmarked default; α from file/manifest |
| `policy { readiness/floor/fallback }` | the conformal bootstrap; explicit `policy` retained |
| `endorse … abstain … by p` | arms / `default:` / principal subject |
| `attest e by p` | the defer path; explicit `attest` retained |
| margin floor `m` | enforced at the sink; `reversible` sets it to 0 |

Nothing in v1.0.0 is removed or reinterpreted. **This is v1.1.0.**

## 8. Surface candidates (judge by read-aloud)

**A — principal-as-subject (recommended):**
```agape
conformal 0.05;
reversible action Warn(...)
action Sanction(...)              // unmarked → conformal; REQUIRES a principal (§2)
principal alice;

alice decide c {
  Sanction: perform Sanction(...)   // conformal-certified; defers to alice until calibrated
  Warn:     perform Warn(...)        // reversible → face value; just acts
  default:  clear(...)
}
```
*"Alice decides c: sanction only when we can certify it, warn when it's the likely call, otherwise
clear — and until we've learned, Alice rules the unclear ones."* ✅

**B — trailing defer clause:** `decide c { … } defer to alice`. **C — arrow style:** rejected.

## 9. Open questions

- **Word for "consequential"** — unmarked = cautious; is an explicit keyword ever wanted?
- **Calibration scope** — per-action-type / per-gate-site / global? (Affects autonomy speed + how
  the file-level α partitions labels.) ← the last load-bearing decision.
- **First-class `notify p`** vs plain `emit`.
- **`reversible` enum tie / no-plurality** — deterministic tiebreak → `default:`.
- **Mixed-mode blocks** — per-outcome admission; confirm always intended.

## 10. What to lock before grammar

1. **Two modes by one keyword** — `reversible` (face value, never defer, relaxes `m`) vs unmarked
   (conformal-bootstrap, defer → autonomous).
2. **commit/default/defer + orthogonal notify + the deference compile rule.**
3. **One knob `conformal α`, file-level; margin off the surface.**
4. **Only conformal needs logprobs; the gate's universal value is settle+record+govern+dispatch.**
5. **Reproducibility: recorded-replay unconditional; live bounded by `temperature`.**
6. **Complete desugaring to the v1.0.0 engine → v1.1.0.**
