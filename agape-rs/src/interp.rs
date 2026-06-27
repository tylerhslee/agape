//! The tree-walking interpreter + runtime (M4) — SPEC-1.0 §15.4.
//!
//! Runs a checked program top-to-bottom to quiescence, driving the spine. The
//! three seams (provider/identity/tool) are deterministic **mocks** here: the
//! conformance suite asserts the *committed* spine shape (event types + subjects:
//! lifecycle, the `Sent/Delivered/Resolved` send chain, `ToolStarted/ToolResolved`
//! tool pairs, `Verification`/`Contradiction` gate verdicts, `QueryResult`,
//! `PromptOpened`), not the stochastic wording, so a fixed mock suffices and keeps
//! runs reproducible. A real provider swaps in behind the same seam.
//!
//! The interpreter is deliberately fail-soft: an unresolved name or operation
//! evaluates to `null` rather than crashing, so a well-formed program always runs
//! to a spine.

use std::collections::HashMap;

use crate::ast::*;
use crate::lexer::lex;
use crate::parser::parse_expr;
use crate::spine::Spine;

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
    reg_tick: u64,
    agent: Option<String>,
}

pub struct Interp {
    spine: Spine,
    templates: HashMap<String, Template>,
    fns: HashMap<String, (Vec<Param>, Vec<Stmt>)>,
    structs: HashMap<String, Vec<Field>>,
    enums: HashMap<String, Vec<String>>,
    tools: HashMap<String, Option<Type>>,
    authority: std::collections::HashSet<String>,
    agents: HashMap<String, AgentState>,
    subs: Vec<Sub>,
    fired: std::collections::HashSet<(usize, u64)>,
    fire_budget: u32,
    eph: u64,
}

/// Run a checked AST to quiescence; return the produced spine.
pub fn run(stmts: &[Stmt]) -> Spine {
    let mut it = Interp::new();
    it.collect(stmts);
    let mut frame = HashMap::new();
    it.exec_block(stmts, &mut frame, None);
    it.spine
}

impl Interp {
    fn new() -> Self {
        Interp {
            spine: Spine::new(),
            templates: HashMap::new(),
            fns: HashMap::new(),
            structs: HashMap::new(),
            enums: HashMap::new(),
            tools: HashMap::new(),
            authority: std::collections::HashSet::new(),
            agents: HashMap::new(),
            subs: Vec::new(),
            fired: std::collections::HashSet::new(),
            fire_budget: 10_000,
            eph: 0,
        }
    }

