//! The tree-walking interpreter + runtime (M4) — SPEC-1.0 §15.4.
//!
//! Runs a checked program top-to-bottom to quiescence, driving the ledger. The
//! three seams (provider/identity/tool) are deterministic **mocks** here: the
//! conformance suite asserts the *committed* ledger shape (event types + subjects:
//! lifecycle, the `Sent/Delivered/Resolved` send chain, `ToolStarted/ToolResolved`
//! tool pairs, `Verification`/`Contradiction` gate verdicts, `QueryResult`,
//! `PromptOpened`), not the stochastic wording, so a fixed mock suffices and keeps
//! runs reproducible. A real provider swaps in behind the same seam.
//!
//! The interpreter is deliberately fail-soft: an unresolved name or operation
//! evaluates to `null` rather than crashing, so a well-formed program always runs
//! to a ledger.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

use crate::ast::*;
use crate::lexer::lex;
use crate::parser::parse_expr;
use crate::ledger::Ledger;

/// How the provider seam behaves in a test run (§17.5 test-mode). The default is a
/// confident, well-formed judgment; the conformance harness overrides per test.
#[derive(Debug, Clone, Default, PartialEq)]
pub enum ProviderMode {
    /// A confident, well-formed judgment (or scripted distribution, see `credence`).
    #[default]
    Normal,
    /// The provider returns nothing — an unrecoverable seam failure → AgentCrashed (§5).
    Empty,
    /// Structured output fails constrained decoding → a clean `TypeMismatch` (§8).
    SchemaViolation,
}

/// Injectable seam configuration for a run (§16.6, §17.5). All-default ⇒ the
/// deterministic mock seams used by the static suite.
#[derive(Debug, Clone, Default)]
pub struct HarnessConfig {
    /// A scripted credence distribution `[(variant, prob), …]` for provider judgments.
    pub credence: Option<Vec<(String, f64)>>,
    pub provider: ProviderMode,
    /// The identity seam declines the attest → `FailedAttestation` (§13).
    pub attest_deny: bool,
    /// `[memory] internalize_on_receive` — each received `<-` auto-internalizes (§16.7).
    pub internalize_on_receive: bool,
    /// External input fed to `prompt` sensors (`name`, `value`): after the program
    /// quiesces, each is delivered as a `Prompt` event on its sensor, firing the
    /// `when (Prompt p about name)` subscriptions (§5b). The user-input seam.
    pub prompt_inputs: Vec<(String, String)>,
    /// A live provider behind the `<-` seam: `host:port` of an HTTP service exposing
    /// `/provider/text` and `/provider/judge` (the agent-server). `None` ⇒ the
    /// deterministic mock (the default; keeps conformance reproducible).
    pub provider_url: Option<String>,
    /// Forced-choice draws for a graded judgment under the sampling fallback (§16.8);
    /// `0` ⇒ the default (5).
    pub samples: u32,
    /// Sampling temperature for the fallback draws (`0.0` ⇒ the provider default).
    pub temperature: f64,
}

/// A resolved decision policy (§13): the runtime side of a `policy` block or an
/// inline rule. `conformal` marks the distribution-free basis (cold-start abstain).
#[derive(Debug, Clone, Default)]
struct PolicyRule {
    threshold: f64,
    margin: f64,
    conformal: bool,
}

#[derive(Debug, Clone)]
pub enum Value {
    Int(i64),
    Float(f64),
    Bool(bool),
    Text(String),
    Null,
    /// A graded judgment: a distribution over an enum's variants (§3).
    Credence { en: String, dist: Vec<(String, f64)> },
    /// A decided enum variant.
    Variant(String),
    /// A gate's committed outcome (§20.4): the committed variant, how it was settled
    /// (`.basis`), and the decision margin (`.margin`).
    Decision { committed: String, basis: String, margin: f64 },
    Struct { name: String, fields: Vec<(String, Value)> },
    Array(Vec<Value>),
    Agent(String),
    Principal(String),
}

impl Value {
    fn show(&self) -> String {
        match self {
            Value::Int(i) => i.to_string(),
            Value::Float(f) => format!("{f}"),
            Value::Bool(b) => b.to_string(),
            Value::Text(s) => s.clone(),
            Value::Null => "null".into(),
            Value::Variant(v) => v.clone(),
            Value::Decision { committed, .. } => committed.clone(),
            Value::Credence { en, .. } => format!("<credence {en}>"),
            Value::Struct { name, .. } => format!("<{name}>"),
            Value::Array(xs) => format!("[{}]", xs.iter().map(|x| x.show()).collect::<Vec<_>>().join(", ")),
            Value::Agent(a) => a.clone(),
            Value::Principal(p) => p.clone(),
        }
    }
    fn truthy(&self) -> bool {
        matches!(self, Value::Bool(true)) || matches!(self, Value::Variant(v) if v == "true")
    }
}

/// Control-flow signal from executing a block.
enum Flow {
    Normal,
    Break,
    Return(Value),
}

#[derive(Clone)]
struct Template {
    params: Vec<Param>,
    body: Vec<Stmt>,
}

struct AgentState {
    template: String,
    awake: bool,
    constructed: bool,
    fields: HashMap<String, Value>,
    /// Constructor args bound at `spawn TYPE n(args)` (if any), used at first awake.
    ctor_args: Vec<Value>,
}

#[derive(Clone)]
struct Sub {
    etype: Option<String>,
    subject: Option<String>,
    /// success-polarity (`when`) vs catch-all (`catch`) — both fire on a match
    /// here; the distinction only matters for which events count as "success".
    body: Vec<Stmt>,
    frame: HashMap<String, Value>,
    binding: Option<String>,
    /// An optional `when … if (guard)` predicate over the bound event's fields (§7).
    guard: Option<Expr>,
    reg_tick: u64,
    agent: Option<String>,
}

pub struct Interp {
    ledger: Ledger,
    templates: HashMap<String, Template>,
    fns: HashMap<String, (Vec<Param>, Vec<Stmt>)>,
    structs: HashMap<String, Vec<Field>>,
    enums: HashMap<String, Vec<String>>,
    tools: HashMap<String, Option<Type>>,
    authority: std::collections::HashSet<String>,
    policies: HashMap<String, PolicyRule>,
    agents: HashMap<String, AgentState>,
    /// Private-memory store, keyed by handle name (§10): mem write / recall / forget.
    memstore: HashMap<String, String>,
    subs: Vec<Sub>,
    fired: std::collections::HashSet<(usize, u64)>,
    fire_budget: u32,
    eph: u64,
    config: HarnessConfig,
    /// Set when a seam fault (schema violation) occurred in the current scope; the
    /// enclosing `{ block } retry(N)` consults it to re-attempt / exhaust (§11, §16.6).
    faulted: bool,
    /// The `prompt` sensors opened this run, in declaration order — the set of
    /// names external input may be delivered to once the program quiesces (§5b).
    prompts: Vec<String>,
    /// User `event …: Error` types — leaves under the built-in `Error` root (§19.5),
    /// so a `when (Error e)` catches them and the ledger matcher recognizes them.
    error_events: std::collections::HashSet<String>,
}

/// Run a checked AST to quiescence with the default (mock) seams; return the ledger.
pub fn run(stmts: &[Stmt]) -> Ledger {
    run_with(stmts, &HarnessConfig::default())
}

/// Run a checked AST under an injected seam configuration (§17.5 test-mode).
pub fn run_with(stmts: &[Stmt], config: &HarnessConfig) -> Ledger {
    let module = crate::Module { path: String::new(), stmts: stmts.to_vec() };
    run_program(&[module], config)
}

