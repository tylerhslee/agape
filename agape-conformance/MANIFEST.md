# Agape v1.0 — Conformance Test Index

**197 tests** — accept: 123, reject: 74

A conformant implementation must satisfy every `accept`/`reject` test (rejects with the declared error class; accepts matching any asserted spine).


## 00_lexical

| id | expect | error | spec |
|---|---|---|---|
| `lex_comment_fstring` | accept | — | §2 (line comments; f-string interpolation; INT/FLOAT literals) |
| `lex_contextual_word_as_identifier` | accept | — | §2 (contextual words `as`/`by`/`reach`/`use`/`origin` lex as identifiers out of position) |
| `lex_reject_keyword_as_identifier` | reject | ParseError | §2 (reserved keywords may not be used as identifiers) |
| `lex_reject_malformed_fstring` | reject | ParseError | §2 (f-string interpolation braces must parse as expressions) |
| `lex_reject_missing_semicolon` | reject | ParseError | §2 (statement terminator `;` is explicit and required) |
| `lex_reject_tilde` | reject | ParseError | §2 (there is no similarity operator; `~` lexes to an Op but the parser rejects it — a ParseError, not a LexError) |
| `lex_reject_unknown_operator` | reject | LexError | §2 (operators outside the specified surface are rejected) |
| `lex_string_escapes` | accept | — | §2 (string escapes \n \t \" \\ are recognized inside a string literal) |

## 01_axes

| id | expect | error | spec |
|---|---|---|---|
| `axes_collapse_is_decision` | accept | — | §13, §15.2 (`c by R` collapses a Credence to a Decision — settled, off-ledger, in hand) |
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
| `type_enum_decl_and_case` | accept | — | §3, §11 (enum declaration; a gated case exhaustive over all variants) |
| `type_event_decl` | accept | — | §3 (custom ledger-event declaration with a typed payload) |
| `type_event_multifield_arity_reject` | reject | TypeError | §3 (emit arity must match the declared event signature) |
| `type_event_multifield_payload_ok` | accept | — | §3 (event invocation uses positional fields in declaration order) |
| `type_event_multifield_type_reject` | reject | TypeError | §3 (emit arguments are type-checked positionally) |
| `type_event_null_no_reply` | accept | — | §3 (event<null> = sent, no typed reply bound) |
| `type_no_text_to_principal_reject` | reject | TypeError | §3, §13 (no text -> Principal coercion at an attest gate) |
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
| `fn_sync_attest_by_principal_reject` | reject | ColorViolation | §4, §13 (attest … by Principal reaches the identity dependency → async) |
| `fn_sync_calls_async_reject` | reject | ColorViolation | §4 (a sync fn may only call other sync fns) |
| `fn_sync_embed_reject` | reject | ColorViolation | §9, §10 (embed reaches the provider-backed memory substrate, so a sync function may not call it) |
| `fn_sync_emit_ok` | accept | — | §4 (emit is a ledger append, permitted in sync; a plain event needs no power) |
| `fn_sync_inhand_endorse_ok` | accept | — | §4, §13 (in-hand endorse = collapse + record, no dependency reach → sync-permitted) |
| `fn_sync_pure_ok` | accept | — | §4 (a sync fn that reaches no declared dependency is well-formed) |
| `fn_sync_reaches_seam_reject` | reject | ColorViolation | §1 Axis A, §4 (a sync fn may not reach the provider via `<-`) |
| `fn_sync_store_reject` | reject | ColorViolation | §9, §10 (store reaches the provider-backed memory substrate, so a sync function may not call it) |
| `fn_sync_tool_call_reject` | reject | ColorViolation | §4, §6b (a tool call reaches the tool dependency → async) |

## 05_agents

| id | expect | error | spec |
|---|---|---|---|
| `agent_crash_contained` | accept | — | §5 (an unrecoverable seam failure — the provider returns nothing — crashes the agent: AgentCrashed is recorded, the on-crash hook runs, and state survives; a crash is contained, not a death) |
| `agent_extend_inherits_when` | accept | — | §5, §7 (extend inherits fields + constructor + when blocks + hooks) |
| `agent_first_awake_runs_constructor` | accept | — | §5 (first awake opens the mailbox and runs the on-awake hook) |
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
| `comm_typed_reply` | accept | — | §6 (a typed reply binds the provider answer into event<T>) |

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
| `sem_schema_violation_array_typemismatch` | accept | — | §8 (event<array<T>> compiles to schema-constrained output; schema failure raises TypeMismatch) |
| `sem_schema_violation_enum_typemismatch` | accept | — | §8 (event<Enum> compiles to a closed enum schema; schema failure raises TypeMismatch) |
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
| `mem_embed_internalizes_ok` | accept | — | §9, §10 (embed(x) explicitly writes an embedding to memory and records Internalized) |
| `mem_expr_query_no_ledger_event` | accept | — | §10 (query expression form yields a value and appends no QueryResult event) |
| `mem_find_graph_origin_ok` | accept | — | §10 (the relationship graph is queried with `find … where { triple+ }`, optionally projecting origin()) |
| `mem_forget_accept` | accept | — | §10 (`forget` drops a memory handle — an audit-preserving tombstone) |
| `mem_forget_records_tombstone` | accept | — | §10 (forget appends an audit-preserving Forgotten tombstone event) |
| `mem_match_is_gate` | accept | — | §10 (match > θ is a gate; yields a settled result off-ledger) |
| `mem_queried_fact_taint_reject` | reject | TaintViolation | §10, §13 (queried facts default to `graded`; must be re-gated before a consequential perform) |
| `mem_recall_after_forget_reject` | reject | TypeError | §10 (forget consumes the mem handle; the region is unrecallable going forward) |
| `mem_recall_requires_mem_reject` | reject | TypeError | §10 (`->` recall requires a `mem` handle on the left; a non-`mem` LHS is a TypeError) |
| `mem_select_boolean_ops_ok` | accept | — | §10 (select where conditions support comparison operators combined by boolean connectives) |
| `mem_store_internalizes_ok` | accept | — | §9, §10 (store(x) explicitly internalizes a value into the agent's memory — the invoked, default form of internalization; eager-on-receive is opt-in config, §16.7/§17) |
| `mem_store_records_internalized` | accept | — | §9, §10 (store(x) explicitly internalizes a value and records Internalized) |
| `mem_write_recall_accept` | accept | — | §10 (a `mem` handle into private memory: write with `<-`, recall with `->`) |

## 11_control

| id | expect | error | spec |
|---|---|---|---|
| `ctrl_case_all_variants_ok` | accept | — | §11 (a gated case covering every enum variant is exhaustive) |
| `ctrl_case_default_ok` | accept | — | §11 (a default arm makes a partial case exhaustive) |
| `ctrl_case_nonexhaustive_reject` | reject | ExhaustivenessError | §11 (a case with no default must cover all variants) |
| `ctrl_case_ungated_credence_reject` | reject | TypeError | §3, §11 (a Credence<E> is consumed only by a gate/combinator; an un-gated case is a TypeError — gate it first) |
| `ctrl_credence_in_if_reject` | reject | TypeError | §3, §11 (a Credence<bool> is not a bool; a bare Credence in an if is a TypeError — gate it first) |
| `ctrl_if_else` | accept | — | §11 (if/else over a bool) |
| `ctrl_retry_bounded` | accept | — | §11, §15.2 (the only loop is the bounded `{ block } retry(N)`) |
| `ctrl_retry_exhausted` | accept | — | §11 (a `{ block } retry(N)` re-attempts on a fault; on exhaustion it emits RetryExhausted and the fault propagates) |

## 12_aggregation

| id | expect | error | spec |
|---|---|---|---|
| `agg_all_bool_conjunction` | accept | — | §12 (over plain bool, `all`/`any` are ordinary conjunction/disjunction — no fusion, no dependence declaration needed) |
| `agg_all_independent_ok` | accept | — | §12 (all over independent Credence<bool> judges fuses to one Credence<bool>) |
| `agg_any_bool_disjunction` | accept | — | §12 (over plain bool, any is ordinary disjunction and needs no dependence declaration) |
| `agg_any_no_dep_decl_reject` | reject | TypeError | §12 (any over Credence<bool> judges requires total independent/dependent coverage) |
| `agg_dependent_fuse_ok` | accept | — | §12 (a `dependent` declaration fuses conservatively into one Credence<bool>) |
| `agg_mixed_clusters_fuse` | accept | — | §12 (mixed sets compose: each `dependent` cluster fuses conservatively first, then the cluster results combine by the independent rule; coverage must be total over every pair) |
| `agg_pipe_fanout_ok` | accept | — | §12 (`coll |> fn` maps each element of a collection through fn) |
| `agg_quorum_independent_ok` | accept | — | §12 (quorum over independent Credence<bool> judges fuses to one Credence<bool>) |
| `agg_quorum_no_dep_decl_reject` | reject | TypeError | §12 (fusion — incl. quorum — requires a total independent/dependent declaration) |

## 13_governance

| id | expect | error | spec |
|---|---|---|---|
| `gov_attest_by_principal_ok` | accept | — | §13 (attest e by p reaches the identity dependency and records an Attestation — the principal basis) |
| `gov_attest_deny_failed` | accept | — | §13 (when the principal declines, the attest gate records a FailedAttestation; the decision is the principal's, deferred to the model only for the clear cases) |
| `gov_attest_records_attestation` | accept | — | §13, §16.4 (a granted attest records an Attestation event for the gated value) |
| `gov_conformal_coldstart_abstains` | accept | — | §13 (a conformal gate with no recorded decisions is below its labelled-case readiness floor and abstains — the supervised cold start; autonomy is earned as grounded labels accrue) |
| `gov_conformal_gate_ok` | accept | — | §13 (the conformal basis `by conformal α` is a distribution-free finite-sample gate calibrated from the ledger) |
| `gov_consequential_bare_collapse_reject` | reject | TaintViolation | §13 (a bare `c by R` is settled but off-ledger/unendorsed → may not license a perform) |
| `gov_endorse_abstain_ok` | accept | — | §13 (the optional abstain clause runs when the gate cannot commit a singleton prediction set) |
| `gov_endorse_records_decided_ok` | accept | — | §9, §13 (endorse records the collapse as a Decided event on the ledger, subject = the binding) |
| `gov_endorsed_perform_ok` | accept | — | §13 (an endorsed Decision may license a consequential perform) |
| `gov_extend_use_subtractive_reject` | reject | AuthorityViolation | §5, §13 (capabilities, incl. `use`, are subtractive under extend) |
| `gov_grants_star_ok` | accept | — | §13 (grants { * } is the explicit unconstrained opt-out — lattice top) |
| `gov_margin_floor_abstains` | accept | — | §13 (a gated decision whose margin is below its policy `floor` m abstains — the typed trigger for escalation — even when the threshold is met) |
| `gov_perform_reach_subtractive_reject` | reject | AuthorityViolation | §5, §13 (grants are subtractive under extend for `perform`/`reach` too — a child may not exceed its parent's authority) |
| `gov_perform_ungranted_reject` | reject | AuthorityViolation | §13 (default-deny: an agent may only perform actions in its grants) |
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
| `repro_chain_head_equal` | accept | — | §15.4.2, §15.5 / T4 (a recorded run replays to an identical chain-head: every oracle/tool result is re-served from the journal in order and nothing is re-invoked) |
| `repro_collapse_off_ledger` | accept | — | §15 (`c by R` is a pure projection of a Credence; off-ledger and synchronous) |

## 16_config

| id | expect | error | spec |
|---|---|---|---|
| `cfg_eager_internalize` | accept | — | §16.7, §17 (with `[memory] internalize_on_receive = true`, every received `<-` event is auto-decomposed into memory — the eager, opt-in trigger; default is off) |
| `cfg_missing_principal_binding_reject` | reject | ConfigError | §17 (each principal declaration resolves to an identity binding; missing binding is a configuration error) |
| `cfg_missing_prompt_binding_reject` | reject | ConfigError | §17 (each prompt declaration resolves to a manifest binding; missing binding is a configuration error) |
| `cfg_missing_tool_binding_reject` | reject | ConfigError | §17 (each tool declaration resolves to a configured world capability; missing binding is a configuration error) |
| `cfg_require_fallback_temperature_reject` | reject | ConfigError | §17 (a text-only provider at temperature 0 requires fallback_temperature for sampling fallback) |
| `cfg_sampling_fallback` | accept | — | §16.8, §17 (a text-only provider — no logprobs — is served by the sampling fallback: the credence is the empirical frequency of N forced draws; a confident judgment still commits) |
| `cfg_sampling_fallback_disabled_defers` | accept | — | §20.3, §17 (without logprobs or sampling fallback, conformal degrades to deferral/abstain) |
| `cfg_strict_bindings_ok` | accept | — | §17 (declared dependencies pass configuration binding when every dependency has a manifest entry) |

## 18_modules

| id | expect | error | spec |
|---|---|---|---|
| `mod_ambiguous_name_reject` | reject | ModuleError | §19.2 (an ambiguous bare reference across imports is a ModuleError) |
| `mod_etype_qualified_distinct` | accept | — | §19.2 (same event name in two modules are DISTINCT qualified etypes) |
| `mod_import_alias` | accept | — | §19.2 (import ... as alias rebinds the prefix) |
| `mod_import_cycle_reject` | reject | ModuleError | §19.2 (imports are acyclic; a cycle is a ModuleError) |
| `mod_import_qualified` | accept | — | §19.2 (module=file; whole-module import; qualified name use) |
| `mod_import_selective` | accept | — | §19.2 (selective import binds the bare name) |
| `mod_no_header_is_root` | accept | — | §19.2 (no module/import = implicit root module; v1.0.0 backward compat) |
| `mod_package_path_dependency` | accept | — | §19.3 (a path dependency package exposes its [package] lib as an importable module root) |
| `mod_pub_import_private_reject` | reject | VisibilityError | §19.2a (pub import of a non-pub name is a VisibilityError) |
| `mod_pub_import_reexport` | accept | — | §19.2a (pub import re-exports a name through the importing module's public surface) |
| `mod_selective_import_unknown_reject` | reject | ModuleError | §19.2 (selective import of a non-exported name is a ModuleError) |
| `mod_unresolved_import_reject` | reject | ModuleError | §19.2 (an import resolving to no module is a ModuleError) |

## 19_visibility

| id | expect | error | spec |
|---|---|---|---|
| `vis_private_agent_not_spawnable_reject` | reject | VisibilityError | §19.4 (a private agent type cannot be named/spawned from another module) |
| `vis_private_default_same_module_ok` | accept | — | §19.4 (default-private is module-internal, not decl-internal; siblings see each other) |
| `vis_private_emit_reject` | reject | VisibilityError | §19.4 (a private event cannot be named in emit from another module) |
| `vis_private_event_still_on_ledger` | accept | — | §19.4 (a private event still lands on the ledger; caught cross-module by its Error supertype, not its private name) |
| `vis_private_extend_reject` | reject | VisibilityError | §19.4 (a private agent cannot be named in extend from another module) |
| `vis_private_not_importable_reject` | reject | VisibilityError | §19.4 (a non-pub declaration is not importable; naming it is a VisibilityError) |
| `vis_private_perform_reject` | reject | VisibilityError | §19.4 (a private action cannot be named in perform from another module) |
| `vis_private_qualified_reference_reject` | reject | VisibilityError | §19.4 (a private declaration cannot be named from another module even by qualified reference) |
| `vis_private_reach_reject` | reject | VisibilityError | §19.4 (a private agent cannot be named in a reach capability from another module) |
| `vis_private_when_reject` | reject | VisibilityError | §19.4 (a private event cannot be named in when from another module) |
| `vis_pub_importable` | accept | — | §19.4 (a pub declaration is importable) |
| `vis_shallow_export_reject` | reject | VisibilityError | §19.4 (pub is shallow: a pub type may not expose a private field type) |

## 20_generics

| id | expect | error | spec |
|---|---|---|---|
| `gen_agent_not_generic_reject` | reject | ParseError | §19.5 (agents are not generic; only struct/fn carry type params) |
| `gen_enum_not_generic_reject` | reject | ParseError | §19.5 (enums stay monomorphic; only struct and fn carry type parameters) |
| `gen_fn_identity` | accept | — | §19.5 (user-generic function; monomorphized at the call site) |
| `gen_interface_not_generic_reject` | reject | ParseError | §19.5 (interfaces are not generic; only struct and fn carry type parameters) |
| `gen_monomorphize_two_instances` | accept | — | §19.5 (distinct instantiations monomorphize to distinct concrete types) |
| `gen_multi_param` | accept | — | §19.5 (generics take multiple type parameters) |
| `gen_struct_box` | accept | — | §19.5 (user-generic struct with a type parameter) |
| `gen_typearg_on_nongeneric_reject` | reject | TypeError | §19.5 (type arguments instantiate generic declarations only) |

## 21_interfaces

| id | expect | error | spec |
|---|---|---|---|
| `iface_decl_and_conformance` | accept | — | §19.5 (interface decl; an agent nominally conforms via : Iface) |
| `iface_missing_handler_reject` | reject | InterfaceError | §19.5 (a declared interface with no matching handler is an InterfaceError) |
| `iface_missing_required_grant_reject` | reject | InterfaceError | §19.5 (an interface `requires` a capability the implementor lacks) |
| `iface_multi_implement` | accept | — | §19.5 (an agent may implement multiple interfaces) |
| `iface_not_instantiable_reject` | reject | TypeError | §19.5 (an interface is a type but not instantiable; spawn of one is a TypeError) |
| `iface_outcome_mismatch_reject` | reject | InterfaceError | §19.5 (interface conformance checks the declared handled event and decided outcome) |
| `iface_subtype_binding` | accept | — | §19.5 (agent <: interface; bind a concrete agent to an interface slot; reach over the interface) |
| `iface_syntax_reject_arrow` | reject | ParseError | §19.5 (interface members use `when EVENT decide RESULT`, never `->`) |

## 22_gate

| id | expect | error | spec |
|---|---|---|---|
| `gate_all_reversible_no_principal_accept` | accept | — | §20 (all arms reversible -> argmax-forever; no principal required) |
| `gate_cold_nonreversible_defers_to_principal` | accept | — | §20.1, §20.3 (cold non-reversible decide defers to a reachable principal before the action arm commits) |
| `gate_cold_reversible_no_defer` | accept | — | §20.1 (a cold reversible outcome commits without principal deferral) |
| `gate_decide_defer_clause_accept` | accept | — | §20 (decide with a trailing `defer to p` clause supplies the principal) |
| `gate_decide_principal_subject_accept` | accept | — | §20 (decide with a principal subject; a non-reversible arm has a reachable principal) |
| `gate_decision_field_readonly_reject` | reject | TypeError | §20.4 (Decision provenance fields are read-only) |
| `gate_decision_introspection_accept` | accept | — | §20.4, §9 (Decision provenance: .basis over the Basis enum) |
| `gate_decision_introspection_committed_margin_accept` | accept | — | §20.4 (Decision provenance exposes .committed and .margin, not only .basis) |
| `gate_file_conformal_decl_accept` | accept | — | §20 (file-level `conformal α;` declaration) |
| `gate_nonreversible_no_principal_reject` | reject | GateError | §20 (a non-reversible arm with no reachable principal is a compile error) |
| `gate_per_gate_conformal_accept` | accept | — | §20 (per-gate conformal α override on a decide) |
| `gate_reversible_action_accept` | accept | — | §20 (`reversible action` — reversibility annotates a perform sink) |
| `gate_reversible_tie_abstains` | accept | — | §20.3 (a reversible decide with no plurality and no default abstains; it never silently picks) |
| `gate_reversible_tie_default` | accept | — | §20.3 (a reversible decide tie uses default as the tiebreak instead of silently picking) |