    fn collect(&mut self, stmts: &[Stmt]) {
        for s in stmts {
            match s {
                Stmt::AgentDecl { name, params, body, .. } => {
                    self.templates.insert(name.clone(), Template { params: params.clone(), body: body.clone() });
                }
                Stmt::FnDecl { name, params, body, .. } => {
                    self.fns.insert(name.clone(), (params.clone(), body.clone()));
                }
                Stmt::StructDecl { name, fields } => {
                    self.structs.insert(name.clone(), fields.clone());
                }
                Stmt::EnumDecl { name, variants } => {
                    self.enums.insert(name.clone(), variants.clone());
                }
                Stmt::ToolDecl { name, ret, .. } => {
                    self.tools.insert(name.clone(), ret.clone());
                }
                Stmt::Authority(name) => {
                    self.authority.insert(name.clone());
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
            Stmt::VarDecl { name, expr, .. } => {
                let v = match expr {
                    Some(init) => self.eval_bound(init, name, frame, agent),
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
            Stmt::Spawn { agent_type, name } => {
                self.agents.insert(
                    name.clone(),
                    AgentState { template: agent_type.clone(), awake: false, constructed: false, fields: HashMap::new() },
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
                // No external input is fed in conformance mode → the sensor opens
                // and the program quiesces (EOF).
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
            Stmt::Endorse { arg, arms, abstain, .. } => {
                // collapse the Credence, record the Decision, dispatch the arm (§13).
                let v = self.eval(arg, frame, agent);
                let variant = self.decide_variant(&v, frame);
                let subj = self.subject_of(arg, frame);
                let mut chosen: Option<&Vec<Stmt>> = None;
                for (label, body) in arms {
                    if *label == variant {
                        chosen = Some(body);
                        break;
                    }
                }
                if let Some(body) = chosen {
                    self.emit_event("Decided", subj, variant, agent.map(|a| a.to_string()));
                    if let Flow::Return(v) = self.exec_block(body, frame, agent) {
                        return Flow::Return(v);
                    }
                } else {
                    // no matching arm ⇒ the gate could not commit a singleton ⇒ abstain.
                    self.emit_event("Abstained", subj, String::new(), agent.map(|a| a.to_string()));
                    if let Some(b) = abstain {
                        if let Flow::Return(v) = self.exec_block(b, frame, agent) {
                            return Flow::Return(v);
                        }
                    }
                }
            }
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
            Stmt::When { event_type, subject, body } => {
                let subj = self.subject_of(subject, frame);
                self.register_sub(event_type.clone(), subj, body.clone(), None, frame, agent);
            }
            Stmt::Catch { event_type, subject, binding, body } => {
                let subj = subject.as_ref().and_then(|s| self.subject_of(s, frame));
                self.register_sub(event_type.clone(), subj, body.clone(), Some(binding.clone()), frame, agent);
            }
            Stmt::On { .. } | Stmt::Extend { .. } => { /* handled during awake */ }
            Stmt::Retry(tail) => {
                if let RetryTail::Bounded { body, .. } = tail {
                    return self.exec_block(body, frame, agent);
                }
                // Predicate (unbounded) retry: not exercised by the v1.0 suite.
            }
            Stmt::QueryStmt(q) => {
                let subj = match q {
                    Query::Select { source, .. } => Some(source.clone()),
                    Query::Find { .. } => Some("spine".to_string()),
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
            | Stmt::ModuleAttr { .. } => {}
        }
        Flow::Normal
    }

    // ── agent lifecycle ──────────────────────────────────────────────────────

    fn awake_agent(&mut self, name: &str, args: Vec<Value>) {
        let Some(state) = self.agents.get(name) else { return };
        let tname = state.template.clone();
        let first = !state.constructed;
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
            reg_tick: self.spine.len() as u64,
            agent: agent.map(|a| a.to_string()),
        });
    }

    /// Append an event and fire any matching prospective subscription.
    fn emit_event(&mut self, etype: &str, subject: Option<String>, payload: String, agent: Option<String>) {
        let tick = self.append(etype, subject.clone(), payload, None, agent);
        self.fire_subs(tick, etype, &subject);
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
                    && s.etype.as_deref().map(|t| is_subtype(etype, t)).unwrap_or(true)
                    && match (&s.subject, subject) {
                        (Some(a), Some(b)) => a == b,
                        (Some(_), None) => false,
                        (None, _) => true,
                    }
            })
            .map(|(i, _)| i)
            .collect();
        for i in candidates {
            self.fired.insert((i, tick));
            if self.fire_budget == 0 {
                break;
            }
            self.fire_budget -= 1;
            let sub = self.subs[i].clone();
            let mut frame = sub.frame.clone();
            if let Some(b) = &sub.binding {
                frame.insert(b.clone(), Value::Text(etype.to_string()));
            }
            let _ = self.exec_block(&sub.body, &mut frame, sub.agent.as_deref());
        }
    }

    // ── expression evaluation ────────────────────────────────────────────────

    /// Evaluate an initializer whose spine events should be subjected at the
    /// binding name (a send chain, an in-hand verify).
    fn eval_bound(&mut self, e: &Expr, name: &str, frame: &mut HashMap<String, Value>, agent: Option<&str>) -> Value {
        match e {
            Expr::Send { dest, payload, .. } => self.eval_send(dest, payload, Some(name.to_string()), frame, agent),
            Expr::Verify { arg, by } => self.eval_verify(arg, by, Some(name.to_string()), frame, agent),
            other => self.eval(other, frame, agent),
        }
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
            Expr::Send { dest, payload, .. } => {
                let subj = self.ephemeral();
                self.eval_send(dest, payload, Some(subj), frame, agent)
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
    /// `Sent → Delivered → Resolved` chain (§6), subjected at `subject`.
    fn eval_send(&mut self, dest: &Expr, payload: &Expr, subject: Option<String>, frame: &mut HashMap<String, Value>, agent: Option<&str>) -> Value {
        let _ = self.eval(payload, frame, agent); // render the prompt (incidental)
        let corr = self.spine.fresh_corr();
        self.append("Sent", subject.clone(), "sent".into(), Some(corr), agent.map(|a| a.to_string()));
        // Determine whether the destination has an open mailbox.
        let live = match dest {
            Expr::SelfRef => true,
            Expr::Name(n) => self.agents.get(n).map(|a| a.awake).unwrap_or(false),
            _ => true,
        };
        if !live {
            return Value::Null; // lost: the chain stalls at Sent (§6)
        }
        self.append("Delivered", subject.clone(), "delivered".into(), Some(corr), None);
        let reply = self.mock_reply();
        self.append("Resolved", subject.clone(), reply.show(), Some(corr), None);
        reply
    }

    fn eval_tool(&mut self, tool: &str, _frame: &mut HashMap<String, Value>, agent: Option<&str>) -> Value {
        let corr = self.spine.fresh_corr();
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
                let corr = self.spine.fresh_corr();
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

    fn mock_reply(&self) -> Value {
        Value::Text("ok".into())
    }

    fn mock_of_type(&self, ty: Option<&Type>) -> Value {
        match ty {
            Some(Type::Int) => Value::Int(0),
            Some(Type::Float) => Value::Float(0.0),
            Some(Type::Bool) => Value::Bool(true),
            Some(Type::Text) | None => Value::Text("ok".into()),
            Some(Type::Null) => Value::Null,
            Some(Type::Credence(inner)) => Value::Credence { en: type_enum_name(inner), dist: vec![] },
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

    fn subject_of(&self, e: &Expr, _frame: &HashMap<String, Value>) -> Option<String> {
        match e {
            Expr::Name(n) => Some(n.clone()),
            Expr::SelfRef => Some("self".into()),
            _ => None,
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
        self.spine.append(etype, subject, payload, corr, agent)
    }
}

fn type_enum_name(t: &Type) -> String {
    match t {
        Type::Bool => "bool".into(),
        Type::Named(n) => n.clone(),
        _ => "bool".into(),
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
        let e = etypes("select * from spine where { etype: \"Spawned\" };");
        assert_eq!(e, vec!["QueryResult"]);
    }

    #[test]
    fn say_is_not_on_the_spine() {
        assert!(etypes("say(\"hello\");").is_empty());
    }

    #[test]
    fn while_break_terminates() {
        // exercises loop-carried mutation + break (somatic kernel)
        let e = etypes("int i = 0; while (true) { if (i == 3) { break; } i = i + 1; }");
        assert!(e.is_empty());
    }
}