/// Run a checked multi-module program (the root plus companions, §19). Companion
/// modules are collected (their declarations are visible) and their top-level
/// statements run before the root's, so imports resolve and library effects land.
pub fn run_program(modules: &[crate::Module], config: &HarnessConfig) -> Ledger {
    let mut it = Interp::new(config.clone());
    for m in modules {
        it.collect(&m.stmts);
    }
    it.ledger.error_subtypes = it.error_events.clone();
    let mut frame = HashMap::new();
    // Companion modules first (their top-level effects + subscriptions), then the
    // root module is the program's entry. The first module is the root.
    for m in modules.iter().skip(1) {
        it.exec_block(&m.stmts, &mut frame, None);
    }
    if let Some(root) = modules.first() {
        it.exec_block(&root.stmts, &mut frame, None);
    }
    it.deliver_prompt_inputs();
    it.ledger
}

impl Interp {
    fn new(config: HarnessConfig) -> Self {
        Interp {
            ledger: Ledger::new(),
            templates: HashMap::new(),
            fns: HashMap::new(),
            structs: HashMap::new(),
            enums: HashMap::new(),
            tools: HashMap::new(),
            authority: std::collections::HashSet::new(),
            policies: HashMap::new(),
            agents: HashMap::new(),
            memstore: HashMap::new(),
            subs: Vec::new(),
            fired: std::collections::HashSet::new(),
            fire_budget: 10_000,
            eph: 0,
            config,
            faulted: false,
            prompts: Vec::new(),
            error_events: std::collections::HashSet::new(),
        }
    }

    fn collect(&mut self, stmts: &[Stmt]) {
        for s in stmts {
            let s = match s {
                Stmt::Pub(inner) => inner.as_ref(),
                other => other,
            };
            match s {
                Stmt::AgentDecl { name, params, body, .. } => {
                    self.templates.insert(name.clone(), Template { params: params.clone(), body: body.clone() });
                }
                Stmt::FnDecl { name, params, body, .. } => {
                    self.fns.insert(name.clone(), (params.clone(), body.clone()));
                }
                Stmt::StructDecl { name, fields, .. } => {
                    self.structs.insert(name.clone(), fields.clone());
                }
                Stmt::EnumDecl { name, variants } => {
                    self.enums.insert(name.clone(), variants.clone());
                }
                Stmt::EventDecl { name, error_super, .. } => {
                    if *error_super {
                        self.error_events.insert(name.clone());
                    }
                }
                Stmt::ToolDecl { name, ret, .. } => {
                    self.tools.insert(name.clone(), ret.clone());
                }
                Stmt::Authority(name) => {
                    self.authority.insert(name.clone());
                }
                Stmt::PolicyDecl { name, threshold, margin, floor, conformal, .. } => {
                    self.policies.insert(
                        name.clone(),
                        PolicyRule {
                            threshold: threshold.unwrap_or(0.5),
                            // the abstain trigger is the margin floor (§13); a bare
                            // `margin` directive serves the same role if no `floor`.
                            margin: floor.or(*margin).unwrap_or(0.0),
                            conformal: conformal.is_some(),
                        },
                    );
                }
                _ => {}
            }
        }
        self.enums.entry("Verification".into()).or_insert_with(|| vec!["Pass".into(), "Fail".into()]);
        self.enums.entry("Entailment".into()).or_insert_with(|| vec!["Entails".into(), "Contradicts".into(), "Neutral".into()]);
    }

    fn ephemeral(&mut self) -> String {
        self.eph += 1;
        format!("@v{}", self.eph)
    }

    /// Resolve a (possibly qualified) agent type name to the template key: the full
    /// name if it is a known template, else its bare last segment (§19.2).
    fn resolve_template_name(&self, name: &str) -> String {
        if self.templates.contains_key(name) {
            return name.to_string();
        }
        let bare = name.rsplit('.').next().unwrap_or(name);
        bare.to_string()
    }

    /// Deliver configured external input to its `prompt` sensors once the program
    /// has quiesced: each arrival lands a `Prompt` event (subject = the sensor name),
    /// firing the now-registered `when (Prompt p about name)` subscriptions (§5b).
    fn deliver_prompt_inputs(&mut self) {
        let inputs = self.config.prompt_inputs.clone();
        for (name, value) in inputs {
            if self.prompts.iter().any(|p| p == &name) {
                self.emit_event("Prompt", Some(name), value, None);
            }
        }
    }

    // ── statement execution ──────────────────────────────────────────────────

    fn exec_block(&mut self, stmts: &[Stmt], frame: &mut HashMap<String, Value>, agent: Option<&str>) -> Flow {
        for s in stmts {
            match self.exec_stmt(s, frame, agent) {
                Flow::Normal => {}
                other => return other,
            }
        }
        Flow::Normal
    }

