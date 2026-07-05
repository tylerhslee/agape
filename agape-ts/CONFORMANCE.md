# agape-ts — conformance status vs the black-box suite

This implementation is run against `../agape-conformance` (Agape **v1.0.0-alpha.2026.7.5.0**, the
**core kernel** — 164 tests) by `conformance/run.mts`, which feeds each test's program through this
front end (lex → parse → **check**) + runtime (**run**) and matches the `//!`-header expectation
(`accept`/`reject` + error class + ledger matchers + §17.5 directives).

```bash
npx tsx conformance/run.mts                 # scorecard + conformance/results.json
npx tsx conformance/run.mts --section 22_gate --verbose   # one section, with failure reasons
```

## Scorecard (current)

Measured against the canonical suite (the conformance tests and `SPEC.md` are the oracle; a test is
changed only with spec-grounded evidence that the test itself is wrong).

```
TOTAL  164 / 164  (100%)        kernel vitest suite: 33 / 33        tsc --noEmit: clean

00_lexical         11 / 11  ✓   10_memory          11 / 11  ✓
01_axes             4 / 4   ✓   11_control          5 / 5   ✓
03_types           22 / 22  ✓   12_aggregation      5 / 5   ✓
04_functions        9 / 9   ✓   13_governance      30 / 30  ✓
05_agents          12 / 12  ✓   15_reproducibility  2 / 2   ✓
06_communication    7 / 7   ✓   16_config           9 / 9   ✓
07_ledger           7 / 7   ✓   22_gate            14 / 14  ✓
08_semantic        10 / 10  ✓
09_prelude          6 / 6   ✓
```

## Grammar lockstep

The parser accepts **exactly** the core-kernel grammar (SPEC §15.2). A post-parse pass
(`assertCore`, `src/parser.ts`) rejects every construct outside the core as a `ParseError`:
the gate arm block (branch on `.committed` with `if` instead), `all`/`any`/`|>` fusion (use
`quorum`), `find`/`match` and `select`-over-agent-memory (use recall, or `select … from ledger`),
the `policy` declaration (put the rule inline on the gate: `confidence θ [margin δ] [floor m]` /
`conformal α [readiness N] [floor m]`), `retry`, `reversible` sinks, and the whole deferred library
layer (`module`/`import`, `pub`, generics, interfaces).

## The gate (§13/§15.3.3)

`decide` and `endorse` are plain value-producing expressions. Every `decide` appends `Decided` and
returns a `Decision` with `.decision_id`; `endorse subject by d` is legal only after
`if (d.committed == V)` flow-narrows `d` to a real committed variant, then appends `Endorsed` tied to
that `decision_id`. The raw subject stays tainted (performing it directly is a `TaintViolation`);
the abstained `else` branch has no endorsement to give. Deference is per handler body: a cold
conformal, non-principal endorsement reaching a non-reversible sink with no reachable principal
escalation is a `GateError`.

## Open items

None against the current suite. Historic suite-bug notes (the removed `case` construct; the
principal-in-`by`-position form) were resolved upstream — `case` was removed from the language and
the principal became the prefix form (`p decide c by r`), with the suite migrated accordingly.
