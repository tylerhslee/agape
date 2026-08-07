# Research basis: autonomous learning, memory, and experimental agent architecture (2026)

Status: **informational design basis** (2026-08-06). This note records the evidence and
limits behind the companion autonomous-learning design. It does not amend language semantics.
`SPEC.md` and conformance suites remain the oracle.

## 1. Scope and method

This is a primary-source snapshot through 2026-08-06. It separates what each source reports
from implications for an inspectable agent runtime. Recent arXiv work and laboratory reports
are useful experimental evidence, not settled results. Nothing here asserts that a language
model or an Agape program is conscious, sentient, self-aware, or phenomenally experiencing.

No `SPEC.md` amendment is proposed by this note. The existing design already treats memory,
behavior activation, protected evidence, authority, and replay as separately auditable
mechanisms. The companion design clarification makes those boundaries explicit.

## 2. What the sources support - and do not support

### 2.1 A functional, model-internal broadcast channel is measurable

Gurnee et al., [*Verbalizable Representations Form a Global Workspace in Language
Models*](https://transformer-circuits.pub/2026/workspace/index.html) (Anthropic, published
2026-07-06; [arXiv:2607.15495](https://arxiv.org/abs/2607.15495), submitted 2026-07-16),
introduce the Jacobian lens and identify a token-verbalizable "J-space." Their interventions
support a functional claim: some representations are reportable, can be deliberately
modulated, carry intermediate reasoning, and are broadly usable downstream, while much
automatic processing does not depend on them.

This is not evidence of phenomenal consciousness. The authors explicitly limit their claim to
functional conscious access and report unresolved coverage, architecture, scaling, and
alignment-monitoring limits. The observed broadcast is along a transformer's depth and token
axes, not a demonstration of biological recurrence or modular brain architecture.

**Design implication:** an implementation may expose an optional, bounded typed
`working_state` or broadcast channel, with declared readers, retention, and interventions.
Its contents and metrics are experimental observations. It must not be called a consciousness
primitive or treated as a source of authority.

### 2.2 Neuroscience does not select a consciousness architecture for Agape

The Cogitate Consortium, including Ferrante et al., [*Adversarial testing of global neuronal
workspace and integrated information theories of consciousness*](https://www.nature.com/articles/s41586-025-08888-1),
*Nature* 642, 133-142 (2025-04-30), preregistered divergent IIT/GNWT predictions with 256
participants and fMRI, MEG, and intracranial EEG. It found some predictions consistent with
each theory and substantial challenges to key tenets of both.

It neither proves nor disproves either theory as a whole, and it is not evidence that a
software architecture realizes human consciousness.

**Design implication:** recurrence, broadcast scope, retention/consolidation, self-model
state, and drive/policy modules are independent experimental variables. A runtime records
which variables were enabled; it does not infer subjective experience from them.

### 2.3 Current self-improvement is bounded by evaluation and governance

Chen, Wang, and Qu, [*Recursive Self-Improvement in AI: From Bounded Self-Refinement to
Autonomous Research Loops*](https://arxiv.org/abs/2607.07663), arXiv:2607.07663
(2026-07-08), survey 1,250 2024-26 arXiv papers. Their taxonomy separates bounded
self-refinement from open-ended recursive self-improvement and emphasizes evaluator quality,
grounding, collapse, compute, and research direction-setting.

This is a survey and preprint, not an empirical demonstration that open-ended RSI exists.
Its useful design lesson is narrower: an improvement claim depends on an evaluation signal,
and signals differ greatly in strength.

Frontis-MA1 / OpenMLE, Junlin Yang et al., [arXiv:2607.28568](https://arxiv.org/abs/2607.28568)
(2026-07-30; [released code](https://github.com/FrontisAI/OpenRSI)), provides an executable
machine-learning-engineering environment and reports bounded benchmark gains from
execution-grounded Draft, Improve, Debug, and Crossover operators. Those results are recent,
author-reported, benchmark- and budget-specific; they are not evidence of self-sustaining
open-ended improvement.

Anthropic's [*When AI builds itself*](https://www.anthropic.com/institute/recursive-self-improvement)
(2026) similarly distinguishes current autonomous engineering/research assistance from a
hypothetical closed loop. It reports internal results but says direction-setting remains an
important gap. It is a laboratory account, not an independent capability measurement.

**Design implication:** represent adaptation as a governed experiment:

```text
named candidate -> isolated evaluation -> declared evidence -> authorized promotion | rollback
```

Each arrow binds immutable candidate and evaluator versions, evidence provenance, declared
budget/authority, outcome reliability, cost, and replay material. A candidate never selects
its evaluator, threshold, holdout, authority, or deployment envelope.

### 2.4 Memory, context, and durable competence are different mechanisms

Harrington et al., [*When Does Continual Learning Require Learning*](https://arxiv.org/abs/2607.07847),
arXiv:2607.07847 (2026-07-08), compare prompt-based methods, supervised/distillation methods,
online reinforcement learning, and context compression in sequential settings. The reported
results suggest different change patterns favor different mechanisms: prompt methods adapt
quickly but can degrade; distillation is stable but struggles with obsolete facts; compression
improves efficiency without substantial new-task learning; online RL adapts to updates but is
sensitive to noisy reward.

This is a benchmark result, not an argument for a single biological memory hierarchy. It does
support refusing to collapse context, stored episodes, consolidation, and model updates into
one `learn` operation.

**Design implication:** `store`/`recall` mean provenance-preserving episodic retrieval only.
They can change the data a provider sees during a reaction but do not, by themselves, attest
to changed competence. Consolidation and any policy/model mutation have separate, governed
transition records.

### 2.5 Long-horizon capability needs reliability and cost measurement

METR's [*Task-Completion Time Horizons of Frontier AI Models*](https://metr.org/time-horizons/)
(updated 2026-05-08) measures the human-expert duration of a task at a specified predicted
success probability on a software-task suite. It explicitly is not the elapsed time an agent
can remain autonomously active.

Cunningham, Shetty, Cheng, and Rush, [*Expenditure Horizon: Measuring Optimization Ability,
with an Application to NanoGPT*](https://metr.org/blog/2026-07-21-expenditure-horizon/)
(METR, 2026-07-21), define a cost crossing point between agent and human improvement curves.
Their NanoGPT numbers are preliminary and sensitive to human-cost estimates, noisy scores,
harnesses, and task representativeness.

**Design implication:** record outcome reliability against a declared evaluator or baseline,
alongside token, elapsed-time, tool/experiment, and materialized external cost. Do not equate a
larger task horizon or budget with persistent agency, competence change, or self-improvement.

## 3. Experimental discipline

An Agape experiment that studies agent organization should declare a profile containing only
explicit, independently switchable mechanisms, for example:

- recurrence/scheduling policy;
- working-state or broadcast scope and retention;
- episodic retrieval and memory-write policy;
- candidate consolidation policy;
- optional self-model data and drive/policy module;
- evaluator, baseline/holdout, budget, and authority envelope.

The profile, enabled toggles, outcome metrics, protected raw-evidence references, and
negative/ablation controls belong in the ledger/replay record. Results should state only the
measured behavioral or reliability difference under the declared profile. They must not claim
that a toggle created consciousness, agency, learning, alignment, or stable identity unless a
separately defined measure supports exactly that claim.

## 4. Normative design consequences

The companion document therefore requires:

1. separate working-state, episodic-memory, consolidation, and policy/model-adaptation
   concepts;
2. truthful `store`/`recall` receipts that do not imply competence change;
3. immutable named candidates and evaluator versions;
4. protected held-out evidence where available, or an explicitly declared counterfactual
   baseline and limitation where it is not;
5. budget, authority, provenance, promotion, rollback, and replay bindings for adaptation;
6. experimental toggle and reliability/cost recording without consciousness claims.

These are design requirements for inspectability and governance, not an attempt to make Agape
implement IIT, GNWT, a global-workspace theory, or recursive self-improvement as a slogan.