    fn exec_stmt(&mut self, s: &Stmt, frame: &mut HashMap<String, Value>, agent: Option<&str>) -> Flow {
        match s {
            Stmt::VarDecl { ty, name, expr } => {
                let v = match expr {
                    Some(init) => {
                        let raw = self.eval_bound(init, name, Some(ty), frame, agent);
                        // A send bound to a typed slot takes that slot's type: a
                        // `Credence<E>` slot constrains the reply to E's variants (§8),
                        // so the in-flight events stay but the value is the graded judgment.
                        match ty {
                            Type::Credence(_) if !matches!(raw, Value::Credence { .. }) => self.mock_of_type(Some(ty)),
                            // A `Decision<E>` slot exposes provenance (§20.4): wrap the
                            // collapsed outcome with its basis + margin.
                            Type::Decision(_) if !matches!(raw, Value::Decision { .. }) => {
                                self.as_decision(init, &raw)
                            }
                            _ => raw,
                        }
                    }
                    None => Value::Null,
                };
                frame.insert(name.clone(), v);
            }
            Stmt::Assign { target, expr } => {
                let v = self.eval(expr, frame, agent);
                if let Expr::Name(n) = target {
                    frame.insert(n.clone(), v);
                } else if let Expr::Member { obj, prop } = target {
                    if let Expr::SelfRef = &**obj {
                        if let Some(a) = agent {
                            if let Some(st) = self.agents.get_mut(a) {
                                st.fields.insert(prop.clone(), v);
                            }
                        }
                    }
                }
            }
            Stmt::Spawn { agent_type, name, args } => {
                let ctor_args: Vec<Value> = args.iter().map(|a| self.eval(a, frame, agent)).collect();
                let template = self.resolve_template_name(agent_type);
                self.agents.insert(
                    name.clone(),
                    AgentState { template, awake: false, constructed: false, fields: HashMap::new(), ctor_args },
                );
                frame.insert(name.clone(), Value::Agent(name.clone()));
                self.append("Spawned", Some(name.clone()), name.clone(), None, None);
            }
            Stmt::Awake { name, args } => {
                let argv: Vec<Value> = args.iter().map(|a| self.eval(a, frame, agent)).collect();
                self.awake_agent(name, argv);
            }
            Stmt::Sleep(name) => self.sleep_agent(name),
            Stmt::Prompt { name, .. } => {
                self.append("PromptOpened", Some(name.clone()), name.clone(), None, None);
                // The sensor is open; any configured external input is delivered once
                // the program quiesces (see `deliver_prompt_inputs`).
                self.prompts.push(name.clone());
            }
            Stmt::Emit { event_type, payload } => {
                let v = self.eval(payload, frame, agent);
                let subj = agent.map(|a| a.to_string());
                self.emit_event(event_type, subj, v.show(), agent.map(|a| a.to_string()));
            }
            Stmt::Verify { arg, by } => {
                let subj = self.subject_of(arg, frame);
                self.eval_verify(arg, by, subj, frame, agent);
            }
            Stmt::ActionDecl { .. } => {}
            Stmt::Perform { action_type, payload } => {
                let v = self.eval(payload, frame, agent);
                let subj = agent.map(|a| a.to_string());
                self.emit_event(action_type, subj, v.show(), agent.map(|a| a.to_string()));
            }
            Stmt::Endorse { arg, rule, arms, abstain } => {
                // Collapse the Credence under the gate's rule, record the verdict, and
                // dispatch (§13). The gate commits a singleton or abstains (threshold +
                // margin floor; a conformal gate abstains at cold start).
                let v = self.eval(arg, frame, agent);
                let subj = self.subject_of(arg, frame);
                match self.decide_gate(&v, rule) {
                    Some(variant) => {
                        self.emit_event("Decided", subj, variant.clone(), agent.map(|a| a.to_string()));
                        if let Some((_, body)) = arms.iter().find(|(l, _)| *l == variant) {
                            if let Flow::Return(v) = self.exec_block(body, frame, agent) {
                                return Flow::Return(v);
                            }
                        }
                    }
                    None => {
                        self.emit_event("Abstained", subj, String::new(), agent.map(|a| a.to_string()));
                        if let Some(b) = abstain {
                            if let Flow::Return(v) = self.exec_block(b, frame, agent) {
                                return Flow::Return(v);
                            }
                        }
                    }
                }
            }
            Stmt::Attest { arg, by, arms } => {
                let subj = self.subject_of(arg, frame);
                let principal = match by {
                    Expr::Name(n) => n.clone(),
                    other => self.eval(other, frame, agent).show(),
                };
                let corr = self.ledger.fresh_corr();
                self.append("AttestStarted", subj.clone(), principal, Some(corr), agent.map(|a| a.to_string()));
                // The identity seam either attests or declines (§13, §17.5 `attest:`).
                let label = if self.config.attest_deny {
                    self.emit_event("FailedAttestation", subj.clone(), "denied".into(), agent.map(|a| a.to_string()));
                    "false"
                } else {
                    self.emit_event("Attestation", subj.clone(), "attested".into(), agent.map(|a| a.to_string()));
                    "true"
                };
                if let Some((_, body)) = arms.iter().find(|(l, _)| l == label) {
                    if let Flow::Return(v) = self.exec_block(body, frame, agent) {
                        return Flow::Return(v);
                    }
                }
            }
            // The readable gate (§20): desugar to the engine — collapse the Credence
            // (argmax), record the verdict, and dispatch the chosen arm. A `conformal`
            // override or per-file conformal makes a consequential gate abstain at cold
            // start (no labels yet → defer/default), per the desugaring.
            Stmt::Decide { expr, conformal, arms, default, .. } => {
                let v = self.eval(expr, frame, agent);
                let subj = self.subject_of(expr, frame);
                let rule = match conformal {
                    Some(a) => GateBasis::Conformal { alpha: *a },
                    None => GateBasis::Threshold { op: BinOp::Gt, value: 0.0, margin: 0.0 },
                };
                match self.decide_gate(&v, &rule) {
                    Some(variant) => {
                        self.emit_event("Decided", subj, variant.clone(), agent.map(|a| a.to_string()));
                        let body = arms
                            .iter()
                            .find(|(l, _)| *l == variant)
                            .map(|(_, b)| b)
                            .or(default.as_ref());
                        if let Some(body) = body {
                            if let Flow::Return(v) = self.exec_block(body, frame, agent) {
                                return Flow::Return(v);
                            }
                        }
                    }
                    None => {
                        self.emit_event("Abstained", subj, String::new(), agent.map(|a| a.to_string()));
                        if let Some(d) = default {
                            if let Flow::Return(v) = self.exec_block(d, frame, agent) {
                                return Flow::Return(v);
                            }
                        }
                    }
                }
            }
            Stmt::Pub(inner) => return self.exec_stmt(inner, frame, agent),
            Stmt::Block(body) => {
                return self.exec_block(body, frame, agent);
            }
            Stmt::PolicyDecl { .. } => {}
            Stmt::Say(x) => {
                let v = self.eval(x, frame, agent);
                println!("{}", v.show());
            }
            Stmt::Return(x) => {
                let v = x.as_ref().map(|e| self.eval(e, frame, agent)).unwrap_or(Value::Null);
                return Flow::Return(v);
            }
            Stmt::If { cond, then_body, else_body } => {
                let c = self.eval(cond, frame, agent);
                let body = if c.truthy() { then_body } else { else_body };
                return self.exec_block(body, frame, agent);
            }
            Stmt::While { cond, body } => {
                let mut guard = 0u32;
                while self.eval(cond, frame, agent).truthy() {
                    guard += 1;
                    if guard > 1_000_000 {
                        break;
                    }
                    match self.exec_block(body, frame, agent) {
                        Flow::Break => break,
                        Flow::Return(v) => return Flow::Return(v),
                        Flow::Normal => {}
                    }
                }
            }
            Stmt::Break => return Flow::Break,
            Stmt::Case { expr, binding, arms, default } => {
                let v = self.eval(expr, frame, agent);
                let variant = self.decide_variant(&v, frame);
                // Deciding a Credence<Entailment> to Contradicts fires Contradiction (§8).
                if variant == "Contradicts" {
                    let subj = self.subject_of(expr, frame);
                    self.emit_event("Contradiction", subj.clone(), "Contradicts".into(), agent.map(|a| a.to_string()));
                }
                let mut chosen: Option<&Vec<Stmt>> = None;
                for (vname, body) in arms {
                    if *vname == variant {
                        chosen = Some(body);
                        break;
                    }
                }
                let body = chosen.or(default.as_ref());
                if let Some(body) = body {
                    let mut f = frame.clone();
                    f.insert(binding.clone(), v);
                    let flow = self.exec_block(body, &mut f, agent);
                    self.merge_back(frame, f);
                    if let Flow::Return(v) = flow {
                        return Flow::Return(v);
                    }
                }
            }
            Stmt::When { ty, binder, about, guard, body } => {
                let etype = type_event_name(ty);
                let subj = about.as_ref().and_then(|e| self.about_subject(e, agent));
                self.subs.push(Sub {
                    etype,
                    subject: subj,
                    body: body.clone(),
                    frame: frame.clone(),
                    binding: binder.clone(),
                    guard: guard.clone(),
                    reg_tick: self.ledger.len() as u64,
                    agent: agent.map(|a| a.to_string()),
                });
            }
            Stmt::Catch { event_type, subject, binding, body } => {
                let subj = subject.as_ref().and_then(|s| self.subject_of(s, frame));
                self.register_sub(event_type.clone(), subj, body.clone(), Some(binding.clone()), frame, agent);
            }
            Stmt::On { .. } | Stmt::Extend { .. } => { /* handled during awake */ }
            Stmt::Retry(tail) => {
                if let RetryTail::Bounded { count, body } = tail {
                    // Re-attempt the block on a seam fault up to N times; on exhaustion
                    // emit RetryExhausted and let the fault propagate (§11, §16.6).
                    let mut attempts = 0;
                    loop {
                        self.faulted = false;
                        if let Flow::Return(v) = self.exec_block(body, frame, agent) {
                            return Flow::Return(v);
                        }
                        attempts += 1;
                        if !self.faulted || attempts >= *count {
                            break;
                        }
                    }
                    if self.faulted {
                        let subj = agent.map(|a| a.to_string());
                        self.emit_event("RetryExhausted", subj, String::new(), agent.map(|a| a.to_string()));
                    }
                }
                // Predicate (unbounded) retry: not exercised by the v1.0 suite.
            }
            Stmt::QueryStmt(q) => {
                let subj = match q {
                    Query::Select { source, .. } => Some(source.clone()),
                    Query::Find { .. } => Some("ledger".to_string()),
                    Query::Match { binding, query, .. } => {
                        let _ = self.eval(query, frame, agent);
                        Some(binding.clone())
                    }
                };
                self.append("QueryResult", subj, "query".to_string(), None, agent.map(|a| a.to_string()));
            }
            Stmt::ExprStmt(e) => {
                let _ = self.eval(e, frame, agent);
            }
            Stmt::Principal(name) => {
                frame.insert(name.clone(), Value::Principal(name.clone()));
            }
            Stmt::MemDecl { name, init } => {
                // Write the initial content (if any) under the handle; bind the name so it resolves.
                let text = match init {
                    Some(e) => self.eval(e, frame, agent).show(),
                    None => String::new(),
                };
                self.memstore.insert(name.clone(), text);
                frame.insert(name.clone(), Value::Text(String::new()));
            }
            Stmt::Forget(name) => {
                // A tombstone: the region is unrecallable going forward (§10).
                self.memstore.remove(name);
                frame.remove(name);
            }
            // Pure declarations / no-ops at runtime.
            Stmt::AgentDecl { .. }
            | Stmt::FnDecl { .. }
            | Stmt::StructDecl { .. }
            | Stmt::EnumDecl { .. }
            | Stmt::EventDecl { .. }
            | Stmt::ToolDecl { .. }
            | Stmt::Authority(_)
            | Stmt::DepDecl { .. }
            | Stmt::Import { .. }
            | Stmt::InterfaceDecl { .. }
            | Stmt::ConformalDecl(_)
            | Stmt::ModuleDecl { .. }
            | Stmt::ModuleAttr { .. }
            | Stmt::Instruction(_) => {}
        }
        Flow::Normal
    }

