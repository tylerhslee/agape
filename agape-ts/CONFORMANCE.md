# agape-ts — conformance status vs the black-box suite

This implementation is run against `../agape-conformance` (Agape v1.0.0-alpha.2026.6.30.0,
208 tests) by `conformance/run.mts`, which feeds each test's program through this front end
(lex → parse → **check**) + runtime (**run**) and matches the `//!`-header expectation
(`accept`/`reject` + error class + ledger matchers + §17.5 directives).

```bash
npx tsx conformance/run.mts                 # scorecard + conformance/results.json
npx tsx conformance/run.mts --section 22_gate --verbose   # one section, with failure reasons
```

## Scorecard (current)

Measured against the **canonical, un-edited** suite (the conformance tests and `SPEC.md` are the
oracle and are never modified to make the implementation pass).

```
TOTAL  175 / 229  (76.4%)       before the modules-and-cross-module-visibility pass: 151 / 229

00_lexical          9 / 11    12_aggregation     10 / 10  ✓
01_axes             4 / 4  ✓  13_governance      22 / 31
03_types           19 / 22    15_reproducibility  2 / 2  ✓
04_functions        8 / 10    16_config           1 / 9
05_agents           9 / 12    18_modules         14 / 14  ✓
06_communication    3 / 7     19_visibility      12 / 12  ✓
07_ledger           5 / 7     20_generics         8 / 8  ✓
08_semantic         4 / 10    21_interfaces      10 / 10  ✓
09_prelude          3 / 6     22_gate            11 / 19
10_memory          15 / 16
11_control          6 / 9
```

The **modules / cross-module visibility** pass (§19.2/§19.2a/§19.3/§19.4) took `18_modules` 1 → **14/14**
and `19_visibility` 2 → **12/12** (and, as a spec-faithful side effect of the built-in `Error`-supertype
ledger visibility, `09_prelude` 2 → 3: `prelude_user_error_subtype_caught`). No section regressed; the 21
kernel vitest tests stay green.

This is a **vertical slice**: the trusted-kernel happy-path (testimony → `Credence` → `decide`
→ `endorse` → granted sink → ledger) plus a static checker for the type-shape compile errors. The
large feature areas below are not yet implemented; their tests fail by design.

## Memory-repair pass (root-cause fixes; oracle untouched)

- **Both field-declaration forms parse.** SPEC §3 writes struct/event/action fields name-first
  (`struct Memo { amount: int, to: text }`, `event NAME(field: T)`) while the `action Transfer(int cents)`
  example is type-first; the suite uses **both**. `src/parser.ts` now accepts `name: T` AND `T name`
  uniformly (`parseField`), so the 43 name-first suite files parse without editing the tests. *(An
  earlier pass had instead rewritten those 43 tests + SPEC.md to type-first — oracle tampering — which
  has been fully reverted.)*
- **Structs are real record values (§3).** `structlit` evaluates to a `struct` value carrying its
  fields, so member access (`m.to`) reads them back; the checker validates struct-literal field arity
  against the declaration (missing field / undeclared extra field → `TypeError`).
- **Queried values never launder trust (§10, §16.7).** `evalQuery` returns `graded` for **every**
  query — `from self` AND `from ledger`. A ledger holds un-endorsed events, so the previous blanket
  `settled` for `from ledger` laundered a tainted value at a sink; a query result is `settled` only
  when a matched row's provenance event is endorsed (none, for the empty v0 result set).
