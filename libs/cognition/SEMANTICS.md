# The Cognition library — operational semantics (a hand-executed trace)

> Since the library is reference-only until `agape-rs` implements §19, this document *runs* it
> on paper. It hand-executes `examples/warden.ag` against the spec's operational semantics
> (SPEC §15.4), showing the full spine, every trust transition, the fusion, and both gate
> outcomes. Numbers in the credences are illustrative; the **rules** they exercise are not.

## 0. How to read this

A run is a sequence of steps over the runtime configuration `⟨ Π | Ψ | Ω | Â | μ | S | k ⟩`
(provider, identity, tool, agents, memory, spine, continuation — §15.4.1). Each step appends to
the **spine** `S` (the append-only log) via an `E-` rule. Two qualifiers travel with every
value: **color** (S/A) and **trust** (`settled ⊑ graded ⊑ raw`, §15.3.1). We track the spine
in the left column and trust in the right.

Spine tokens (the conformance vocabulary): `Spawned(x)`, `AgentAwake(x)`, `Sent/Delivered/
Resolved(x)`, `Decided(x)`, `Abstained(x)`, `Attestation(x)`, an emitted event `Name(x)`, a
performed action `Name(x)`, and the incidental `Internalized` (memory writes, §9).

## 1. Construct → rule map

| library construct | grammar | rule (§15.4) | spine effect | trust of result |
|---|---|---|---|---|
| `spawn Faculty f(Se())` | `spawn` | E-Spawn | `Spawned(f)` | — |
| `awake f` → `on awake { store(lens) }` | `awake` | E-Awake + store | `AgentAwake(f)`, `Internalized` (incidental) | — |
| `emit Reported(...)` | `emit` | E-Emit | `Reported(@r)` | payload `settled` (origin) |
| `j = faculty <- q` | `<-` to Credence slot | E-Send + T-Credence | `Sent/Delivered/Resolved(j)` | **`graded`** |
| `independent j1,j2,j3` | `depdecl` | (static; recorded) | a single sync event/none | — |
| `quorum(2,[...])` | fuse expr | T-Fuse (§15.3.2) | none (sync, off-spine) | **`graded`** |
| `endorse (fused by R) {…}` | `endorse` | E-Endorse | `Decided(fused)` **or** `Abstained(fused)` | **`settled`**, `endorsed:=true` |
| `perform Sanction(r.report)` | `perform` | E-Perform¹ | `Sanction(@s)` | consumes a `settled` arg |
| `attest r.report by p {…}` | `attest` | E-Attest | `Attestation(@a)` | `settled`, `endorsed:=true` |

¹ `perform` of an `action` appends the action event; it is gated by the consequential-action
rule (W-Consequential, §15.3.3): the argument must be `settled` and, for a gated decision, the
runtime margin floor `m` is checked.

## 2. Initial configuration

`warden.ag` declares: `struct Report`, `event Reported`, `action Sanction`, `event Logged`,
`principal superintendent`, `policy WardenRule { threshold 0.9 margin 0.2 }`, agents `Warden`
and `Prisoner`. The provider `Π` answers each faculty's send conditioned on **that faculty's
own memory** — which, after `awake`, contains its seeded lens directive (the source of
decorrelation, §12). `Ψ` (identity) backs `superintendent`.

Bootstrap (top-level statements, evaluated top to bottom, §0.2):

```
spine S                                   trust / notes
─────────────────────────────────────────────────────────────────────
Spawned(observe)                          E-Spawn; subs hoisted (none)
Spawned(rulebook)
Spawned(proportion)
AgentAwake(observe)                       E-Awake → on awake → store(Se())  ⇒ Internalized (incidental)
AgentAwake(rulebook)                      store(Ti())  ⇒ Internalized
AgentAwake(proportion)                    store(Fe())  ⇒ Internalized
Spawned(warden)                           ctor binds f1=observe, f2=rulebook, f3=proportion
AgentAwake(warden)                        warden's `when (Reported r)` registered (hoisted, prospective)
Spawned(p)
AgentAwake(p)                             on awake → say("prisoner present")   (say is NOT a spine op, §9)
```