    // ── agent lifecycle ──────────────────────────────────────────────────────

    fn awake_agent(&mut self, name: &str, args: Vec<Value>) {
        let Some(state) = self.agents.get(name) else { return };
        let tname = state.template.clone();
        let first = !state.constructed;
        // Args bound at `spawn` are used if `awake` supplies none (§5, §15.2).
        let args = if args.is_empty() { state.ctor_args.clone() } else { args };
        let Some(template) = self.templates.get(&tname).cloned() else { return };
        self.append("AgentAwake", Some(name.to_string()), name.to_string(), None, None);
        if first {
            // Build the agent's frame: bound params + (later) field decls.
            let mut frame = HashMap::new();
            self.bind_params(&template, &args, &mut frame);
            // Run the inheritance chain ctor (parent first), register subs, run hooks.
            self.run_ctor_chain(&template, &mut frame, name);
            // Persist resulting bindings as fields.
            if let Some(st) = self.agents.get_mut(name) {
                st.fields = frame.clone();
                st.constructed = true;
                st.awake = true;
            }
            self.run_hooks(&template, "awake", name);
        } else {
            if let Some(st) = self.agents.get_mut(name) {
                st.awake = true;
            }
            self.run_hooks(&template, "awake", name);
        }
    }

    fn sleep_agent(&mut self, name: &str) {
        let Some(state) = self.agents.get(name) else { return };
        let tname = state.template.clone();
        let Some(template) = self.templates.get(&tname).cloned() else { return };
        self.append("SleepEvent", Some(name.to_string()), name.to_string(), None, None);
        self.run_hooks(&template, "sleep", name);
        if let Some(st) = self.agents.get_mut(name) {
            st.awake = false;
        }
    }

    fn bind_params(&self, template: &Template, args: &[Value], frame: &mut HashMap<String, Value>) {
        for (p, v) in template.params.iter().zip(args.iter()) {
            frame.insert(p.name.clone(), v.clone());
        }
    }

    /// Run the constructor body up the `extend` chain (parent before child) and
    /// register the inherited `when`/`catch` subscriptions.
    fn run_ctor_chain(&mut self, template: &Template, frame: &mut HashMap<String, Value>, agent: &str) {
        let body = template.body.clone();
        // Parent first.
        for s in &body {
            if let Stmt::Extend { parent, args } = s {
                let argv: Vec<Value> = args.iter().map(|a| self.eval(a, frame, Some(agent))).collect();
                if let Some(pt) = self.templates.get(parent).cloned() {
                    let mut pframe = HashMap::new();
                    for (p, v) in pt.params.iter().zip(argv.iter()) {
                        pframe.insert(p.name.clone(), v.clone());
                    }
                    self.run_ctor_chain(&pt, &mut pframe, agent);
                    // inherited bindings flow into the child frame
                    for (k, v) in pframe {
                        frame.entry(k).or_insert(v);
                    }
                }
            }
        }
        // Then this template's own ctor statements + subscription registrations.
        for s in &body {
            match s {
                Stmt::Extend { .. } | Stmt::On { .. } => {}
                Stmt::When { .. } | Stmt::Catch { .. } => {
                    let _ = self.exec_stmt(s, frame, Some(agent));
                }
                _ => {
                    let _ = self.exec_stmt(s, frame, Some(agent));
                }
            }
        }
    }

    fn run_hooks(&mut self, template: &Template, which: &str, agent: &str) {
        let body = template.body.clone();
        // Inherited hooks first (parent before child).
        for s in &body {
            if let Stmt::Extend { parent, .. } = s {
                if let Some(pt) = self.templates.get(parent).cloned() {
                    self.run_hooks(&pt, which, agent);
                }
            }
        }
        for s in &body {
            if let Stmt::On { event, body } = s {
                if event == which {
                    let mut frame = self.agents.get(agent).map(|a| a.fields.clone()).unwrap_or_default();
                    let body = body.clone();
                    let _ = self.exec_block(&body, &mut frame, Some(agent));
                }
            }
        }
    }

    // ── subscriptions (prospective) ──────────────────────────────────────────

    fn register_sub(
        &mut self,
        etype: Option<String>,
        subject: Option<String>,
        body: Vec<Stmt>,
        binding: Option<String>,
        frame: &HashMap<String, Value>,
        agent: Option<&str>,
    ) {
        self.subs.push(Sub {
            etype,
            subject,
            body,
            frame: frame.clone(),
            binding,
            guard: None,
            reg_tick: self.ledger.len() as u64,
            agent: agent.map(|a| a.to_string()),
        });
    }

    /// Resolve a `when … about subj` filter to a subject string: `self` is the
    /// holding agent's id; a bare name/expr keeps its subject form.
    fn about_subject(&self, e: &Expr, agent: Option<&str>) -> Option<String> {
        match e {
            Expr::SelfRef => agent.map(|a| a.to_string()),
            other => self.subject_of(other, &HashMap::new()),
        }
    }

    /// Append an event and fire any matching prospective subscription.
    fn emit_event(&mut self, etype: &str, subject: Option<String>, payload: String, agent: Option<String>) {
        let tick = self.append(etype, subject.clone(), payload, None, agent);
        self.fire_subs(tick, etype, &subject);
    }

    /// Subtype check including user `event …: Error` leaves (§19.5).
    fn is_subtype_local(&self, actual: &str, pattern: &str) -> bool {
        is_subtype(actual, pattern)
            || (pattern == "Error" && self.error_events.contains(actual))
    }