- **§13 dependency-scope check.** A tainted recalled/queried subject may be endorsed only by a decision
  whose dependency scope contains it (the credence it collapsed + that credence's prompt operands). An
  `endorse r by d` where `r` is an off-gate memory read outside `d`'s scope is a `TypeError`, closing the
  endorse-wrapper laundering channel. The check is conservative: it fires only on a provably-tainted,
  provably-out-of-scope subject, so no `accept` test is false-rejected.
- **Error taxonomy** (`src/errors.ts`): a typed `AgapeError { cls }` carrying the suite's error
  classes (`TypeError`, `TaintViolation`, `AuthorityViolation`, `ColorViolation`,
  `ExhaustivenessError`, `ConfigError`, `GateError`). The runner maps rejections by class.
- **Semantic checker** (`src/check.ts`) — a conservative static pass run before execution:
  undeclared `emit`/`perform` → `TypeError`; arity mismatch → `TypeError`; scalar payload type
  mismatch → `TypeError`; `Credence`/non-bool in `if` → `TypeError`; var-decl shape mismatch
  (e.g. assigning a `Decision` to an `Endorsement`) → `TypeError`; `Decision`/`Endorsement`
  provenance fields are read-only (`d.margin = …`) → `TypeError`; arm-block exhaustiveness scaffolding.
  It defaults every un-inferable construct to `unknown` so it never false-rejects an accept test.
- **Parser fix**: `Credence<bool>` / `Decision<bool>` (and other scalar type args) now parse — the
  type argument accepts a scalar keyword, not only an enum identifier. (Was a real bug blocking
  valid programs across §01/§05/§08/§12/§13/§15.)
- **Kernel safety**: a bare `Decision` or `Credence` reaching a consequential sink is now a
  `TaintViolation` — only a committed-narrowed `Endorsement` may settle a subject (§13).
- **Built-in event roots**: `emit Event(…)` / `emit Error(…)` are valid without a user declaration
  (§9); other undeclared `emit` is still a `TypeError`.

## Modules and cross-module visibility (§19.2/§19.2a/§19.3/§19.4)

The library layer is **static and erases before the dynamic semantics** (§19.1): visibility gates
*names*, never the ledger. The one runtime-visible touch is that an event's `etype` is fully qualified,
so the same simple name in two modules (`a.Tick` ≠ `b.Tick`) is two distinct ledger rows.

- **The module SEAM is fixed harness plumbing** (set by the project owner, not changed here):
  `check(program, modules?: ModuleInput[])`, `run(program, { modules })`, `ModuleInput = { name?; src }`,
  and the companion-loading in `conformance/run.mts` are contract. The linker in `src/check.ts`
  (`linkModules`) *consumes* `modules` — it parses each companion, keys it by `entry.name ?? header ??
  <root>` (a `packages:` `name` overrides the companion's own `module` header, §19.3), builds the export
  tables, runs cycle detection, resolves the main program's imports, and returns an erased `Resolution`
  (qualified-decl table + selective bare bindings) reused by the checker and the interpreter.
- **Parser**: a leading `module modpath;` header, then a contiguous `import*` block (`import M`,
  `import M as X`, `import { A, B } from M`, each optionally `pub`), then decls. A `qname()` reader makes
  every declaration-referencing position (type, `when` etype, `spawn`/`extend` target, `emit`/`perform`
  name, `reach`/`requires` cap, struct-literal head) accept a dotted qualified name; a bare name stays
  undotted, so single-module programs parse byte-identically.
- **ModuleError vs VisibilityError split** (getting the class/order wrong flips a target test):
  a selective import checks **existence first, pub-ness second** — an unknown member (`import { missing }
  from util`) is a `ModuleError`; a member that exists but is **not `pub`** (`import { secret } from m`)
  is a `VisibilityError`. A cycle, an unresolved import/module, and an ambiguous bare *use* are
  `ModuleError`; a cross-module reference to a private decl (qualified reference, `spawn`, `emit`,
  `perform`, `when`, `reach`, `extend`) and a `pub import` of a non-`pub` name are `VisibilityError`.
- **Ambiguity is use-driven**: a bare name selectively imported from two modules is a `ModuleError`
  *only when actually used unqualified* — imported-but-unused, or always-qualified, is fine (§19.2).
- **`Error` supertype is cross-module**: an emitted `event Foo(..) : Error` lands under its own
  qualified etype (visibility never suppresses the append) and is additionally auditable as `Error`, so
  a `when (Error e)` in another module catches it by supertype, not by its private name.

## Suite-bug notes (reported, NOT edited)

The suite and `SPEC.md` are the oracle: where the implementation disagrees, the implementation is
fixed or the discrepancy is reported here — the tests are never edited to force a pass. Open items:

- **`case` construct** — `ctrl_case_*` use `case (c by R) as v { V: … }`, a control form that the gate
  model replaced with `decide`/`endorse` arm blocks (§11/§13). Either the suite should migrate them to
  arm blocks or SPEC should restore `case`; left to the suite owner (changes test logic, not ours).
- **principal in the `by`-position** — `gov_principal_decision_*` and the gate principal tests write
  `decide c by alice`, while SPEC §13 makes the principal a **prefix** (`alice decide c by r`) and the
  `by NAME` slot a **policy** name. The parser does not yet accept `principal name;` declarations; this
  is an unimplemented feature, not a suite edit.

## Roadmap — remaining features (by yield)

| Feature | Unlocks (≈) | Notes |
|---|---|---|
| Tools: `tool`/`read`/`write` decls + `ToolStarted`/`ToolResolved` pairs, settle/taint rules | 13 (6), 07, 10, 16 | read-tool result is settled; write-tool needs settled input |
| `when`-event dispatch (emit/tool/principal events fire `when` handlers) | 07, 09, 22, 05 | needs an event-delivery step in the interpreter |
| Memory: `mem`/`find`/`select`/`forget`/`match`/`store`/`embed` + `Internalized`/`Forgotten`/`QueryResult` | 10 (13) | |
| Aggregation: `all`/`any`/`quorum`/`independent`/`dependent` fuse | 12 (10) | |
| `sync` functions + calls + color (async/sync) checker → `ColorViolation` | 04 (9), 01, 12, 15, 19 | |
| `struct` decls/literals/field access | 03, 20 | |
| Modules / visibility / generics / interfaces | 18 (12), 19 (12), 20 (8), 21 (8) | `ModuleError`/`VisibilityError`/`InterfaceError` |
| Config + §17.5 harness (`empty`→crash, `schema_violation`→`TypeMismatch`, `ConfigError`, `policy`/`principal`/file-`conformal` decls) | 16 (8), 08 (7) | |
| Principal escalation prefix (`p decide c by r`) + `principal name;` decls | 13, 22 | parser already accepts the prefix; needs the decl + ledger `PrincipalDecision` wiring |
| Replay harness (re-serve recorded oracle/tool results; prove no re-invocation) | 15 (2), 13 | |