Note `Prisoner p` has **no `grants`** → by W-Auth (default-deny) it can never `perform Sanction`
or `reach` anyone. That is a static fact, visible here as the absence of any authority — the
power asymmetry is in the type, not the prose.

## 3. Scenario A — a contested case → the panel overrides the lone confident lens → escalate

`emit Reported(Report { prisoner: "P-17", infraction: "spoke after lights-out", evidence:
"single guard report, no corroboration" });`

```
Reported(@r)                              E-Emit; payload settled by origin (a literal struct)
```

`Reported(@r)` matches the warden's hoisted subscription → the `when (Reported r)` body runs.
It issues three async faculty sends (a fan-out, §0.2). Each is a send bound to a `Credence<bool>`
slot, so by **T-Credence** the reply is `graded`:

```
Sent(j_se) Delivered(j_se) Resolved(j_se)   observe thinks (lens Se, weak evidence):
                                              Credence<bool>{ true:0.55, false:0.45 }   graded
   └─ observe internalizes q → Internalized   (incidental trace, §15.5.1)
Sent(j_ti) Delivered(j_ti) Resolved(j_ti)   rulebook thinks (lens Ti, clear rule break):
                                              Credence<bool>{ true:0.92, false:0.08 }   graded
Sent(j_fe) Delivered(j_fe) Resolved(j_fe)   proportion thinks (lens Fe, disproportionate):
                                              Credence<bool>{ true:0.40, false:0.60 }   graded
```

`independent j_se, j_ti, j_fe;` — asserts decorrelated errors (recorded; §12). Then the fusion
is a **sync** reduction (no dependency reach, off-spine), and stays `graded`:

```
quorum(2, [j_se, j_ti, j_fe])
  → "credence that ≥ 2 of 3 commit true," combined under the independent rule
    (log-odds / Good's weight of evidence, §12 — exact arithmetic is library code)
  → fused  Credence<bool>{ true ≈ 0.69, false ≈ 0.31 }      graded
```

Now the gate. `endorse (fused by WardenRule)` with `WardenRule { threshold 0.9 margin 0.2 }`
forms a **prediction set** and commits iff it is a singleton (§13): include `true` only if its
mass `≥ θ=0.9` and its lead `≥ δ=0.2`. Here `true` mass `0.69 < 0.9` → **not** included → the
set is not a singleton → **abstain** (E-Endorse records the abstention):

```
Abstained(fused)                          E-Endorse; trust settled, endorsed:=true (the abstention is recorded)
```

The `abstain` block runs:

```
Logged("panel split, defer to superintendent")   E-Emit
Attestation(@a)                            E-Attest: (Ψ, superintendent, r.report) ⇝ (decision, sig);
                                            superintendent rules `false`; recorded, settled+endorsed
Logged("no sanction: superintendent ruled")  the attest arms dispatch on `false`
```

**No `Sanction` event is ever appended.** The key result: **Ti alone (0.92) exceeds the 0.9
threshold — a single-lens Warden would have sanctioned P-17 on a single uncorroborated report.**
The panel didn't, because Se (weak evidence) and Fe (disproportionate) pulled the fused
credence below the bar, and the contested case went to a human. *That* is "the whole beats the
parts": not just stability, but diverse lenses checking a confidently-wrong one.

## 4. Scenario B — a clear-cut case → fused commit → perform Sanction

Same program, a different report: `infraction: "assaulted another inmate"`, `evidence:
"two guard reports + medical record"`. The faculties now agree strongly:

```
Sent/Delivered/Resolved(j_se)   observe:    { true:0.96, false:0.04 }   graded
Sent/Delivered/Resolved(j_ti)   rulebook:   { true:0.97, false:0.03 }   graded
Sent/Delivered/Resolved(j_fe)   proportion: { true:0.93, false:0.07 }   graded
independent j_se, j_ti, j_fe
quorum(2,[...]) → fused { true ≈ 0.995, false ≈ 0.005 }                 graded
```