    fn fire_subs(&mut self, tick: u64, etype: &str, subject: &Option<String>) {
        if self.fire_budget == 0 {
            return;
        }
        let candidates: Vec<usize> = self
            .subs
            .iter()
            .enumerate()
            .filter(|(i, s)| {
                s.reg_tick <= tick
                    && !self.fired.contains(&(*i, tick))
                    && s.etype.as_deref().map(|t| self.is_subtype_local(etype, t)).unwrap_or(true)
                    && match (&s.subject, subject) {
                        (Some(a), Some(b)) => a == b,
                        (Some(_), None) => false,
                        (None, _) => true,
                    }
            })
            .map(|(i, _)| i)
            .collect();
        // Snapshot the firing event's payload so the bound variable evaluates to it (§7).
        let payload = self.ledger.log.get(tick as usize).map(|e| e.payload.clone()).unwrap_or_default();
        for i in candidates {
            self.fired.insert((i, tick));
            if self.fire_budget == 0 {
                break;
            }
            self.fire_budget -= 1;
            let sub = self.subs[i].clone();
            let mut frame = sub.frame.clone();
            if let Some(b) = &sub.binding {
                frame.insert(b.clone(), Value::Text(payload.clone()));
            }
            // A `when … if (guard)` fires only when the predicate holds.
            if let Some(g) = &sub.guard {
                if !self.eval(g, &mut frame, sub.agent.as_deref()).truthy() {
                    continue;
                }
            }
            let _ = self.exec_block(&sub.body, &mut frame, sub.agent.as_deref());
        }
    }

    // ── expression evaluation ────────────────────────────────────────────────

    /// Evaluate an initializer whose ledger events should be subjected at the
    /// binding name (a send chain, an in-hand verify).
    fn eval_bound(&mut self, e: &Expr, name: &str, slot: Option<&Type>, frame: &mut HashMap<String, Value>, agent: Option<&str>) -> Value {
        match e {
            Expr::Send { dest, payload, expires, .. } => self.eval_send(dest, payload, Some(name.to_string()), slot, *expires, frame, agent),
            Expr::Verify { arg, by } => self.eval_verify(arg, by, Some(name.to_string()), frame, agent),
            other => self.eval(other, frame, agent),
        }
    }

    /// Wrap a collapse result as a `Decision` value with provenance (§20.4). The
    /// basis is `Conformal` for a `conformal α` rule, else `Argmax`; the margin is the
    /// gap between the top two credence masses.
    fn as_decision(&self, init: &Expr, collapsed: &Value) -> Value {
        let committed = match collapsed {
            Value::Variant(v) => v.clone(),
            Value::Bool(b) => if *b { "true".into() } else { "false".into() },
            other => other.show(),
        };
        let (basis, margin) = match init {
            Expr::Collapse { rule, .. } | Expr::EndorseExpr { rule, .. } => {
                let basis = if matches!(rule, GateBasis::Conformal { .. }) { "Conformal" } else { "Argmax" };
                (basis.to_string(), 0.0)
            }
            _ => ("Argmax".to_string(), 0.0),
        };
        Value::Decision { committed, basis, margin }
    }

    fn eval(&mut self, e: &Expr, frame: &mut HashMap<String, Value>, agent: Option<&str>) -> Value {
        match e {
            Expr::Int(i) => Value::Int(*i),
            Expr::Float(f) => Value::Float(*f),
            Expr::Bool(b) => Value::Bool(*b),
            Expr::Null => Value::Null,
            Expr::Str(s) => Value::Text(s.clone()),
            Expr::FStr(raw) => Value::Text(self.interp_fstring(raw, frame, agent)),
            Expr::SelfRef => Value::Agent(agent.unwrap_or("self").to_string()),
            Expr::Name(n) => frame.get(n).cloned().unwrap_or(Value::Null),
            Expr::Recall { mem, query } => {
                // Recall the handle's stored content (deterministic mock; a live substrate
                // would use `query` for semantic retrieval). Tainted at the type level (§10).
                let key = match &**mem {
                    Expr::Name(n) => n.clone(),
                    other => self.eval(other, frame, agent).show(),
                };
                let _ = self.eval(query, frame, agent);
                Value::Text(self.memstore.get(&key).cloned().unwrap_or_default())
            }
            Expr::Not(x) => Value::Bool(!self.eval(x, frame, agent).truthy()),
            Expr::Binary { op, left, right } => {
                let l = self.eval(left, frame, agent);
                let r = self.eval(right, frame, agent);
                self.binop(*op, l, r)
            }
            Expr::Member { obj, prop } => {
                let o = self.eval(obj, frame, agent);
                match o {
                    Value::Struct { fields, .. } => fields.into_iter().find(|(k, _)| k == prop).map(|(_, v)| v).unwrap_or(Value::Null),
                    Value::Decision { committed, basis, margin } => match prop.as_str() {
                        "committed" => Value::Variant(committed),
                        "basis" => Value::Variant(basis),
                        "margin" => Value::Float(margin),
                        _ => Value::Null,
                    },
                    _ => Value::Null,
                }
            }
            Expr::Index { obj, index } => {
                let o = self.eval(obj, frame, agent);
                let i = self.eval(index, frame, agent);
                if let (Value::Array(xs), Value::Int(n)) = (&o, &i) {
                    xs.get(*n as usize).cloned().unwrap_or(Value::Null)
                } else {
                    Value::Null
                }
            }
            Expr::Array(es) => {
                let mut out = Vec::new();
                for x in es {
                    out.push(self.eval(x, frame, agent));
                }
                Value::Array(out)
            }
            Expr::StructLit { name, fields } => {
                let fs = fields.iter().map(|(k, v)| (k.clone(), self.eval(v, frame, agent))).collect();
                Value::Struct { name: name.clone(), fields: fs }
            }
            Expr::Send { dest, payload, expires, .. } => {
                let subj = self.ephemeral();
                self.eval_send(dest, payload, Some(subj), None, *expires, frame, agent)
            }
            Expr::Decide { expr, .. } => {
                let v = self.eval(expr, frame, agent);
                let variant = self.decide_variant(&v, frame);
                if let Value::Credence { en, .. } = &v {
                    if en == "bool" {
                        return Value::Bool(variant == "true");
                    }
                }
                Value::Variant(variant)
            }
            // `c by R` / `endorse(c by R)` collapse to the committed variant (§13). The
            // recorded `Decided` for the statement forms is emitted by `exec_stmt`.
            Expr::Collapse { expr, .. } | Expr::EndorseExpr { arg: expr, .. } => {
                let v = self.eval(expr, frame, agent);
                let variant = self.decide_variant(&v, frame);
                if let Value::Credence { en, .. } = &v {
                    if en == "bool" {
                        return Value::Bool(variant == "true");
                    }
                }
                Value::Variant(variant)
            }
            Expr::Verify { arg, by } => {
                let subj = self.subject_of(arg, frame);
                self.eval_verify(arg, by, subj, frame, agent)
            }
            Expr::Quorum { .. } => Value::Credence { en: "bool".into(), dist: vec![("true".into(), 0.9), ("false".into(), 0.1)] },
            Expr::Pipe { source, func } => {
                let src = self.eval(source, frame, agent);
                if let Value::Array(xs) = src {
                    let mut out = Vec::new();
                    for x in xs {
                        out.push(self.apply_fn_value(func, x, frame, agent));
                    }
                    Value::Array(out)
                } else {
                    Value::Null
                }
            }
            Expr::Call { func, args } => self.eval_call(func, args, frame, agent),
            Expr::Query(q) => {
                if let Query::Match { query, .. } = &**q {
                    let _ = self.eval(query, frame, agent);
                }
                Value::Null // expression-form query: a result set we model as null
            }
        }
    }

