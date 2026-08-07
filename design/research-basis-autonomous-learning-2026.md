# Research basis: autonomous learning, memory, and experimental agent architecture (2026)

Status: **informational research basis for future experiments, not current beta
semantics** (2026-08-06). This note preserves the primary-source evidence behind
possible adaptation experiments. It does not amend SPEC.md, make a runtime conformant,
or require a companion normative learning architecture.

## 1. Scope and limits

Nothing here asserts that a language model or an Agape program is conscious, sentient,
self-aware, or phenomenally experiencing. Recent papers and laboratory reports motivate
measurable experiments; they do not establish open-ended recursive self-improvement or
a consciousness architecture.

## 2. Evidence

Gurnee et al., [Verbalizable Representations Form a Global Workspace in Language
Models](https://transformer-circuits.pub/2026/workspace/index.html) (Anthropic,
2026-07-06; [arXiv:2607.15495](https://arxiv.org/abs/2607.15495)), introduce the
Jacobian lens and report a token-verbalizable J-space with functional properties of
reportability, deliberate modulation, intermediate reasoning, and broad downstream
availability. The authors limit this to functional access and identify coverage,
architecture, scaling, and monitoring limits.

The Cogitate Consortium, [Adversarial testing of global neuronal workspace and
integrated information theories of consciousness](https://www.nature.com/articles/s41586-025-08888-1)
(2025), challenged important predictions of both IIT and GNWT. It does not select a
software consciousness architecture.

Chen, Wang, and Qu, [Recursive Self-Improvement in AI: From Bounded Self-Refinement
to Autonomous Research Loops](https://arxiv.org/abs/2607.07663) (2026-07-08), survey
1,250 papers and distinguish bounded refinement from unproven open-ended RSI.
[OpenMLE](https://arxiv.org/abs/2607.28568) (2026-07-30) reports bounded,
execution-grounded ML-engineering gains; it is a recent author-reported testbed, not
a self-sustaining improvement loop. Anthropic's [When AI builds
itself](https://www.anthropic.com/institute/recursive-self-improvement) likewise
describes an emerging problem rather than an achieved closed loop.

Harrington et al., [When Does Continual Learning Require
Learning](https://arxiv.org/abs/2607.07847) (2026-07-08), compare prompt methods,
distillation, online RL, and compression. Their results support separating context,
stored experience, consolidation, and durable competence rather than treating one
memory store as learning.

METR's [task-completion horizons](https://metr.org/time-horizons/) (updated
2026-05-08) measure predicted success at a human-expert task duration; this is not
operational persistence. METR's [expenditure horizon](https://metr.org/blog/2026-07-21-expenditure-horizon/)
(2026-07-21) measures a cost crossing point for optimization, with stated harness and
cost-model limitations.

## 3. Implications for Agape experiments

The language assigns these capabilities to explicit surfaces:

- explicit store/recall changes the available tainted data while preserving source
  competence and authority;
- calibration evidence belongs to a bounded advertised connector profile;
- a model-internal workspace observation is protected model-specific telemetry with
  no language authority or gate status; and
- candidate consolidation, evaluator selection, promotion, rollback, policy/model
  updates, and deployment transitions belong to advertised research profiles.

A research experiment may independently toggle recurrence, retrieval,
consolidation, working-state/broadcast scope, self-model data, and evaluation. It
must compare declared baselines and ablations, record evidence and resource budgets,
and state only measured behavioral or reliability outcomes.

## 4. Adaptation profile requirements

An advertised behavior-adaptation profile defines its candidate, evaluator, and
promotion obligations:

1. named inert candidate and evaluator versions;
2. deployment-selected evidence, holdout/baseline, budget, and authority envelope;
3. isolated evaluation and replay material;
4. explicit human or deployment approval for any live transition; and
5. rollback and failure reporting without authority expansion.

These conditions make adaptation inspectable and governable. Active source and
authority remain fixed until an explicit, approved source-version transition is
deployed.
