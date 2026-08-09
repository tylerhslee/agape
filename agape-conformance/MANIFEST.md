# Agape v1.0.0-beta.2026.8.6.0 — Conformance Test Index

**259 tests** — accept: 154, reject: 105

A conformant implementation must satisfy every `accept`/`reject` test (rejects with the declared error class; accepts matching any asserted spine).


## 00_lexical

| id | expect | error | spec |
|---|---|---|---|
| `lex_comment_fstring` | accept | — | §2 (line comments; f-string interpolation; INT/FLOAT literals) |
| `lex_contextual_word_as_identifier` | accept | — | §2 (contextual words `as`/`by`/`reach`/`origin` lex as identifiers out of position) |
| `lex_reject_fstring_escaped_brace` | reject | LexError | §2 (f-string escapes are \n \t \" \\ and \${; plain braces are already literal, so \{ is an invalid escape) |
| `lex_reject_keyword_as_identifier` | reject | ParseError | §2 (reserved keywords may not be used as identifiers) |
| `lex_reject_leading_dot_number` | reject | ParseError | §2 (Float is decimal digits with a point; `.5` is not a numeric literal) |
| `lex_reject_malformed_fstring` | reject | LexError | §2 (an f-string ${ interpolation must be closed by } before the string ends) |
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
| `axes_pure_call_settled` | accept | — | §1 Axis A/B (a pure `pure` fn reaches no dependency and stays `settled`) |
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
| `type_undeclared_function_call_reject` | reject | TypeError | §4, §8 (a bare call to an undeclared name is a TypeError — functions, like events, are not self-declaring) |
| `type_undeclared_perform_reject` | reject | TypeError | §3 (actions are not self-declaring; perform of an undeclared type is a TypeError) |

## 04_functions

| id | expect | error | spec |
|---|---|---|---|
| `fn_local_memory_descriptor_reject` | reject | ParseError | §9, §10, §15.2 (a qualified memory descriptor is structural agent state and cannot be declared inside a function) |
| `fn_pure_calls_async_reject` | reject | ColorViolation | §4 (a pure fn may only call other pure fns) |
| `fn_pure_decide_by_principal_reject` | reject | ColorViolation | §4, §13 (`decide c by p` for a principal reaches the identity dependency → async; a pure fn may not) |
| `fn_pure_emit_ok` | accept | — | §4 (emit is a ledger append, permitted in pure; a plain event needs no power) |
| `fn_pure_inhand_decide_ok` | accept | — | §4, §13 (a rule-driven `decide` over an in-hand Credence is a pure collapse, no dependency reach → pure-permitted) |
| `fn_pure_local_ok` | accept | — | §4 (a pure fn that reaches no declared dependency is well-formed) |
| `fn_pure_reaches_seam_reject` | reject | ColorViolation | §1 Axis A, §4 (a pure fn may not reach the provider via `<-`) |
| `fn_reject_nonterminal_return` | reject | TypeError | §4 (`return` is honored in tail position only — the final statement of a function body; a `return` nested in an `if` is never evaluated and would be silently ignored, so it is a static error, not a runtime no-op) |
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
| `agent_prompt_ingress_to_provider_deny` | reject | TaintViolation | §5b, §17 (deny-mode provider-prompt ingress policy rejects unscreened prompt ingress before it reaches cognition) |
| `agent_prompt_ingress_to_provider_warn` | accept | — | §5b, §17 (default provider-prompt ingress policy warns when judgment-settled but unscreened prompt ingress is interpolated into cognition) |
| `agent_prompt_opens_sensor` | accept | — | §5b (a `prompt` declaration opens a standing external input sensor) |
| `agent_prompt_screened_ingress_to_provider_ok` | accept | — | §5b, §17 (a manifest-screened prompt ingress value is external_screened, so it may feed cognition without warning even under deny mode) |
| `agent_prompt_value_drives_perform_ok` | accept | — | §5b, §13 (a prompt value is judgment-settled external ingress and may drive a perform) |
| `agent_reawake_no_reconstruct` | accept | — | §5 (re-awake resumes the agent: no re-bind, no re-construct) |
| `agent_sleep_runs_hook` | accept | — | §5 (sleep closes the mailbox and runs the on-sleep hook) |
| `agent_spawn_instantiate_only` | accept | — | §5 (spawn instantiates + constructs only: no mailbox, no awake hook) |
| `when_reaction_crash_contained` | accept | — | §16.6 (the reaction boundary: a `when`-body firing is a handler invocation just like `on awake`; an uncaught fault is CONTAINED — AgentCrashed is recorded and the on-crash hook runs with state intact — never propagated out of the run) |

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

## 06b_world

| id | expect | error | spec |
|---|---|---|---|
| `world_emit_wired_result_taint_join_reject` | reject | TaintViolation | §6b, §13 (no laundering: a result_event payload carries the JOIN of the triggering emit's payload trust — a raw query taints its own results, which then cannot drive a consequential perform un-gated) |
| `world_emit_wired_tainted_ok` | accept | — | §6b (emit is not a consequential sink, so an emit-trigger wiring is the loose observation channel: a RAW payload may flow out — an explicit, manifest-visible opt-out of the perform path's guarantee) |
| `world_foreground_action_authorized_accept` | accept | — | §6b, §13 (a result-bound perform records its authorization receipt before invoking the wired effector) |
| `world_foreground_binding_no_result_event_reject` | reject | ConfigError | §6b, §17.1 (a foreground binding on an action wired with no result_event is a ConfigError — there is nothing to bind the reply to) |
| `world_foreground_binding_requires_expires_reject` | reject | TypeError | §6b, §6c (`expires` is mandatory on the result-binding form of perform — terminal by construction, like every delegation) |
| `world_foreground_perform_binding_ok` | accept | — | §6b, §13 (foreground perform binding: a wired action with a result_event binds its reply like a §6c delegation; a judgment-settled request yields judgment-settled external ingress, which may drive a further perform) |
| `world_perform_unsettled_reject` | reject | TaintViolation | §6b, §13 (every perform is a consequential sink taking settled args only — anti-exfiltration: un-endorsed cognition never leaves the process on the perform path) |
| `world_perform_unsettled_unwired_reject` | reject | TaintViolation | §6b, §13 (the settled-only rule for perform args is UNIFORM: it does not depend on whether the deployment wires the action — checker semantics never depend on the manifest) |
| `world_pure_perform_reject` | reject | ColorViolation | §4, §6b (every perform is async — whether an act reaches the world is a deployment fact the checker must not depend on; a `pure` function may not perform) |
| `world_replay_chain_head` | accept | — | §6b, §16.5 (recorded replay of a wired perform regenerates the same chain-head: the seam's journal pair re-serves the endpoint result and nothing is re-invoked) |
| `world_result_event_ingress_to_provider_warn` | accept | — | §6b, §17 (default provider-prompt ingress policy warns when unscreened result-event ingress is interpolated into cognition) |
| `world_result_event_screened_ingress_to_provider_ok` | accept | — | §6b, §17 (a manifest-screened result-event ingress value is external_screened, so it may feed cognition without warning even under deny mode) |
| `world_unwired_action_pure_ok` | accept | — | §6b (unwired = pure: an unwired action is a ledgered performative — the act is the record; no seam journal pair appears) |
| `world_wired_perform_invokes_ok` | accept | — | §6b (an [actions.NAME] wiring makes perform invoke the catalog endpoint: the action's own domain row, then the seam's ToolStarted/ToolResolved journal pair correlated by catalog name) |
| `world_wired_perform_result_event_ok` | accept | — | §6b (a wiring's result_event lands the endpoint's reply as the named event row after the journal pair; a statement-form perform consumes it reactively via `when`) |

## 06c_delegation

| id | expect | error | spec |
|---|---|---|---|
| `del_background_expiry_alias` | accept | — | §6c (TaskExpired is a subscription ALIAS for Expired filtered to task-sends — no row of its own; a background expiry never faults the delegator) |
| `del_background_when_completed` | accept | — | §6c (a background task-send binds a settled Task<T> handle; the outcome is observed with `when (TaskCompleted … about h)`; delivery may span ticks — §6) |
| `del_cancel_after_terminal_noop` | accept | — | §6c, §16.3a (the first terminal wins: cancel of an already-terminal task appends nothing) |
| `del_cancel_non_handle_reject` | reject | TypeError | §6c, §15.3.3 (`cancel` takes a Task<T> handle) |
| `del_cancel_tombstone` | accept | — | §6c (cancel appends the authoritative TaskCancelled tombstone; the first terminal wins — a cancelled task neither delivers nor expires) |
| `del_complete_outside_task_reject` | reject | TypeError | §6c, §15.3.3 (`complete`/`fail` are legal only inside a task handler) |
| `del_empty_task_block_reject` | reject | TypeError | §6c (an empty task block is a compile error — objective and acceptance are required) |
| `del_endorsed_completion_settled_ok` | accept | — | §6c (a worker that completes with an Endorsement<T> hands over a settled, ledger-backed subject — the delegator may sink it directly) |
| `del_endorsed_scoped_perform_ok` | accept | — | §6c, §13 (the canonical scoped flow: draft task → decide → endorse in the committed branch → send Endorsement<TaskSpec> → the worker's statically-granted perform is task-enabled) |
| `del_expires_settled_expr_ok` | accept | — | §6, §6c (`expires` accepts any settled numeric expression, not only a literal) |
| `del_expires_unsettled_reject` | reject | TaintViolation | §6, §6c (`expires` requires a SETTLED numeric expression; a cognition-derived lifetime is rejected) |
| `del_expiry_faults_foreground` | accept | — | §6c, §16.6 (mandatory expiry converts a lost task-send into a signal: the Expired tombstone faults the awaiting foreground invocation) |
| `del_fanout_shared_worker_concurrent_ok` | accept | — | §6c + §12 — fan-out delegation composes with `|>`: a delegating function mapped over a finite collection to a SHARED worker runs its foreground tasks concurrently (paths overlap, §12), all complete, and the ledger replays identically (§0.2 determinism is serialized EFFECTS, not serialized execution — no shared mutable state to race over) |
| `del_fanout_spawn_expr_distinct_workers_ok` | accept | — | §6c + §12 + §15.4 — the `spawn` EXPRESSION (`Worker w = spawn Worker;`) mints a FRESH distinct worker per fan-out element, so `xs |> f` builds a dynamic collection of workers; each verifies one delegated task, and instance names are derived from (call-site, element index), not execution order, so the ledger replays byte-identically |
| `del_foreground_complete_ok` | accept | — | §6c (a foreground task-send: the worker's `complete` produces the transport Resolved plus TaskCompleted, and the delegator's continuation resumes with the result) |
| `del_foreground_failure_faults` | accept | — | §6c, §16.6 (a foreground task terminal other than TaskCompleted faults the delegator's awaiting invocation via the contained-crash path; `on crash` recovers with state intact) |
| `del_missing_expires_reject` | reject | TypeError | §6c (`expires` is mandatory on every delegation — every task is terminal by construction) |
| `del_no_assigned_handler_expires` | accept | — | §6c (an assigned task with no completing handler is not an error; the mandatory expiry backstops it with a tombstone) |
| `del_objective_missing_reject` | reject | TypeError | §6c (a task literal requires BOTH `objective` and `acceptance`) |
| `del_objective_not_text_reject` | reject | TypeError | §6c (`objective` and `acceptance` must be `text`) |
| `del_perform_unscoped_task_faults` | accept | — | §6c, §13, §16.6 (a perform inside an assigned task requires the active task to be endorsed AND to name the action in scope; a plain task enables nothing — the action faults with TaskScopeViolation and does not run) |
| `del_progress_outside_task_reject` | reject | TypeError | §6c (TaskProgress is emittable only inside a task handler — it correlates to the active task) |
| `del_progress_then_cancelled_hook` | accept | — | §6c (TaskProgress is the repeatable worker event; cancel mid-task is cooperative — the worker's `on cancelled` hook fires, nothing is preempted) |
| `del_reach_required_reject` | reject | AuthorityViolation | §6c, §13 (delegation is a send: reaching a worker requires the `reach` power, default-deny) |
| `del_result_raw_to_sink_reject` | reject | TaintViolation | §6c, §13 (a delegated result is RAW by default — delegation never launders trust; it cannot drive a consequential sink un-gated) |
| `del_scope_not_held_reject` | reject | AuthorityViolation | §6c, §15.3.3 W-Scope-Attenuate (a task scope can only ATTENUATE the delegator's authority — each scoped action must be held by the delegator itself) |
| `del_scope_unendorsed_send_reject` | reject | TaintViolation | §6c, §15.3.3 W-Scope-Attenuate (a task carrying a `scope` clause is enabling only when endorsed; sending an unendorsed scoped task is rejected) |
| `del_tainted_objective_ok` | accept | — | §6c (a generated objective stays tainted but an UNSCOPED task may still be sent — taint matters at sinks, and a plain task grants nothing) |
| `del_taskspec_draft_binding_ok` | accept | — | §6c (a task literal is an expression: a TaskSpec draft may be bound first and sent later; expires stays mandatory at the send) |
| `del_unbound_statement_reject` | reject | TypeError | §6c (bare statement-form delegation is a compile error — hold the result or the Task<T> handle; every task is addressable) |
| `del_worker_fail_records` | accept | — | §6c (`fail reason` appends TaskFailed; the transport chain rests at its Delivered prefix — a stalled prefix is not a violation; a background delegator observes it with `when`) |

## 07_ledger

| id | expect | error | spec |
|---|---|---|---|
| `ledger_exact_spine` | accept | — | §7, §16.2 (ledger assertions can pin the exact ordered event spine, with no extra events) |
| `ledger_multi_handler_order` | accept | — | §7 (when several subscriptions match one appended event in one tick, they fire in registration/hoist order — within a scope, lexical order) |
| `ledger_prospective_only` | accept | — | §7 (subscriptions are prospective; never fire for prior events) |
| `ledger_query_result_event` | accept | — | §10 (a query STATEMENT lands a QueryResult event on the ledger) |
| `ledger_tool_pair` | accept | — | §6b, §7 (a wired perform appends the seam's ToolStarted/ToolResolved journal pair beneath the action's domain row, correlated by catalog name) |
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
| `sem_schema_violation_array_typemismatch` | accept | — | §8, §16.6 (array<T> compiles to schema-constrained output; a schema failure faults the send with TypeMismatch, then the reaction crashes) |
| `sem_schema_violation_enum_typemismatch` | accept | — | §8, §16.6 (Enum compiles to a closed enum schema; a schema failure faults the send with TypeMismatch, then the reaction crashes) |
| `sem_schema_violation_faults_send_on_crash` | accept | — | §8, §16.6 (a typed reply that fails its schema faults AT the send: TypeMismatch then the reaction crashes, so the downstream field access never runs and no null enters the binding; `on crash` recovers with state intact) |
| `sem_schema_violation_typemismatch` | accept | — | §8, §16.6 (structured output uses constrained decoding; on schema failure the runtime appends a TypeMismatch and faults the send — the reaction crashes, no null enters the binding) |

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
| `mem_authority_payload_reject` | reject | TypeError | §10 (an Endorsement wrapper is authority-bearing and cannot be a persistent memory payload type) |
| `mem_clause_order_accept` | accept | — | §10, §15.3 (descriptor clause order is insignificant) |
| `mem_descriptor_typed_store_recall_accept` | accept | — | §10, §15.3 (the descriptor type governs both exact stores and TYPE[] recall) |
| `mem_duplicate_clause_reject` | reject | TypeError | §10, §15.3 (a descriptor clause may appear only once) |
| `mem_duplicate_name_reject` | reject | TypeError | §10, §15.3 (one structural descriptor is permitted per handle name in an agent) |
| `mem_duplicate_scope_reject` | reject | TypeError | §10 (a scope dimension may appear only once in the descriptor tuple) |
| `mem_empty_typed_recall_accept` | accept | — | §10 (recall against an empty typed region is well-typed, records consultation, and invokes no provider) |
| `mem_episodic_equal_writes_receipts_accept` | accept | — | §10, §16.7 (each explicit episodic store evaluation records its own successful Internalized receipt) |
| `mem_event_binder_member_store_accept` | accept | — | §3, §5, §7, §10, §15.3 (a typed event-binder member retains its exact type at a mem store) |
| `mem_event_binder_member_store_mismatch_reject` | reject | TypeError | §3, §5, §7, §10, §15.3 (a typed event-binder member must match the mem payload type) |
| `mem_expr_query_no_ledger_event` | accept | — | §10 (query expression form yields a value and appends no QueryResult event) |
| `mem_forget_accept` | accept | — | §10 (forget closes only the current scope tuple generation while the structural descriptor survives) |
| `mem_forget_records_tombstone` | accept | — | §10 (forget appends a truthful Forgotten receipt for the resolved tuple generation) |
| `mem_forget_reopen_operations_accept` | accept | — | §10, §16.7 (the structural descriptor remains usable for recall and a later store after forget) |
| `mem_generic_syntax_reject` | reject | ParseError | §10, §15.2 (mem<T> is not Agape syntax; payload type is a named descriptor clause) |
| `mem_inherited_descriptor_access_accept` | accept | — | §5, §10, §15.3 (a child inherits its parent's structural mem handles) |
| `mem_inherited_descriptor_redeclaration_reject` | reject | TypeError | §5, §10, §15.3 (an inherited structural mem handle cannot be redeclared by the child) |
| `mem_ledger_recall_reject` | reject | TypeError | §10 (the ledger is not private memory; `->` recall requires a `mem` handle, never `ledger`) |
| `mem_legacy_direct_reject` | reject | TypeError | §10 (legacy unqualified declarations receive the qualified-descriptor migration diagnostic) |
| `mem_legacy_local_initialized_reject` | reject | TypeError | §10 (legacy handler-local initialized declarations receive the hoist-and-qualify migration diagnostic) |
| `mem_local_descriptor_reject` | reject | ParseError | §10, §15.2 (a qualified descriptor is a direct agent-body declaration, never handler-local) |
| `mem_local_shadow_not_store_reject` | reject | TypeError | §3, §10, §15.3 (arrow disambiguation follows the nearest binding's type, not a shadowed mem handle) |
| `mem_missing_clause_reject` | reject | TypeError | §10, §15.3 (type, modality, scope, and retention are each required exactly once) |
| `mem_modalities_names_no_magic_accept` | accept | — | §10 (opaque, episodic, and semantic are declared policies; handle names have no intrinsic semantics) |
| `mem_recall_after_forget_empty` | accept | — | §10 (a descriptor survives forget and recall of its closed tuple returns an empty typed array) |
| `mem_recall_later_scalar_assignment_reject` | reject | TypeError | §3, §10, §15.3 (recall has TYPE[] independently of assignment position) |
| `mem_recall_non_text_query_reject` | reject | TypeError | §10, §15.3 (the recall query operand is text) |
| `mem_recall_requires_mem_reject` | reject | TypeError | §10 (`->` recall requires a `mem` handle on the left; a non-`mem` LHS is a TypeError) |
| `mem_recall_scalar_action_argument_reject` | reject | TypeError | §3, §6b, §10, §15.3 (TYPE[] recall is not assignable to a scalar action parameter) |
| `mem_recall_scalar_event_argument_reject` | reject | TypeError | §3, §7, §10, §15.3 (TYPE[] recall is not assignable to a scalar event parameter) |
| `mem_recall_taint_perform_reject` | reject | TaintViolation | §10, §13, §16.7 (the exact typed recall array is deeply raw and cannot drive a consequential sink without a gate) |
| `mem_recall_undeclared_handle_reject` | reject | TypeError | §10, §15.3 (`->` recall requires an established mem handle on the left) |
| `mem_recall_wrong_binding_reject` | reject | TypeError | §10, §15.3 (typed recall returns TYPE[] and cannot bind directly to text or Credence) |
| `mem_select_boolean_ops_ok` | accept | — | §10 (select where conditions support comparison operators combined by boolean connectives) |
| `mem_store_function_result_type_mismatch_reject` | reject | TypeError | §4, §10, §15.3 (a function result stored through a mem handle must be assignable to its payload type) |
| `mem_store_internalizes_ok` | accept | — | §10 (an explicit write stores a value assignable to the structural descriptor type) |
| `mem_store_records_internalized` | accept | — | §10, §15.4.2 (a successful explicit typed write records Internalized) |
| `mem_store_struct_field_type_mismatch_reject` | reject | TypeError | §3, §10, §15.3 (struct field expressions and stored values must satisfy their declared types) |
| `mem_store_type_mismatch_reject` | reject | TypeError | §10, §15.3 (every stored expression must be assignable to the descriptor payload type) |
| `mem_top_level_descriptor_reject` | reject | ParseError | §10, §15.2 (a qualified descriptor is structural agent state and is not a top-level declaration) |
| `mem_unknown_modality_reject` | reject | TypeError | §10 (the closed modality vocabulary is opaque, episodic, and semantic; working state is not memory) |
| `mem_unknown_retention_reject` | reject | TypeError | §10 (the closed retention vocabulary is session and durable) |
| `mem_unknown_scope_reject` | reject | TypeError | §10 (the closed authenticated scope vocabulary is project and user) |
| `mem_user_scope_missing_subject_crashes` | accept | — | §10, §16.7 (a user-scoped operation without κ.user follows the auditable crash path without a successful memory mutation) |
| `mem_write_recall_accept` | accept | — | §10 (a qualified typed handle stores with <- and recalls a deeply raw TYPE[] with ->) |

## 11_control

| id | expect | error | spec |
|---|---|---|---|
| `ctrl_credence_in_if_reject` | reject | TypeError | §3, §11 (a Credence<bool> is not a bool; a bare Credence in an if is a TypeError — gate it first) |
| `ctrl_gate_abstain_ok` | accept | — | §11, §13 (the `abstained` sentinel is the else case when the gate commits no variant) |
| `ctrl_gate_all_variants_ok` | accept | — | §11, §13 (branch on a Decision's .committed with an if-chain over the enum variants) |
| `ctrl_if_else` | accept | — | §11 (if/else over a bool) |
| `ctrl_retry_exhausts_faults` | accept | — | §11, §16.6 (a persistent TypeMismatch exhausts the `retry N` block: after N attempts the runtime appends RetryExhausted and faults per the send-fault rule — the reaction crashes and `on crash` recovers) |
| `ctrl_retry_first_attempt_ok` | accept | — | §11 (a `retry N` block parses and runs in the core kernel; when the block's first attempt does not fault, it runs exactly once and no RetryExhausted is recorded) |
| `ctrl_retry_recovers_typemismatch` | accept | — | §11, §16.6 (a bounded `retry N` block is core: on a TypeMismatch it re-asks the provider, re-running the block; a transient schema failure recovers on the next attempt and the first attempt's TypeMismatch stays on the ledger) |
| `ctrl_ungated_credence_committed_reject` | reject | TypeError | §3, §11 (a Credence<E> is consumed only by a gate/combinator; testing `.committed` before a gate is a TypeError) |

## 12_aggregation

| id | expect | error | spec |
|---|---|---|---|
| `agg_dependent_fuse_ok` | accept | — | §12 (a `dependent` declaration fuses conservatively; quorum(1, …) is the at-least-one reduction) |
| `agg_mixed_clusters_fuse` | accept | — | §12 (mixed sets compose: each `dependent` cluster fuses conservatively first, then the cluster results combine by the independent rule; coverage must be total over every pair) |
| `agg_partial_dep_coverage_reject` | reject | TypeError | §12 (dependence coverage must be TOTAL over every pair; declaring only the pair (c1,c2) leaves (c1,c3) and (c2,c3) uncovered → TypeError, even though one declaration is present) |
| `agg_pipe_fanout_ok` | accept | — | §12, §15.2 (`xs |> f` is bounded fan-out over a finite collection) |
| `agg_quorum_independent_ok` | accept | — | §12 (quorum over independent Credence<bool> judges fuses to one Credence<bool>) |
| `agg_quorum_no_dep_decl_reject` | reject | TypeError | §12 (fusion — incl. quorum — requires a total independent/dependent declaration) |

## 13_governance

| id | expect | error | spec |
|---|---|---|---|
| `gov_action_authorized_projection_accept` | accept | — | §13, §14 (a consequential action records one authorization receipt per exact endorsed or structurally projected argument) |
| `gov_attester_unverified_accepted` | accept | — | §13, §17.1 (the default `none` attester authenticator is ACCEPTED, not rejected: the ruling's attester is taken on trust and recorded — marked unverified in the PrincipalDecision attestation — so a fresh local-dev gate still defers, rules, and resumes without a bound authenticator) |
| `gov_attester_verified_resumes` | accept | — | §13, §17.7 (a host authenticator is bound; the attested ruling's verified identity resolves to the deferred principal, so the attester-match passes, PrincipalDecision is recorded, and the reaction resumes through endorse to the sink) |
| `gov_attester_wrong_principal_rejected` | accept | — | §13, §16.4 (a host authenticator is bound; the attested ruling's verified identity resolves to a DIFFERENT principal than the gate deferred to, so the attester-match rejects the ruling — FailedPrincipalDecision, the decision stays abstained, fail-closed, and no subject reaches the sink) |
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
| `gov_grants_star_ok` | accept | — | §13 (grants { * } is the explicit unconstrained opt-out — lattice top) |
| `gov_margin_floor_abstains` | accept | — | §13 (a rule's `margin δ` requires the top-vs-runner-up lead ≥ δ at decision time; a 0.10 lead below the 0.20 margin records a Decided abstention, so no Endorsed is recorded) |
| `gov_pending_principal_decision_records` | accept | — | §13 (a principal-prefixed `p decide c by r` that cannot commit DEFERS: it appends a durable PendingPrincipalDecision receipt before the attested ruling resolves it to PrincipalDecision, then the canonical Decided) |
| `gov_perform_reach_subtractive_reject` | reject | AuthorityViolation | §5, §13 (grants are subtractive under extend for `perform`/`reach` too — a child may not exceed its parent's authority) |
| `gov_perform_ungranted_reject` | reject | AuthorityViolation | §13 (default-deny: an agent may only perform actions in its grants) |
| `gov_principal_decision_deny_fails` | accept | — | §13 (when the principal declines, `p decide c by r` records FailedPrincipalDecision and a Decided abstention) |
| `gov_principal_decision_ok` | accept | — | §13 (`p decide c by r` reaches identity when the rule cannot commit, records PrincipalDecision, records Decided, then may endorse the subject) |
| `gov_principal_decision_records` | accept | — | §13, §16.4 (a granted `p decide c by r` records PrincipalDecision, then the canonical Decided outcome) |
| `gov_principal_request_portable_accept` | accept | — | §13 (principal_request is the portable request commitment on principal decisions and endorsements) |
| `gov_raw_subject_to_sink_reject` | reject | TaintViolation | §13 (endorse never settles the raw subject variable; only the endorsement binder reaches a sink — performing the raw subject is rejected, in any branch) |
| `gov_reach_ungranted_reject` | reject | AuthorityViolation | §13 (sending into another agent requires a `reach` grant) |
| `gov_transformed_endorsement_no_action_receipt` | accept | — | §13, §14 (arithmetic over an endorsed structural projection is settled but does not retain authorization lineage) |
| `gov_unrelated_endorsement_no_action_receipt` | accept | — | §13, §14 (an unrelated earlier endorsement never certifies a literal-only consequential action) |

## 15_reproducibility

| id | expect | error | spec |
|---|---|---|---|
| `repro_chain_head_equal` | accept | — | §15.4.2, §15.5 / T4 (a recorded run replays to an identical chain-head: every oracle result is re-served from the journal in order and nothing is re-invoked) |
| `repro_decision_records_decided` | accept | — | §13, §15 (`decide c by R` records a Decided ledger event while remaining pure/no dependency reach) |

## 16_config

| id | expect | error | spec |
|---|---|---|---|
| `cfg_manifest_decision_policy_reject` | reject | ConfigError | §17.1, §17.2 (decision rules live in source, not the manifest; config cannot set gate thresholds) |
| `cfg_memory_durable_local_reject` | reject | ConfigError | §10, §16.7, §17.1 (local/mock advertises session retention only and rejects a durable descriptor before execution) |
| `cfg_memory_markdown_mixed_retention_accept` | accept | — | §10, §16.7, §17.1 (markdown advertises both durable exact storage and an in-process session tier) |
| `cfg_missing_principal_binding_reject` | reject | ConfigError | §17.1 (each principal declaration resolves to an identity binding; an unbound declared dependency is ALWAYS a ConfigError, not a late runtime lookup — no opt-in flag) |
| `cfg_missing_prompt_binding_reject` | reject | ConfigError | §17.1 (each prompt declaration resolves to a manifest binding; an unbound declared dependency is ALWAYS a ConfigError, not a late runtime lookup — no opt-in flag) |
| `cfg_no_implicit_internalization` | accept | — | §10, §16.7 (an agent send does not implicitly consult or write private memory) |
| `cfg_reply_memory_is_explicit` | accept | — | §10, §16.7 (memory mutation is a source-authored operation on a declared mem region) |
| `cfg_require_fallback_temperature_reject` | reject | ConfigError | §17 (a text-only provider at temperature 0 requires fallback_temperature for the sampling fallback) |
| `cfg_sampling_fallback` | accept | — | §16.8, §17 (a text-only provider is served by the sampling fallback: the credence is the empirical frequency of N forced draws; a confident judgment still commits) |
| `cfg_sampling_fallback_disabled_defers` | accept | — | §13, §17 (without logprobs or the sampling fallback, a conformal gate has no distribution and degrades to deferral/abstain) |
| `cfg_strict_bindings_ok` | accept | — | §17.1 (declared dependencies pass configuration binding when every dependency has a manifest entry and every wiring references an existing catalog key and a declared name) |
| `cfg_tool_binding_missing_driver_reject` | reject | ConfigError | §17.1 (a [tools.*] catalog entry must name a driver; connector-specific fields are not enough) |
| `cfg_tool_host_binding_accept` | accept | — | §6b, §17.1 (a [tools.*] catalog entry can bind to implementation-defined host functions, scripts, processes, or skills; the wiring is unchanged) |
| `cfg_tool_mcp_binding_accept` | accept | — | §6b, §17.1 ([tools.*] is the endpoint catalog and MCP is one supported transport; an action wires to a catalog entry by its key) |
| `cfg_wiring_missing_catalog_key_reject` | reject | ConfigError | §6b, §17.1 (an [actions.NAME] wiring must reference an existing [tools.*] catalog entry; a missing catalog key is ALWAYS a ConfigError, not a late runtime lookup) |
| `cfg_wiring_undeclared_action_reject` | reject | ConfigError | §6b, §17.1 (an [actions.NAME]/[events.NAME] wiring must name a DECLARED action or event; wiring an undeclared name is a ConfigError) |

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