    fn eval_call(&mut self, func: &Expr, args: &[Expr], frame: &mut HashMap<String, Value>, agent: Option<&str>) -> Value {
        let argv: Vec<Value> = args.iter().map(|a| self.eval(a, frame, agent)).collect();
        if let Expr::Name(n) = func {
            // tool call → the world seam
            if self.tools.contains_key(n) {
                return self.eval_tool(n, frame, agent);
            }
            match n.as_str() {
                "say" => {
                    if let Some(v) = argv.first() {
                        println!("{}", v.show());
                    }
                    return Value::Null;
                }
                "len" => {
                    if let Some(Value::Array(xs)) = argv.first() {
                        return Value::Int(xs.len() as i64);
                    }
                    if let Some(Value::Text(s)) = argv.first() {
                        return Value::Int(s.chars().count() as i64);
                    }
                    return Value::Int(0);
                }
                "all" => return Value::Bool(argv.iter().all(|v| v.truthy())),
                "any" => return Value::Bool(argv.iter().any(|v| v.truthy())),
                _ => {}
            }
            if let Some((params, body)) = self.fns.get(n).cloned() {
                let mut f = HashMap::new();
                for (p, v) in params.iter().zip(argv.iter()) {
                    f.insert(p.name.clone(), v.clone());
                }
                if let Flow::Return(v) = self.exec_block(&body, &mut f, agent) {
                    return v;
                }
                return Value::Null;
            }
        }
        Value::Null
    }

    fn apply_fn_value(&mut self, func: &Expr, arg: Value, frame: &mut HashMap<String, Value>, agent: Option<&str>) -> Value {
        if let Expr::Name(n) = func {
            if let Some((params, body)) = self.fns.get(n).cloned() {
                let mut f = HashMap::new();
                if let Some(p) = params.first() {
                    f.insert(p.name.clone(), arg);
                }
                if let Flow::Return(v) = self.exec_block(&body, &mut f, agent) {
                    return v;
                }
            }
        }
        let _ = frame;
        Value::Null
    }

    /// A send: the provider seam (self-send = cognition) or IPC. Appends the
    /// `Sent → Delivered → Resolved` chain (§6), subjected at `subject`. The provider
    /// mode (§17.5) may instead crash (empty) or fault (schema violation).
    fn eval_send(&mut self, dest: &Expr, payload: &Expr, subject: Option<String>, slot: Option<&Type>, expires: Option<f64>, frame: &mut HashMap<String, Value>, agent: Option<&str>) -> Value {
        // The rendered prompt is the provider/LLM input — carried on `Sent` so the
        // studio can show what each agent actually asked.
        let prompt = self.eval(payload, frame, agent).show();
        let corr = self.ledger.fresh_corr();
        self.append("Sent", subject.clone(), prompt.clone(), Some(corr), agent.map(|a| a.to_string()));
        // Determine whether the destination has an open mailbox.
        let live = match dest {
            Expr::SelfRef => true,
            Expr::Name(n) => self.agents.get(n).map(|a| a.awake).unwrap_or(false),
            _ => true,
        };
        if !live {
            // A lifetime that elapses before Delivered appends an Expired tombstone —
            // NOT an Error subtype (§6, §9); a bare lost send just stalls at Sent.
            if expires.is_some() {
                self.append("Expired", subject.clone(), "expired".into(), Some(corr), agent.map(|a| a.to_string()));
            }
            return Value::Null;
        }
        // An empty provider response is an unrecoverable seam failure → crash (§5).
        if self.config.provider == ProviderMode::Empty {
            self.crash_agent(agent);
            return Value::Null;
        }
        self.append("Delivered", subject.clone(), "delivered".into(), Some(corr), None);
        // Structured output that fails constrained decoding raises a clean,
        // catchable/retryable TypeMismatch instead of resolving (§8, §16.6).
        if self.config.provider == ProviderMode::SchemaViolation && self.slot_is_structured(slot) {
            self.emit_event("TypeMismatch", subject.clone(), "schema_violation".into(), agent.map(|a| a.to_string()));
            self.faulted = true;
            return Value::Null;
        }
        // The reply is the provider/LLM output: a graded judgment for a Credence
        // slot (shown as `top@p`), else the raw text. A live provider is called
        // here; otherwise the deterministic mock answers.
        let reply = self.provider_reply(&prompt, slot);
        self.append("Resolved", subject.clone(), reply_summary(&reply), Some(corr), None);
        // The eager memory trigger: a received `<-` auto-internalizes (§16.7, §17).
        if self.config.internalize_on_receive {
            self.emit_event("Internalized", subject.clone(), "internalized".into(), agent.map(|a| a.to_string()));
        }
        reply
    }

    /// True if a reply slot requires structured decoding (an `event<Struct>` or a
    /// bare struct) — the slots a schema violation can fault on.
    fn slot_is_structured(&self, slot: Option<&Type>) -> bool {
        match slot {
            Some(Type::Event(inner)) => matches!(&**inner, Type::Named(n) if self.structs.contains_key(n)),
            Some(Type::Named(n)) => self.structs.contains_key(n),
            _ => false,
        }
    }

    /// An unrecoverable seam failure crashes the agent: `AgentCrashed` is recorded,
    /// the `on crash` hook runs, and state survives — a crash is contained (§5).
    fn crash_agent(&mut self, agent: Option<&str>) {
        let Some(a) = agent else { return };
        self.append("AgentCrashed", Some(a.to_string()), a.to_string(), None, Some(a.to_string()));
        if let Some(tname) = self.agents.get(a).map(|s| s.template.clone()) {
            if let Some(t) = self.templates.get(&tname).cloned() {
                self.run_hooks(&t, "crash", a);
            }
        }
    }

    fn eval_tool(&mut self, tool: &str, _frame: &mut HashMap<String, Value>, agent: Option<&str>) -> Value {
        let corr = self.ledger.fresh_corr();
        self.append("ToolStarted", Some(tool.to_string()), tool.to_string(), Some(corr), agent.map(|a| a.to_string()));
        let ret = self.tools.get(tool).cloned().flatten();
        let v = self.mock_of_type(ret.as_ref());
        self.append("ToolResolved", Some(tool.to_string()), v.show(), Some(corr), None);
        v
    }

    /// The gate `verify e [by basis]` (§13): collapse + record. Over an in-hand
    /// `Credence` it is synchronous (a single `Verification`); `by <principal>`
    /// is the async identity seam (an `Attestation`).
    fn eval_verify(&mut self, arg: &Expr, by: &Option<GateBasis>, subject: Option<String>, frame: &mut HashMap<String, Value>, agent: Option<&str>) -> Value {
        // Identity-seam gate: verify e by <principal>.
        if let Some(GateBasis::Value(e)) = by {
            if let Value::Principal(_) = self.eval(e, frame, agent) {
                let corr = self.ledger.fresh_corr();
                self.append("AttestStarted", subject.clone(), "attest".into(), Some(corr), agent.map(|a| a.to_string()));
                self.emit_event("Attestation", subject.clone(), "attested".into(), agent.map(|a| a.to_string()));
                return Value::Null;
            }
        }
        let v = self.eval(arg, frame, agent);
        let variant = self.decide_variant(&v, frame);
        let pass = variant == "Pass" || variant == "true" || variant == "Entails";
        let etype = if pass { "SuccessfulVerification" } else { "FailedVerification" };
        self.emit_event(etype, subject.clone(), variant.clone(), agent.map(|a| a.to_string()));
        if variant == "Contradicts" {
            self.emit_event("Contradiction", subject, "Contradicts".into(), agent.map(|a| a.to_string()));
        }
        Value::Null
    }

    // ── mock seam + helpers ──────────────────────────────────────────────────

