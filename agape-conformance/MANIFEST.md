# Agape v1.0.0-alpha.2026.7.2.0 — Conformance Test Index

**164 tests** — accept: 101, reject: 63

A conformant implementation must satisfy every `accept`/`reject` test (rejects with the declared error class; accepts matching any asserted spine).


## 00_lexical

| id | expect | error | spec |
|---|---|---|---|
| `lex_comment_fstring` | accept | — | §2 (line comments; f-string interpolation; INT/FLOAT literals) |
| `lex_contextual_word_as_identifier` | accept | — | §2 (contextual words `as`/`by`/`reach`/`use`/`origin` lex as identifiers out of position) |
| `lex_reject_fstring_escaped_brace` | reject | ParseError | §2 (f-string braces introduce parsed expressions; escaped literal braces are not part of the grammar) |
| `lex_reject_keyword_as_identifier` | reject | ParseError | §2 (reserved keywords may not be used as identifiers) |
| `lex_reject_leading_dot_number` | reject | ParseError | §2 (Float is decimal digits with a point; `.5` is not a numeric literal) |
| `lex_reject_malformed_fstring` | reject | ParseError | §2 (f-string interpolation braces must parse as expressions) |
| `lex_reject_missing_semicolon` | reject | ParseError | §2 (statement terminator `;` is explicit and required) |
| `lex_reject_tilde` | reject | ParseError | §2 (there is no similarity operator; `~` lexes to an Op but the parser rejects it — a ParseError, not a LexError) |
| `lex_reject_trailing_dot_number` | reject | ParseError | §2 (Float is decimal digits with a point and digits; `1.` is not a numeric literal) |
| `lex_reject_unknown_operator` | reject | LexError | §2 (operators outside the specified surface are rejected) |
| `lex_string_escapes` | accept | — | §2 (string escapes \n \t \" \\ are recognized inside a string literal) |

## 01_axes

| id | expect | error | spec |
|---|---|---|---|
| `axes_collapse_is_decision` | accept | — | §13, §15.2 (`decide c by R` collapses a Credence to a settled, ledgered Decision) |
| `axes_credence_is_graded_judgment` | accept | — | §1, §8 (a semantic judgment is a provider send bound to Credence<E> → graded) |
| `axes_pure_call_sync_settled` | accept | — | §1 Axis A/B (a pure `sync` fn reaches no dependency and stays `settled`) |
| `axes_send_reply_is_raw` | accept | — | §1 Axis B/C, §15.3.2 T-Send (`d <- p` is on the ledger; its reply is `raw`) |

## 03_types

| id | expect | error | spec |
|---|---|---|---|
| `type_action_multifield_arity_reject` | reject | TypeError | §3, §13 (perform arity must match the declared action signature) |
| `type_action_multifield_payload_ok` | accept | — | §3, §13 (perform invocation uses positional fields in declaration order) |
| `type_action_multifield_type_reject` | reject | TypeError | §3, §13 (perform arguments are type-checked positionally) |
| `type_action_payload_type_mismatch_reject` | reject | TypeError | §3 (perform payload must match the declared action signature) |
| `type_array_literal_and_type` | accept | — | §3, §15.2 (array<T> is the collection type; an array literal binds to an array<T> slot) |
| `type_collapse_requires_rule_reject` | reject | ParseError | §3, §15.2 (a gate requires its rule; `c by` with no rule is a ParseError) |
| `type_credence_only_from_seam_reject` | reject | TypeError | §3, §8 (Credence<E> is produced ONLY by a provider judgment, never constructed literally) |
| `type_enum_decl_and_gate` | accept | — | §3, §11, §13 (enum declaration; a gate decision branched with an if-chain over its variants) |
| `type_event_decl` | accept | — | §3 (custom ledger-event declaration with a typed payload) |
| `type_event_multifield_arity_reject` | reject | TypeError | §3 (emit arity must match the declared event signature) |
| `type_event_multifield_payload_ok` | accept | — | §3 (event invocation uses positional fields in declaration order) |
| `type_event_multifield_type_reject` | reject | TypeError | §3 (emit arguments are type-checked positionally) |
| `type_event_null_no_reply` | accept | — | §3 (null = sent, no typed reply bound) |
| `type_no_text_to_principal_reject` | reject | TypeError | §3, §13 (a principal basis must be a declared `principal`, not a string; `decide c by "alice"` has no text -> Principal coercion) |
| `type_rule_not_first_class_reject` | reject | TypeError | §3 (Rule is the gate parameter, not a first-class user-declared storage type) |
| `type_scalars` | accept | — | §3 (scalars int/float/bool/text/null) |
| `type_struct_decl_and_literal` | accept | — | §3 (struct declaration + struct literal supplying all fields) |
| `type_struct_extra_field_reject` | reject | TypeError | §3, §8 (struct literals/schema objects are exact; extra fields are rejected) |
| `type_struct_missing_field_reject` | reject | TypeError | §3 (all struct fields required; no optional-by-omission) |
| `type_undeclared_emit_reject` | reject | TypeError | §3 (events are not self-declaring; emit of an undeclared type is a TypeError) |
| `type_undeclared_perform_reject` | reject | TypeError | §3 (actions are not self-declaring; perform of an undeclared type is a TypeError) |
| `type_undeclared_tool_call_reject` | reject | TypeError | §6b (an undeclared tool call is a TypeError — tools, like events, are not self-declaring) |

## 04_functions

| id | expect | error | spec |
|---|---|---|---|
| `fn_sync_calls_async_reject` | reject | ColorViolation | §4 (a sync fn may only call other sync fns) |
| `fn_sync_decide_by_principal_reject` | reject | ColorViolation | §4, §13 (`decide c by p` for a principal reaches the identity dependency → async; a sync fn may not) |
| `fn_sync_emit_ok` | accept | — | §4 (emit is a ledger append, permitted in sync; a plain event needs no power) |
| `fn_sync_inhand_decide_ok` | accept | — | §4, §13 (a rule-driven `decide` over an in-hand Credence is a pure collapse, no dependency reach → sync-permitted) |
| `fn_sync_pure_ok` | accept | — | §4 (a sync fn that reaches no declared dependency is well-formed) |
| `fn_sync_reaches_seam_reject` | reject | ColorViolation | §1 Axis A, §4 (a sync fn may not reach the provider via `<-`) |
| `fn_sync_store_reject` | reject | ColorViolation | §9, §10 (a mem write reaches the provider-backed memory substrate to internalize, so a sync function may not store) |
| `fn_sync_tool_call_reject` | reject | ColorViolation | §4, §6b (a tool call reaches the tool dependency → async) |
| `fn_taint_flows_through_call_reject` | reject | TaintViolation | §15.3.3 (function calls are trust-transparent; taint flowing through a helper still cannot reach a consequential sink) |

## 05_agents

| id | expect | error | spec |
|---|---|---|---|
| `agent_crash_contained` | accept | — | §5 (an unrecoverable seam failure — the provider returns nothing — crashes the agent: AgentCrashed is recorded, the on-crash hook runs, and state survives; a crash is contained, not a death) |
| `agent_extend_inherits_when` | accept | — | §5, §7 (extend inherits fields + constructor + when blocks + hooks) |
| `agent_first_awake_runs_constructor` | accept | — | §5 (first awake opens the mailbox and runs the on-awake hook) |
| `agent_instruction_extend_append_accept` | accept | — | §5 (global, parent, and child instructions compose in order; extend appends behavior instead of weakening the parent) |
| `agent_instruction_global_accept` | accept | — | §5 (a top-level `instruction` is the global compile-time system prompt) |
| `agent_instruction_requires_string_reject` | reject | ParseError | §5 (`instruction` takes a string literal — the system prompt) |
| `agent_instruction_scoped_accept` | accept | — | §5 (an agent-scoped `instruction` composes after the global block) |
| `agent_prompt_opens_sensor` | accept | — | §5b (a `prompt` declaration opens a standing external input sensor) |
| `agent_prompt_value_drives_perform_ok` | accept | — | §5b, §13 (a prompt value is external data, settled by origin, and may drive a perform) |
| `agent_reawake_no_reconstruct` | accept | — | §5 (re-awake resumes the agent: no re-bind, no re-construct) |
| `agent_sleep_runs_hook` | accept | — | §5 (sleep closes the mailbox and runs the on-sleep hook) |
| `agent_spawn_instantiate_only` | accept | — | §5 (spawn instantiates + constructs only: no mailbox, no awake hook) |

## 06_communication

| id | expect | error | spec |
|---|---|---|---|
| `comm_expiry_tombstone` | accept | — | §6 (a send whose `expires` lifetime elapses before Delivered appends an Expired tombstone; no Delivered follows) |
| `comm_late_delivery_refused` | accept | — | §6, §9 (a delivery attempt after expiry records DeliveryRefused, not Delivered, and is not an Error) |
| `comm_lifecycle_order` | accept | — | §6 (a delivered send moves through Sent → Delivered → Resolved, in that order, each a ledger event correlated by corr) |
| `comm_self_send_thinks` | accept | — | §6 (sending to self is the agent's own cognition; needs no reach grant) |
| `comm_send_expires_ok` | accept | — | §6 (a send may carry a lifetime: `dest <- msg expires N`; reach into Worker is granted) |
| `comm_send_lost_no_delivery` | accept | — | §6 (a send to a non-awake agent is lost — the chain stalls at Sent, never Delivered; loss is the absence of Delivered, not an event) |
| `comm_typed_reply` | accept | — | §6 (a typed reply binds the provider answer into a typed value; the send lifecycle is ledgered) |

## 07_ledger

| id | expect | error | spec |
|---|---|---|---|
| `ledger_exact_spine` | accept | — | §7, §16.2 (ledger assertions can pin the exact ordered event spine, with no extra events) |
| `ledger_multi_handler_order` | accept | — | §7 (when several subscriptions match one appended event in one tick, they fire in registration/hoist order — within a scope, lexical order) |
| `ledger_prospective_only` | accept | — | §7 (subscriptions are prospective; never fire for prior events) |
| `ledger_query_result_event` | accept | — | §10 (a query STATEMENT lands a QueryResult event on the ledger) |
| `ledger_tool_pair` | accept | — | §6b, §7 (a tool call appends a ToolStarted/ToolResolved pair) |
| `ledger_when_about_filters` | accept | — | §7 (a `when (Type b about subj)` fires only for events about the held subject; the bound event evaluates to its payload) |
| `ledger_when_guard_ok` | accept | — | §7 (a `when … if (guard)` filters by an ordinary predicate over the bound event's fields) |

## 08_semantic

| id | expect | error | spec |
|---|---|---|---|
| `sem_contradiction_emits_event` | accept | — | §8, §11 (committing a Credence<Entailment> to Contradicts also emits a first-class Contradiction) |
| `sem_credence_over_user_enum` | accept | — | §8 (a provider send bound to Credence<E> is a constrained classifier over E) |
| `sem_entailment_three_valued` | accept | — | §8, §9 (Credence<Entailment> over {Entails, Contradicts, Neutral}) |
| `sem_sample_unknown_reject` | reject | TypeError | §8 (there is no sampling combinator in the surface language; a use of `sample` is an unknown-identifier error) |
| `sem_schema_array_nested_exact` | accept | — | §8 (array<T> compiles to an array schema whose item schema is the exact schema for T) |
| `sem_schema_enum_exact` | accept | — | §8 (Enum compiles to a closed enum structured-output schema) |
| `sem_schema_struct_exact` | accept | — | §8 (struct compiles to an exact object schema with all fields required and no extra fields) |
| `sem_schema_violation_array_typemismatch` | accept | — | §8 (array<T> compiles to schema-constrained output; schema failure raises TypeMismatch) |
| `sem_schema_violation_enum_typemismatch` | accept | — | §8 (Enum compiles to a closed enum schema; schema failure raises TypeMismatch) |
| `sem_schema_violation_typemismatch` | accept | — | §8 (structured output uses constrained decoding; on schema failure the runtime raises a clean TypeMismatch — catchable and retryable) |

## 09_prelude

| id | expect | error | spec |
|---|---|---|---|
| `prelude_action_cannot_be_error_reject` | reject | ParseError | §19.5 (only `event` may extend Error; an action supertype is a ParseError) |
| `prelude_error_supertype_must_be_error_reject` | reject | TypeError | §19.5 (the only permitted user supertype is the built-in Error) |
| `prelude_expired_not_error` | accept | — | §9 (Expired and a lost send are NOT Error subtypes; a `when (Error e)` does not fire for an Expired tombstone) |
| `prelude_say_not_ledger` | accept | — | §9 (`say(x)` prints its argument; it is NOT a ledger operation and appends no event) |
| `prelude_user_error_subtype_caught` | accept | — | §19.5 (event Foo : Error extends the built-in Error root; when(Error e) catches it) |
| `prelude_when_error_catches_contradiction` | accept | — | §9 (Contradiction extends Error; when (Error e) catches it by subtype) |

## 10_memory

| id | expect | error | spec |
|---|---|---|---|
| `mem_expr_query_no_ledger_event` | accept | — | §10 (query expression form yields a value and appends no QueryResult event) |
| `mem_forget_accept` | accept | — | §10 (`forget` drops a memory handle — an audit-preserving tombstone) |
| `mem_forget_records_tombstone` | accept | — | §10 (forget appends an audit-preserving Forgotten tombstone event) |
| `mem_ledger_recall_reject` | reject | TypeError | §10 (the ledger is not private memory; `->` recall requires a `mem` handle, never `ledger`) |
| `mem_recall_after_forget_reject` | reject | TypeError | §10 (forget consumes the mem handle; the region is unrecallable going forward) |
| `mem_recall_requires_mem_reject` | reject | TypeError | §10 (`->` recall requires a `mem` handle on the left; a non-`mem` LHS is a TypeError) |
| `mem_recall_taint_perform_reject` | reject | TaintViolation | §10, §13, §16.7 (a value recalled from private memory is subjective/graded and cannot drive a consequential sink without a gate) |
| `mem_select_boolean_ops_ok` | accept | — | §10 (select where conditions support comparison operators combined by boolean connectives) |
| `mem_store_internalizes_ok` | accept | — | §10 (the memory write seam mem <- value is the explicit emphasis form of internalization, on top of the mandatory memory envelope that internalizes every reaction, §16.7) |
| `mem_store_records_internalized` | accept | — | §10, §15.4.2 (a mem write internalizes the value across the region views and records Internalized) |
| `mem_write_recall_accept` | accept | — | §10 (a `mem` handle into private memory: write with `<-`, recall with `->`) |

## 11_control

| id | expect | error | spec |
|---|---|---|---|
| `ctrl_credence_in_if_reject` | reject | TypeError | §3, §11 (a Credence<bool> is not a bool; a bare Credence in an if is a TypeError — gate it first) |
| `ctrl_gate_abstain_ok` | accept | — | §11, §13 (the `abstained` sentinel is the else case when the gate commits no variant) |
| `ctrl_gate_all_variants_ok` | accept | — | §11, §13 (branch on a Decision's .committed with an if-chain over the enum variants) |
| `ctrl_if_else` | accept | — | §11 (if/else over a bool) |
| `ctrl_ungated_credence_committed_reject` | reject | TypeError | §3, §11 (a Credence<E> is consumed only by a gate/combinator; testing `.committed` before a gate is a TypeError) |

## 12_aggregation

| id | expect | error | spec |
|---|---|---|---|
| `agg_dependent_fuse_ok` | accept | — | §12 (a `dependent` declaration fuses conservatively; quorum(1, …) is the at-least-one reduction) |
| `agg_mixed_clusters_fuse` | accept | — | §12 (mixed sets compose: each `dependent` cluster fuses conservatively first, then the cluster results combine by the independent rule; coverage must be total over every pair) |
| `agg_partial_dep_coverage_reject` | reject | TypeError | §12 (dependence coverage must be TOTAL over every pair; declaring only the pair (c1,c2) leaves (c1,c3) and (c2,c3) uncovered → TypeError, even though one declaration is present) |
| `agg_quorum_independent_ok` | accept | — | §12 (quorum over independent Credence<bool> judges fuses to one Credence<bool>) |
| `agg_quorum_no_dep_decl_reject` | reject | TypeError | §12 (fusion — incl. quorum — requires a total independent/dependent declaration) |

## 13_governance

| id | expect | error | spec |
|---|---|---|---|
| `gov_bare_decision_no_perform_reject` | reject | TaintViolation | §13 (a sealed Decision<E> alone does not settle a subject; performing the raw artifact without an `endorse` is a taint violation) |
| `gov_conformal_coldstart_abstains` | accept | — | §13 (a conformal gate with no recorded decisions is below its labelled-case readiness floor and records a Decided abstention — the supervised cold start) |
| `gov_conformal_gate_ok` | accept | — | §13 (the conformal basis `by conformal α` is a distribution-free finite-sample gate calibrated from the ledger) |
| `gov_consequential_bare_collapse_reject` | reject | TaintViolation | §13 (a sealed Decision may guide control flow but is not a subject endorsement → it may not license a perform) |
| `gov_endorse_abstain_ok` | accept | — | §13 (the else branch runs when the gate abstains; no Endorsement is constructed for abstinence) |
| `gov_endorse_abstain_sink_reject` | reject | TypeError | §13, §15.3.3 (abstinence is a Decision outcome, not an Endorsement; endorse requires a committed-narrowed Decision) |
| `gov_endorse_artifact_allows_perform` | accept | — | §13 (a generated artifact is settled by endorsing it; the endorsement is sink-admissible only in a committed branch) |
| `gov_endorse_records_endorsed_ok` | accept | — | §9, §13 (decide records Decided, and endorse records an Endorsed event tied to that decision_id) |
| `gov_endorse_subject_scope_reject` | reject | GateError | §13 (an endorsed subject must be in the decision's dependency scope; a decision about one subject cannot endorse another) |
| `gov_endorsed_perform_ok` | accept | — | §13 (a recorded subject endorsement licenses a consequential perform in its committed branch) |
| `gov_endorsed_subject_allows_perform` | accept | — | §13 (endorsing the exact subject settles it; the endorsement is sink-admissible inside a committed branch, licensing a perform) |
| `gov_endorsement_subject_collision_accept` | accept | — | §13 (Endorsement metadata accessors win name collisions; the subject field remains reachable through `.subject`) |
| `gov_extend_use_subtractive_reject` | reject | AuthorityViolation | §5, §13 (capabilities, incl. `use`, are subtractive under extend) |
| `gov_grants_star_ok` | accept | — | §13 (grants { * } is the explicit unconstrained opt-out — lattice top) |
| `gov_margin_floor_abstains` | accept | — | §13 (a rule's `margin δ` requires the top-vs-runner-up lead ≥ δ at decision time; a 0.10 lead below the 0.20 margin records a Decided abstention, so no Endorsed is recorded) |
| `gov_perform_reach_subtractive_reject` | reject | AuthorityViolation | §5, §13 (grants are subtractive under extend for `perform`/`reach` too — a child may not exceed its parent's authority) |
| `gov_perform_ungranted_reject` | reject | AuthorityViolation | §13 (default-deny: an agent may only perform actions in its grants) |
| `gov_principal_decision_deny_fails` | accept | — | §13 (when the principal declines, `p decide c by r` records FailedPrincipalDecision and a Decided abstention) |
| `gov_principal_decision_ok` | accept | — | §13 (`p decide c by r` reaches identity when the rule cannot commit, records PrincipalDecision, records Decided, then may endorse the subject) |
| `gov_principal_decision_records` | accept | — | §13, §16.4 (a granted `p decide c by r` records PrincipalDecision, then the canonical Decided outcome) |
| `gov_raw_subject_to_sink_reject` | reject | TaintViolation | §13 (endorse never settles the raw subject variable; only the endorsement binder reaches a sink — performing the raw subject is rejected, in any branch) |
| `gov_reach_ungranted_reject` | reject | AuthorityViolation | §13 (sending into another agent requires a `reach` grant) |
| `gov_read_tool_settled_perform_ok` | accept | — | §6b, §13 (a read tool over settled inputs yields a settled result — external data settled by origin — that may drive a perform) |
| `gov_tool_requires_effect_class_reject` | reject | ParseError | §6b, §15.2 (every tool declares an effect class — `read` or `write`; omitting it is a ParseError) |
| `gov_tool_result_tainted_perform_reject` | reject | TaintViolation | §6b, §13 (a tool result carries the join of its inputs' trust; a cognition-derived input is un-settled → cannot drive a consequential perform without a gate) |
| `gov_use_tool_granted_ok` | accept | — | §6b, §13 (a granted `use TOOL` permits the tool call) |
| `gov_use_tool_ungranted_reject` | reject | AuthorityViolation | §6b, §13 (default-deny: a tool call needs a `use` grant) |
| `gov_write_tool_replay_chain_head` | accept | — | §16.5 (recorded replay of a write tool regenerates the same chain-head from journaled tool results) |
| `gov_write_tool_settled_ok` | accept | — | §6b, §13 (a write tool called with settled inputs is permitted) |
| `gov_write_tool_unsettled_reject` | reject | TaintViolation | §6b, §13 (a write tool is a consequential sink; a cognition-derived input is un-settled → reject) |

## 15_reproducibility

| id | expect | error | spec |
|---|---|---|---|
| `repro_chain_head_equal` | accept | — | §15.4.2, §15.5 / T4 (a recorded run replays to an identical chain-head: every oracle result is re-served from the journal in order and nothing is re-invoked) |
| `repro_decision_records_decided` | accept | — | §13, §15 (`decide c by R` records a Decided ledger event while remaining sync/no dependency reach) |

## 16_config

| id | expect | error | spec |
|---|---|---|---|
| `cfg_internalize_is_mandatory` | accept | — | §16.7 (the mandatory memory envelope internalizes every reaction's experience; consult+internalize is unconditional — there is no opt-in/opt-out config knob, and configuration tunes budget/fidelity, not whether memory is part of the turn) |
| `cfg_manifest_decision_policy_reject` | reject | ConfigError | §17.1, §17.2 (decision rules live in source, not the manifest; config cannot set gate thresholds) |
| `cfg_missing_principal_binding_reject` | reject | ConfigError | §17.1 (each principal declaration resolves to an identity binding; an unbound declared dependency is ALWAYS a ConfigError, not a late runtime lookup — no opt-in flag) |
| `cfg_missing_prompt_binding_reject` | reject | ConfigError | §17.1 (each prompt declaration resolves to a manifest binding; an unbound declared dependency is ALWAYS a ConfigError, not a late runtime lookup — no opt-in flag) |
| `cfg_missing_tool_binding_reject` | reject | ConfigError | §17.1 (each tool declaration resolves to a configured world capability; an unbound declared dependency is ALWAYS a ConfigError, not a late runtime lookup — no opt-in flag) |
| `cfg_require_fallback_temperature_reject` | reject | ConfigError | §17 (a text-only provider at temperature 0 requires fallback_temperature for the sampling fallback) |
| `cfg_sampling_fallback` | accept | — | §16.8, §17 (a text-only provider is served by the sampling fallback: the credence is the empirical frequency of N forced draws; a confident judgment still commits) |
| `cfg_sampling_fallback_disabled_defers` | accept | — | §13, §17 (without logprobs or the sampling fallback, a conformal gate has no distribution and degrades to deferral/abstain) |
| `cfg_strict_bindings_ok` | accept | — | §17.1 (declared dependencies pass configuration binding when every dependency has a manifest entry) |

## 22_gate

| id | expect | error | spec |
|---|---|---|---|
| `gate_cold_consequential_defers_to_principal` | accept | — | §13 (a cold consequential path reaches a principal before the action commits; the principal's ruling is the first label) |
| `gate_consequential_no_principal_reject` | reject | GateError | §13 (a consequential endorsement path with no principal escalation and no mature profile is a compile error — autonomy is earned, deference is required) |
| `gate_decide_principal_subject_accept` | accept | — | §13 (`p decide c by r` uses a principal escalation prefix; the endorsed subject reaches the sink in the committed branch) |
| `gate_decision_field_readonly_reject` | reject | TypeError | §13 (Decision provenance fields are read-only) |
| `gate_decision_introspection_accept` | accept | — | §13, §9 (Decision provenance: .basis over the Basis enum) |
| `gate_decision_introspection_committed_margin_accept` | accept | — | §13 (Decision provenance exposes .committed and .margin, not only .basis) |
| `gate_decision_not_endorsement_reject` | reject | TypeError | §13 (`decide c by R` yields a Decision<E>, not an Endorsement<E>) |
| `gate_deference_in_else_accept` | accept | — | §13 (deference is an ordinary principal-prefixed `decide` in the else branch when the autonomous gate abstains) |
| `gate_endorsement_expr_type_accept` | accept | — | §13 (endorse yields an Endorsement<T>, the recorded settled form of a gate decision) |
| `gate_endorsement_field_readonly_reject` | reject | TypeError | §13 (Endorsement provenance fields are read-only) |
| `gate_endorsement_introspection_accept` | accept | — | §13 (Endorsement exposes the same read-only provenance fields as Decision) |
| `gate_endorsement_not_decision_reject` | reject | TypeError | §13 (an Endorsement<E> is not a Decision<E>) |
| `gate_file_conformal_decl_accept` | accept | — | §13, §15.2 (a file-level `conformal α;` declaration sets the default conformal level) |
| `gate_per_gate_conformal_accept` | accept | — | §13 (a per-gate conformal α on a decide expression, distinct from the file default) |