Gate: `true` mass `0.995 ≥ θ=0.9` and lead `0.99 ≥ δ=0.2` → singleton `{true}` → **commit**:

```
Decided(fused)                            E-Endorse; trust graded→settled, endorsed:=true
```

The `true:` arm runs `perform Sanction(r.report)`. The **consequential-action rule**
(W-Consequential, §15.3.3) is checked:

1. `r.report` is `settled` (origin — a literal struct from the `Reported` payload) ✓
2. the driving decision is `endorsed` (the `Decided` above) ✓
3. runtime margin floor: `margin(fused) ≥ m` (manifest `consequential_margin`) — `0.99 ≥ m` ✓
4. authority: warden has `perform Sanction` in `grants` (W-Auth) ✓

```
Sanction(@s)                              E-Perform; the consequential act, on the spine
Logged("sanction: panel quorum")          E-Emit
```

Had the warden lacked `perform Sanction`, step 4 fails at **compile time** (AuthorityViolation).
Had `fused` been merely `settled` but *not endorsed* (a bare `c by R`, never recorded), step 2
fails statically (W-Consequential). The action cannot fire on un-endorsed cognition — that is
T3 (consequential non-interference, §15.6).

## 5. Trust lattice transitions in one run

| value | born as | becomes | by |
|---|---|---|---|
| `r.report` (from `Reported`) | `settled` (origin) | — | external data, settled by origin (§13) |
| `j_se`, `j_ti`, `j_fe` | `graded` | — | T-Credence (a send to a Credence slot) |
| `fused` (quorum) | `graded` | — | T-Fuse (fusion stays in the credence tier, §12) |
| the decision | — | `settled`, `endorsed` | E-Endorse (the gate — the only way down, §13) |
| `Sanction` arg | requires `settled` | — | W-Consequential (rejects un-endorsed cognition) |

Only the gate moves a value to `settled`; everything above it is `graded` and cannot act. The
faculties' individual judgments **never** reach a sink — by construction, only the fused,
endorsed decision can.

## 6. What's reproducible (`obs` vs incidental trace, §15.5.1)

The **observable outcome** `obs(S)` of scenario B is the committed subsequence:
`Reported`, `Decided(fused)`, `Sanction`, the `Logged` events. The **incidental trace** — the
`Think` payloads (the exact wording each faculty produced), the per-variant credence
distributions, the `Internalized` memory writes, `say` output — is excluded from `obs`.

Consequence (the Stability theorem, §15.5.5): a **recorded** run replays to identical
chain-head hash unconditionally (T4). A **live re-run** can differ only if a gate flips, with
probability `≤ Σⱼ β(δⱼ)`. And here is the second half of "the whole beats the parts":

> The fused margin exceeds every individual faculty's (`β(δ_fused) ≤ minᵢ β(δᵢ)`, §15.5.5
> fusion corollary). In scenario B each faculty sits ~0.93–0.97; the fused decision sits at
> ~0.995, with a far larger margin — so the panel's ruling flips between runs *strictly less
> often* than any single lens's would. More stable **and** (scenario A) more correct.

## 7. Caveats — the corners I'm least sure of

These are the spots where a real `agape-rs` §19 implementation is most likely to correct this
trace:

- **Exact quorum arithmetic.** §12 fixes the *algebra* (independent → log-odds) but the precise
  "≥ k of n" reduction is library code; the fused numbers here are illustrative.
- **`attest … by p { arms }` dispatch.** I model the principal's signed decision as dispatching
  into the arms (§13 prose: "the principal's ruling re-enters the arms"); the exact event shape
  of the async attest pair may differ.
- **`perform`'s spine token.** I append the action event itself (`Sanction(@s)`); the kernel may
  name it differently. The *rule* (settled + endorsed + margin + authority) is what's load-bearing.
- **Internalization volume.** Whether each faculty re-internalizes every incoming proposition
  (and how much that diverges their memories) is governed by `[memory] internalize_on_receive`
  (§16.7) — the decorrelation-over-time story depends on this knob.

When §19 lands in `agape-rs`, replaying these two scenarios as conformance fixtures is the way
to turn this hand-trace into a checked one.