    /// The provider's answer to a send: a live model (via the agent-server) when
    /// `provider_url` is set, else the deterministic mock. A `Credence` slot uses
    /// the sampling fallback (§16.8) — no logprobs needed. Any transport failure
    /// degrades gracefully to the mock so a run never hard-fails on the seam.
    fn provider_reply(&mut self, prompt: &str, slot: Option<&Type>) -> Value {
        let Some(addr) = self.config.provider_url.clone() else {
            return self.mock_of_type(slot);
        };
        match slot {
            Some(Type::Credence(inner)) => {
                let en = type_enum_name(inner);
                let variants: Vec<String> = match en.as_str() {
                    "bool" => vec!["true".into(), "false".into()],
                    other => self.enums.get(other).cloned().unwrap_or_default(),
                };
                if variants.is_empty() {
                    return self.mock_of_type(slot);
                }
                let samples = if self.config.samples == 0 { 5 } else { self.config.samples };
                // line 2: `samples [temperature]` — temperature omitted ⇒ provider default.
                let line2 = if self.config.temperature > 0.0 {
                    format!("{} {}", samples, self.config.temperature)
                } else {
                    samples.to_string()
                };
                let body = format!("{}\n{}\n{}", variants.join(","), line2, prompt);
                match http_post(&addr, "/provider/judge", &body) {
                    Some(resp) => Value::Credence { en, dist: parse_dist(&resp, &variants) },
                    None => self.mock_of_type(slot),
                }
            }
            _ => match http_post(&addr, "/provider/text", prompt) {
                Some(text) => Value::Text(text.trim().to_string()),
                None => self.mock_of_type(slot),
            },
        }
    }

    fn mock_of_type(&self, ty: Option<&Type>) -> Value {
        match ty {
            Some(Type::Int) => Value::Int(0),
            Some(Type::Float) => Value::Float(0.0),
            Some(Type::Bool) => Value::Bool(true),
            Some(Type::Text) | None => Value::Text("ok".into()),
            Some(Type::Null) => Value::Null,
            Some(Type::Credence(inner)) => {
                let en = type_enum_name(inner);
                let variants: Vec<String> = match en.as_str() {
                    "bool" => vec!["true".into(), "false".into()],
                    other => self.enums.get(other).cloned().unwrap_or_default(),
                };
                // A scripted provider distribution (§17.5 `provider: credence(…)`)
                // overrides the mock — the reproducible way to exercise a gate boundary.
                if let Some(script) = &self.config.credence {
                    return Value::Credence { en, dist: script.clone() };
                }
                if variants.is_empty() {
                    return Value::Credence { en, dist: vec![] };
                }
                // A confident mock judgment: the peak variant 0.9, the rest share 0.1.
                // `Entailment` peaks on `Contradicts` — the deterministic conformance
                // choice that exercises the Contradiction channel (§8).
                let peak = if en == "Entailment" { "Contradicts" } else { variants[0].as_str() };
                let rest = ((variants.len() - 1).max(1)) as f64;
                let dist = variants
                    .iter()
                    .map(|v| (v.clone(), if v == peak { 0.9 } else { 0.1 / rest }))
                    .collect();
                Value::Credence { en, dist }
            }
            _ => Value::Text("ok".into()),
        }
    }

    /// Collapse a value to a variant name: a `Credence`'s arg-max, a `Variant`
    /// as-is, a `Bool` to `"true"`/`"false"`.
    fn decide_variant(&self, v: &Value, _frame: &HashMap<String, Value>) -> String {
        match v {
            Value::Credence { en, dist } => {
                if let Some((best, _)) = dist.iter().max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal)) {
                    best.clone()
                } else {
                    // empty mock distribution → the enum's first variant (or Pass/true).
                    self.enums.get(en).and_then(|vs| vs.first().cloned()).unwrap_or_else(|| "Pass".into())
                }
            }
            Value::Variant(s) => s.clone(),
            Value::Bool(b) => if *b { "true".into() } else { "false".into() },
            _ => "Pass".into(),
        }
    }

    fn subject_of(&self, e: &Expr, frame: &HashMap<String, Value>) -> Option<String> {
        match e {
            Expr::Name(n) => Some(n.clone()),
            Expr::SelfRef => Some("self".into()),
            // A gate's subject is the credence it collapses (`endorse(c by R)` → `c`).
            Expr::Collapse { expr, .. } | Expr::Decide { expr, .. } | Expr::EndorseExpr { arg: expr, .. } => {
                self.subject_of(expr, frame)
            }
            _ => None,
        }
    }

    /// The gate verdict: `Some(variant)` to commit, `None` to abstain. Applies the
    /// rule's threshold and margin floor; a conformal rule abstains at cold start (§13).
    fn decide_gate(&self, v: &Value, rule: &GateBasis) -> Option<String> {
        let pr = self.resolve_rule(rule);
        if pr.conformal {
            return None; // no recorded labels yet → below the readiness floor → abstain
        }
        match v {
            Value::Credence { dist, .. } => {
                let mut sorted = dist.clone();
                sorted.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
                let (name, p0) = sorted.first()?;
                let p1 = sorted.get(1).map(|x| x.1).unwrap_or(0.0);
                if *p0 >= pr.threshold && (p0 - p1) >= pr.margin {
                    Some(name.clone())
                } else {
                    None // threshold unmet or margin below floor → abstain
                }
            }
            other => Some(self.decide_variant(other, &HashMap::new())),
        }
    }

    /// Resolve a gate rule to its runtime policy: an inline threshold/margin, a
    /// conformal basis, or a named `policy` block (§13).
    fn resolve_rule(&self, rule: &GateBasis) -> PolicyRule {
        match rule {
            GateBasis::Threshold { value, margin, .. } => PolicyRule { threshold: *value, margin: *margin, conformal: false },
            GateBasis::Conformal { .. } => PolicyRule { conformal: true, ..Default::default() },
            GateBasis::Value(e) => {
                if let Expr::Name(n) = &**e {
                    if let Some(p) = self.policies.get(n) {
                        return p.clone();
                    }
                }
                PolicyRule { threshold: 0.5, margin: 0.0, conformal: false }
            }
        }
    }

    fn binop(&self, op: BinOp, l: Value, r: Value) -> Value {
        use Value::*;
        match op {
            BinOp::Add => match (l, r) {
                (Int(a), Int(b)) => Int(a + b),
                (Float(a), Float(b)) => Float(a + b),
                (Int(a), Float(b)) => Float(a as f64 + b),
                (Float(a), Int(b)) => Float(a + b as f64),
                (Text(a), b) => Text(a + &b.show()),
                (a, Text(b)) => Text(a.show() + &b),
                _ => Null,
            },
            BinOp::Sub => num2(l, r, |a, b| a - b, |a, b| a - b),
            BinOp::Mul => num2(l, r, |a, b| a * b, |a, b| a * b),
            BinOp::Div => match (l, r) {
                (Int(a), Int(b)) if b != 0 => Int(a / b),
                (Float(a), Float(b)) if b != 0.0 => Float(a / b),
                (Int(a), Float(b)) if b != 0.0 => Float(a as f64 / b),
                (Float(a), Int(b)) if b != 0 => Float(a / b as f64),
                _ => Null,
            },
            BinOp::Eq => Bool(values_eq(&l, &r)),
            BinOp::Ne => Bool(!values_eq(&l, &r)),
            BinOp::Lt => cmp(l, r, |o| o == std::cmp::Ordering::Less),
            BinOp::Gt => cmp(l, r, |o| o == std::cmp::Ordering::Greater),
            BinOp::Le => cmp(l, r, |o| o != std::cmp::Ordering::Greater),
            BinOp::Ge => cmp(l, r, |o| o != std::cmp::Ordering::Less),
        }
    }

    fn interp_fstring(&mut self, raw: &str, frame: &mut HashMap<String, Value>, agent: Option<&str>) -> String {
        let mut out = String::new();
        let chars: Vec<char> = raw.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            if chars[i] == '{' {
                let mut depth = 1;
                let mut inner = String::new();
                i += 1;
                while i < chars.len() && depth > 0 {
                    if chars[i] == '{' {
                        depth += 1;
                    } else if chars[i] == '}' {
                        depth -= 1;
                        if depth == 0 {
                            break;
                        }
                    }
                    inner.push(chars[i]);
                    i += 1;
                }
                i += 1; // closing brace
                let v = lex(&inner).ok().and_then(|t| parse_expr(t).ok()).map(|e| self.eval(&e, frame, agent)).unwrap_or(Value::Null);
                out.push_str(&v.show());
            } else {
                out.push(chars[i]);
                i += 1;
            }
        }
        out
    }

    fn merge_back(&mut self, frame: &mut HashMap<String, Value>, inner: HashMap<String, Value>) {
        for (k, v) in inner {
            if frame.contains_key(&k) {
                frame.insert(k, v);
            }
        }
    }

    fn append(&mut self, etype: &str, subject: Option<String>, payload: String, corr: Option<u64>, agent: Option<String>) -> u64 {
        self.ledger.append(etype, subject, payload, corr, agent)
    }
}

