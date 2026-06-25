# Agape v1.0 — Conformance Test Index

**60 tests** — accept: 39, reject: 21

A conformant implementation must satisfy every `accept`/`reject` test (rejects with the declared error class; accepts matching any asserted spine).


## 00_lexical

| id | expect | error | spec |
|---|---|---|---|
| `lex_comment_fstring` | accept | — | §2 (line comments; f-string interpolation; INT/FLOAT literals) |
| `lex_reject_right_arrow` | reject | LexError | §2 (exactly one communication arrow `<-`; `->` is a LexError) |
| `lex_reject_missing_semicolon` | reject | ParseError | §2 (statement terminator `;` is explicit and required) |
| `lex_reject_keyword_as_identifier` | reject | ParseError | §2 (reserved keywords may not be used as identifiers) |
| `lex_contextual_word_as_identifier` | accept | — | §2 (contextual words `as`/`by`/`reach`/`use`/`origin` lex as identifiers out of position) |

## 01_axes

| id | expect | error | spec |
|---|---|---|---|
| `axes_send_is_event_tainted` | accept | — | §1 Axis B/C (`d <- p` : event<T>, on the spine, and its reply is tainted P) |
| `axes_pure_call_sync_untainted` | accept | — | §1 Axis A/B (a pure `sync` fn is cognition-free and adds no taint) |
| `axes_credence_is_graded_judgment` | accept | — | §1, §8 (a semantic judgment is a seam send bound to Credence<E>) |
| `axes_decide_is_bool` | accept | — | §8, §13 (decide(Credence<bool>, rule) commits to a bool — untainted, in hand) |

## 03_types

