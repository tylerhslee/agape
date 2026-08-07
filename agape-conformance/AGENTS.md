# AGENTS.md — agape-conformance

The black-box `.ag` conformance suite: **this suite is THE ORACLE.** Each test is a
valid Agape program tagged with an expected outcome, derived **only** from `../SPEC.md`
— never from any implementation. An implementation is conformant iff it satisfies
all `253` tests in the current index.

## Commands (verified green)
```sh
python3 build_manifests.py              # rebuild MANIFEST.toml + MANIFEST.md from //! headers
python3 build_manifests.py --check      # CI gate -> "ok: 253 tests, manifests up to date"
```
`build_manifests.py` only reads tests and writes the two manifests; it never touches an
`.ag` file. The `.ag` files are the source of truth — **edit them directly**; the
`MANIFEST.*` indexes are derived and must not be hand-edited.

## Test file format (`//!` header, terminated by `//! ---`)
```
//! id:        world_pure_perform_reject   # unique, matches filename stem
//! section:   06b_world                    # matches the directory
//! expect:    reject                        # accept | reject
//! error:     ColorViolation               # required iff reject; the error CLASS asserted
//! spec:      §4, §6b                        # the SPEC.md clause(s) pinned
//! ---
action Ping(text note);
pure null poke() { perform Ping("x"); return; }
```
Optional keys: `ledger` (exact ordered), `contains`/`absent` (order-free), `order`
(subsequence), `schema`, `provider` (§17.5 stub), `principal` (grant/deny), `manifest`,
`replay: chain_head_equal`, `note`. Error classes: `LexError` `ParseError` `TypeError`
`ColorViolation` `TaintViolation` `AuthorityViolation` `ConfigError` `GateError`.

## Adding / changing a test
1. Add the `.ag` with a complete header (positive **and** the negative kernel-boundary
   cases: taint, authority, endorsement, effect, config binding, replay).
2. `python3 build_manifests.py` then confirm `--check` passes.
3. Keep coverage docs honest: `COVERAGE.md` / `SPEC_COVERAGE.md` counts must match reality.

## Boundaries
**Always:** derive tests from `SPEC.md` only; rerun `build_manifests.py --check` after any
header edit; for a `reject` test assert the exact error class (rejecting for the wrong
reason is a failure).
**Ask first:** changing any existing test's **semantics** — it requires spec-grounded
justification **recorded in the commit message**.
**NEVER:** weaken or delete a test to make an implementation pass; hand-edit
`MANIFEST.toml`/`MANIFEST.md`; derive a test from an implementation's behavior instead of
the spec; leave `COVERAGE.md`/`SPEC_COVERAGE.md` counts out of sync with the suite.