/// A minimal HTTP/1.1 POST to a localhost service (zero-dep: just `std::net`).
/// `Connection: close` lets us read to EOF; the body follows the blank line. Any
/// error returns `None` so the caller can fall back to the mock seam.
fn http_post(addr: &str, path: &str, body: &str) -> Option<String> {
    let mut stream = TcpStream::connect(addr).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(120))).ok()?;
    stream.set_write_timeout(Some(Duration::from_secs(30))).ok()?;
    let host = addr.split(':').next().unwrap_or("127.0.0.1");
    let req = format!(
        "POST {path} HTTP/1.1\r\nHost: {host}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.as_bytes().len()
    );
    stream.write_all(req.as_bytes()).ok()?;
    let mut buf = Vec::new();
    stream.read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf);
    let idx = text.find("\r\n\r\n")?;
    Some(text[idx + 4..].to_string())
}

/// Parse the judge response (`variant prob` per line) into a distribution over the
/// requested variants (missing variants → 0.0).
fn parse_dist(resp: &str, variants: &[String]) -> Vec<(String, f64)> {
    let mut got: HashMap<String, f64> = HashMap::new();
    for line in resp.lines() {
        // `variant prob` — split off the trailing probability token.
        if let Some((name, p)) = line.trim().rsplit_once(' ') {
            if let Ok(p) = p.trim().parse::<f64>() {
                got.insert(name.trim().to_string(), p);
            }
        }
    }
    variants.iter().map(|v| (v.clone(), got.get(v).copied().unwrap_or(0.0))).collect()
}

/// Summarize a provider reply for the ledger payload: a graded judgment shows its
/// top variant and probability (`true 0.90`); anything else shows as itself.
fn reply_summary(v: &Value) -> String {
    match v {
        Value::Credence { dist, .. } => match dist.iter().max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal)) {
            Some((name, p)) => format!("{name} {p:.2}"),
            None => "?".into(),
        },
        other => other.show(),
    }
}

fn type_enum_name(t: &Type) -> String {
    match t {
        Type::Bool => "bool".into(),
        Type::Named(n) => n.clone(),
        _ => "bool".into(),
    }
}

/// The ledger event-type a `when (Type …)` subscribes to: a nominal type name, or
/// the inner type of an `event<T>` wrapper.
fn type_event_name(t: &Type) -> Option<String> {
    match t {
        Type::Named(n) => Some(n.clone()),
        Type::Event(inner) => type_event_name(inner),
        _ => None,
    }
}

fn num2(l: Value, r: Value, fi: impl Fn(i64, i64) -> i64, ff: impl Fn(f64, f64) -> f64) -> Value {
    use Value::*;
    match (l, r) {
        (Int(a), Int(b)) => Int(fi(a, b)),
        (Float(a), Float(b)) => Float(ff(a, b)),
        (Int(a), Float(b)) => Float(ff(a as f64, b)),
        (Float(a), Int(b)) => Float(ff(a, b as f64)),
        _ => Null,
    }
}

fn cmp(l: Value, r: Value, f: impl Fn(std::cmp::Ordering) -> bool) -> Value {
    use Value::*;
    let ord = match (&l, &r) {
        (Int(a), Int(b)) => a.partial_cmp(b),
        (Float(a), Float(b)) => a.partial_cmp(b),
        (Int(a), Float(b)) => (*a as f64).partial_cmp(b),
        (Float(a), Int(b)) => a.partial_cmp(&(*b as f64)),
        (Text(a), Text(b)) => a.partial_cmp(b),
        _ => None,
    };
    Value::Bool(ord.map(f).unwrap_or(false))
}

fn values_eq(l: &Value, r: &Value) -> bool {
    use Value::*;
    match (l, r) {
        (Int(a), Int(b)) => a == b,
        (Float(a), Float(b)) => a == b,
        (Bool(a), Bool(b)) => a == b,
        (Text(a), Text(b)) => a == b,
        (Null, Null) => true,
        (Variant(a), Variant(b)) => a == b,
        (Bool(a), Variant(b)) | (Variant(b), Bool(a)) => (if *a { "true" } else { "false" }) == b,
        _ => false,
    }
}

/// Event-type subtyping (§9): `Error` is the root; `Verification` covers its
/// outcomes. Used by both subscription firing and the conformance matcher.
pub fn is_subtype(actual: &str, pattern: &str) -> bool {
    if actual == pattern {
        return true;
    }
    match pattern {
        "Error" => matches!(
            actual,
            "FailedVerification" | "Contradiction" | "TypeMismatch" | "RetryExhausted" | "FailedAttestation" | "Violation"
        ),
        "Verification" => matches!(actual, "SuccessfulVerification" | "FailedVerification"),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::parse;

    fn etypes(src: &str) -> Vec<String> {
        let ast = parse(lex(src).unwrap()).unwrap();
        run(&ast).log.into_iter().map(|e| e.etype).collect()
    }

    #[test]
    fn lifecycle_events() {
        let e = etypes("agent A { on sleep { emit Event(\"x\"); } } spawn A a; awake a; sleep a;");
        assert_eq!(e, vec!["Spawned", "AgentAwake", "SleepEvent", "Event"]);
    }

    #[test]
    fn spawn_is_inert() {
        let e = etypes("agent A { on awake { emit Event(\"x\"); } } spawn A a;");
        assert_eq!(e, vec!["Spawned"]); // never awoken → ctor/hook never run
    }

    #[test]
    fn send_chain_and_subject() {
        let ast = parse(lex("agent A {} spawn A a; awake a; event<text> r = a <- \"hi\";").unwrap()).unwrap();
        let log = run(&ast).log;
        assert!(log.iter().any(|e| e.etype == "Sent" && e.subject.as_deref() == Some("r")));
        assert!(log.iter().any(|e| e.etype == "Resolved" && e.subject.as_deref() == Some("r")));
    }

    #[test]
    fn tool_pair_subjected_at_tool() {
        let ast = parse(lex("read tool text search(text q); agent R grants { use search } { text h = search(\"q\"); } spawn R r; awake r;").unwrap()).unwrap();
        let log = run(&ast).log;
        assert!(log.iter().any(|e| e.etype == "ToolStarted" && e.subject.as_deref() == Some("search")));
        assert!(log.iter().any(|e| e.etype == "ToolResolved" && e.subject.as_deref() == Some("search")));
    }

    #[test]
    fn query_statement_lands_result() {
        let e = etypes("select * from ledger where { etype: \"Spawned\" };");
        assert_eq!(e, vec!["QueryResult"]);
    }

    #[test]
    fn say_is_not_on_the_ledger() {
        assert!(etypes("say(\"hello\");").is_empty());
    }

    #[test]
    fn while_break_terminates() {
        // exercises loop-carried mutation + break (somatic kernel)
        let e = etypes("int i = 0; while (true) { if (i == 3) { break; } i = i + 1; }");
        assert!(e.is_empty());
    }
}