| id | expect | error | spec |
|---|---|---|---|
| `type_scalars` | accept | — | §3 (scalars int/float/bool/text/null) |
| `type_event_null_no_reply` | accept | — | §3 (event<null> = sent, no typed reply bound) |
| `type_struct_decl_and_literal` | accept | — | §3 (struct declaration + struct literal supplying all fields) |
| `type_struct_missing_field_reject` | reject | TypeError | §3 (all struct fields required; no optional-by-omission) |
| `type_enum_decl_and_case` | accept | — | §3, §11 (enum declaration; case exhaustive over all variants) |
| `type_event_decl` | accept | — | §3 (custom spine-event declaration with a typed payload) |
| `type_undeclared_emit_reject` | reject | TypeError | §3 (events are not self-declaring; emit of an undeclared type is a TypeError) |
| `type_no_text_to_principal_reject` | reject | TypeError | §3, §13 (no text -> Principal coercion at a gate) |
| `type_decide_requires_rule_reject` | reject | ParseError | §3, §15.2 (decide's rule is mandatory) |
| `type_credence_only_from_seam_reject` | reject | TypeError | §3, §8 (Credence<E> is produced ONLY by a seam judgment, never constructed literally) |

## 04_functions

| id | expect | error | spec |
|---|---|---|---|
| `fn_sync_pure_ok` | accept | — | §4 (a sync fn that touches no seam is well-formed) |
| `fn_sync_reaches_seam_reject` | reject | ColorViolation | §1 Axis A, §4 (a sync fn may not reach the provider seam via `<-`) |
| `fn_sync_calls_async_reject` | reject | ColorViolation | §4 (a sync fn may only call other sync fns) |
| `fn_sync_emit_ok` | accept | — | §4 (emit is a spine op, permitted in sync) |
| `fn_sync_inhand_verify_ok` | accept | — | §4, §13 (in-hand verify = decide+emit, synchronous) |
| `fn_sync_tool_call_reject` | reject | ColorViolation | §4, §6b (a tool call reaches the tool seam → async) |
| `fn_sync_verify_by_principal_reject` | reject | ColorViolation | §4, §13 (verify … by Principal reaches the identity seam → async) |

## 05_agents

| id | expect | error | spec |
|---|---|---|---|
| `agent_spawn_instantiate_only` | accept | — | §5 (spawn instantiates only: no constructor body, no mailbox) |
| `agent_first_awake_runs_constructor` | accept | — | §5 (first awake opens the mailbox and runs the constructor) |
| `agent_reawake_no_reconstruct` | accept | — | §5 (re-awake runs the subsequent path: no re-bind, no re-construct) |
| `agent_sleep_runs_hook` | accept | — | §5 (sleep closes the mailbox and runs the on-sleep hook) |
| `agent_extend_inherits_when` | accept | — | §5 (extend inherits fields + constructor + when blocks + hooks) |
| `agent_prompt_opens_sensor` | accept | — | §5b (a `prompt` declaration opens a standing external input sensor) |

## 06_communication

| id | expect | error | spec |
|---|---|---|---|
| `comm_typed_reply` | accept | — | §6 (a typed reply binds the seam answer into event<T>) |
| `comm_self_send_thinks` | accept | — | §6 (sending to self is the agent's own cognition; needs no reach grant) |

## 07_spine

| id | expect | error | spec |
|---|---|---|---|
| `spine_prospective_only` | accept | — | §7 (subscriptions are prospective; never fire for prior events) |
| `spine_query_result_event` | accept | — | §10 (a query STATEMENT lands a QueryResult event on the spine) |
| `spine_tool_pair` | accept | — | §6b, §7 (a tool call appends a ToolStarted/ToolResolved pair) |

## 08_semantic

| id | expect | error | spec |
|---|---|---|---|
| `sem_credence_over_user_enum` | accept | — | §8 (a seam send bound to Credence<E> is a constrained classifier over E) |
| `sem_entailment_three_valued` | accept | — | §8, §9 (Credence<Entailment> over {Entails, Contradicts, Neutral}) |
| `sem_contradiction_emits_event` | accept | — | §8 (deciding a Credence<Entailment> to Contradicts also emits a first-class Contradiction) |

## 09_prelude

| id | expect | error | spec |
|---|---|---|---|
| `prelude_catch_error_catches_contradiction` | accept | — | §9 (Contradiction extends Error; catch Error catches it by subtype) |

## 10_memory

| id | expect | error | spec |
|---|---|---|---|
| `mem_match_is_gate` | accept | — | §10 (match > θ is a gate; yields an untainted result off-spine) |
| `mem_queried_fact_taint_reject` | reject | TaintViolation | §10, §13 (queried facts default to P-tainted; must be re-gated before a consequential emit) |

## 11_control

| id | expect | error | spec |
|---|---|---|---|
| `ctrl_if_else` | accept | — | §11 (if/else over a bool) |
| `ctrl_while_break` | accept | — | §11, §15.2 (while loop with break) |
| `ctrl_case_all_variants_ok` | accept | — | §11 (case covering every enum variant is exhaustive) |
| `ctrl_case_nonexhaustive_reject` | reject | ExhaustivenessError | §11 (a case with no default must cover all variants) |
| `ctrl_case_default_ok` | accept | — | §11 (a default arm makes a partial case exhaustive) |
| `ctrl_retry_bounded` | accept | — | §11 (bounded retry re-attempts a verify a fixed number of times) |

## 12_aggregation

| id | expect | error | spec |
|---|---|---|---|
| `agg_quorum_independent_ok` | accept | — | §12 (quorum over independent Credence<bool> judges fuses to one Credence<bool>) |
| `agg_quorum_no_dep_decl_reject` | reject | TypeError | §12 (fusion — incl. quorum — requires a total independent/dependent declaration) |

## 13_governance

| id | expect | error | spec |
|---|---|---|---|
| `gov_emit_ungranted_reject` | reject | AuthorityViolation | §13 (an agent may only emit event types in its grants) |
| `gov_gated_emit_ok` | accept | — | §13 (a verified Credence may cross an authority boundary) |
| `gov_consequential_bare_decide_reject` | reject | TaintViolation | §13 (a bare decide is committed but NOT authorized → reject at a consequential emit) |
| `gov_use_tool_granted_ok` | accept | — | §6b, §13 (a granted `use TOOL` permits the tool call) |
| `gov_use_tool_ungranted_reject` | reject | AuthorityViolation | §6b, §13 (default-deny: a tool call needs a `use` grant) |
| `gov_tool_result_tainted_emit_reject` | reject | TaintViolation | §6b, §13 (a tool result is T-tainted; cannot drive a consequential emit without a gate) |
| `gov_reach_ungranted_reject` | reject | AuthorityViolation | §13 (sending into another agent requires a `reach` grant) |
| `gov_extend_use_subtractive_reject` | reject | AuthorityViolation | §5, §13 (capabilities, incl. `use`, are subtractive under extend) |

## 15_reproducibility

| id | expect | error | spec |
|---|---|---|---|
| `repro_decide_off_spine` | accept | — | §15 (decide is a pure projection of a Credence already on the spine; off-spine itself) |
