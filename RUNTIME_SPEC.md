# Agape Runtime Specification — merged into the language spec

> **This document has moved.** The runtime contract is no longer a standalone spec; it is
> now **§16 (The runtime)** and **§17 (Configuration & the project manager)** of
> [`SPEC.md`](SPEC.md). The language and its runtime are a single document so the two layers
> — what programs *mean* (§0–§15) and what a conformant runtime *does* (§16–§17) — stay in
> one consistent picture.

The obligations that lived here are now sections of [`SPEC.md`](SPEC.md):

| former section (this file)        | now in `SPEC.md`                                  |
| --------------------------------- | ------------------------------------------------- |
| 1. Scope                          | §16 intro ("One runtime, one system")             |
| 2. Required Invariants            | §14 (kernel invariants) + §16.7                   |
| 3. Runtime Identity And Isolation | §16.1a                                             |
| 4. Ledger Contract                | §16.2                                             |
| 5. Agent Private Memory Architecture | §16.7 ("The memory cell")                       |
| 6. Mandatory Memory Envelope      | §16.7 ("Memory envelope")                         |
| 7. Knowledge Artifact Internalization | §16.7b                                        |
| 8. Learning From Experience       | §16.7c                                             |
| 9. Replay And Determinism         | §16.5                                             |
| 10. Runtime API Surface           | §16.9                                             |
| 11. Conformance Requirements      | §17.5 ("Memory-envelope coverage")                |
| 12. Runtime Lockstep              | §17.6                                             |

Every conformant runtime — the Rust CLI runtime, the Studio runtime, and hosted runtimes such
as Soma — is built against [`SPEC.md`](SPEC.md) §16–§17.
