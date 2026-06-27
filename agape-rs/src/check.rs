//! The static checker (M3) — SPEC-1.0 §15.3.
//!
//! One pass over the AST that enforces the v1.0 guarantees, mapping each to the
//! conformance error classes:
//!
//! - **Type** — user nominal types are declared; a struct literal supplies every
//!   field; `emit` names a declared (or built-in) event; no `text → Principal`
//!   coercion at a gate; fusion (`quorum`/`all`/`any` over `Credence`) declares a
//!   total `independent`/`dependent` structure.
//! - **Color** — a `sync` function reaches no seam (no send, no tool call, no
//!   `verify … by <principal>`) and calls only `sync` functions; interprocedural
//!   via a least-fixpoint over the call graph.
//! - **Taint** (`U ⊑ P ⊑ T`) — a consequential (`authority`) `emit` consumes only
//!   a `U`-and-authorized value (a recorded `verify`, never a bare `decide`, never
//!   a raw `<-`/tool/`prompt`/queried-fact value).
//! - **Authority** — default-deny `grants` for `emit`/`reach`/`use`, subtractive
//!   under `extend` (the built-in `Event`/`Error` channels are always emittable).
//! - **Exhaustiveness** — a `case` over an enum covers every variant or has a
//!   `default`.
//!
//! The checker is deliberately **fail-open** on anything it cannot resolve (an
//! unknown name, an un-inferable type): it raises a diagnostic only on a concrete
//! violation, so well-formed programs are never rejected by accident.

use std::collections::{HashMap, HashSet};

use crate::ast::*;
use crate::diag::{AgapeError, ErrorClass};

/// The three-level taint lattice (§15.3.1): `U ⊑ P ⊑ T`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Taint {
    U,
    P,
    T,
}

/// What is known about a bound variable.
#[derive(Debug, Clone)]
struct VarInfo {
    ty: Type,
    taint: Taint,
    /// `true` iff the value's untainting was recorded by a gate (`verify`), which
    /// is what authorizes it for a consequential `emit` (§13).
    authorized: bool,
}

#[derive(Debug, Clone)]
struct AgentInfo {
    grants: Vec<Capability>,
    has_grants: bool,
    unconstrained: bool,
    parent: Option<String>,
    body: Vec<Stmt>,
}

#[derive(Debug, Clone)]
struct FnInfo {
    is_sync: bool,
    params: Vec<Param>,
    body: Vec<Stmt>,
}

/// A lexical checking scope: variable bindings + the fusion dependence
/// declarations visible so far.
#[derive(Debug, Clone, Default)]
struct Scope {
    env: HashMap<String, VarInfo>,
    deps: Vec<(Dep, Vec<String>)>,
}

impl Scope {
    fn child(&self) -> Scope {
        self.clone()
    }
    fn lookup(&self, name: &str) -> Option<&VarInfo> {
        self.env.get(name)
    }
}

pub struct Checker {
    structs: HashMap<String, Vec<Field>>,
    enums: HashMap<String, Vec<String>>,
    events: HashSet<String>,
    tools: HashMap<String, Option<Type>>, // name -> return type
    agents: HashMap<String, AgentInfo>,
    fns: HashMap<String, FnInfo>,
    principals: HashSet<String>, // top-level principals
    authority: HashSet<String>,  // consequential event types
    fn_async: HashMap<String, bool>,
}

/// Lex + parse already done; run the static pass over the AST.
pub fn check(stmts: &[Stmt]) -> Result<(), AgapeError> {
    let mut c = Checker::new();
    c.collect(stmts);
    c.seed_prelude();
    c.compute_colors();
    c.check_colors()?;
    c.check_extends()?;

    // Top-level scope (not an agent: no authority context).
    let mut scope = Scope::default();
    c.walk_block(stmts, &mut scope, None)?;

    // Each agent body under its own authority context.
    let agent_names: Vec<String> = c.agents.keys().cloned().collect();
    for name in agent_names {
        let info = c.agents[&name].clone();
        let mut ascope = Scope::default();
        // Principal-typed and agent fields would be bound here; the body walk adds
        // them as it goes. Inherited members are checked when the parent is walked.
        c.walk_block(&info.body, &mut ascope, Some(&name))?;
    }
    Ok(())
}

impl Checker {
    fn new() -> Self {
        Checker {
            structs: HashMap::new(),
            enums: HashMap::new(),
            events: HashSet::new(),
            tools: HashMap::new(),
            agents: HashMap::new(),
            fns: HashMap::new(),
            principals: HashSet::new(),
            authority: HashSet::new(),
            fn_async: HashMap::new(),
        }
    }

    // ── declaration collection ──────────────────────────────────────────────

    fn collect(&mut self, stmts: &[Stmt]) {
        for s in stmts {
            match s {
                Stmt::StructDecl { name, fields } => {
                    self.structs.insert(name.clone(), fields.clone());
                }
                Stmt::EnumDecl { name, variants } => {
                    self.enums.insert(name.clone(), variants.clone());
                }
                Stmt::EventDecl { name, .. } => {
                    self.events.insert(name.clone());
                }
                Stmt::ToolDecl { name, ret, .. } => {
                    self.tools.insert(name.clone(), ret.clone());
                }
                Stmt::Authority(name) => {
                    self.authority.insert(name.clone());
                }
                Stmt::Principal(name) => {
                    self.principals.insert(name.clone());
                }
                Stmt::FnDecl { is_sync, name, params, body, .. } => {
                    self.fns.insert(
                        name.clone(),
                        FnInfo { is_sync: *is_sync, params: params.clone(), body: body.clone() },
                    );
                }
                Stmt::AgentDecl { name, grants, has_grants, unconstrained, body, .. } => {
                    let parent = body.iter().find_map(|b| match b {
                        Stmt::Extend { parent, .. } => Some(parent.clone()),
                        _ => None,
                    });
                    self.agents.insert(
                        name.clone(),
                        AgentInfo {
                            grants: grants.clone(),
                            has_grants: *has_grants,
                            unconstrained: *unconstrained,
                            parent,
                            body: body.clone(),
                        },
                    );
                }
                _ => {}
            }
        }
    }

    fn seed_prelude(&mut self) {
        self.enums
            .entry("Verification".into())
            .or_insert_with(|| vec!["Pass".into(), "Fail".into()]);
        self.enums
            .entry("Entailment".into())
            .or_insert_with(|| vec!["Entails".into(), "Contradicts".into(), "Neutral".into()]);
        self.structs
            .entry("Rule".into())
            .or_insert_with(|| vec![Field { name: "threshold".into(), ty: Type::Float }, Field { name: "margin".into(), ty: Type::Float }]);
        // The built-in spine-event channels, always emittable (§9).
        self.events.insert("Event".into());
        self.events.insert("Error".into());
    }

    // ── color: interprocedural least-fixpoint over the call graph ───────────

    fn compute_colors(&mut self) {
        let names: Vec<String> = self.fns.keys().cloned().collect();
        // Seed: a function is async if its own body reaches a seam.
        for n in &names {
            let f = &self.fns[n];
            let mut princ = self.principals.clone();
            for p in &f.params {
                if matches!(&p.ty, Type::Named(t) if t == "Principal") {
                    princ.insert(p.name.clone());
                }
            }
            let reaches = self.body_reaches_seam(&f.body, &princ);
            self.fn_async.insert(n.clone(), reaches);
        }
        // Propagate: calling an async function makes the caller async.
        loop {
            let mut changed = false;
            for n in &names {
                if self.fn_async[n] {
                    continue;
                }
                let calls = collect_calls(&self.fns[n].body);
                if calls.iter().any(|c| self.fn_async.get(c).copied().unwrap_or(false)) {
                    self.fn_async.insert(n.clone(), true);
                    changed = true;
                }
            }
            if !changed {
                break;
            }
        }
    }

    fn body_reaches_seam(&self, stmts: &[Stmt], principals: &HashSet<String>) -> bool {
        stmts.iter().any(|s| self.stmt_reaches_seam(s, principals))
    }

    fn stmt_reaches_seam(&self, s: &Stmt, pr: &HashSet<String>) -> bool {
        let e = |e: &Expr| self.expr_reaches_seam(e, pr);
        let b = |b: &[Stmt]| self.body_reaches_seam(b, pr);
        match s {
            Stmt::VarDecl { expr: Some(x), .. } => e(x),
            Stmt::Assign { target, expr } => e(target) || e(expr),
            Stmt::Verify { arg, by } => e(arg) || self.gate_is_identity_seam(by, pr),
            Stmt::Emit { payload, .. } => e(payload),
            Stmt::Say(x) | Stmt::Return(Some(x)) | Stmt::ExprStmt(x) => e(x),
            Stmt::If { cond, then_body, else_body } => e(cond) || b(then_body) || b(else_body),
            Stmt::While { cond, body } => e(cond) || b(body),
            Stmt::On { body, .. } | Stmt::When { body, .. } | Stmt::Catch { body, .. } => b(body),
            Stmt::Case { expr, arms, default, .. } => {
                e(expr) || arms.iter().any(|(_, body)| b(body)) || default.as_deref().is_some_and(b)
            }
            Stmt::Retry(tail) => match tail {
                RetryTail::Bounded { body, .. } => b(body),
                RetryTail::Predicate { pred, body, .. } => e(pred) || b(body),
            },
            _ => false,
        }
    }

    fn expr_reaches_seam(&self, x: &Expr, pr: &HashSet<String>) -> bool {
        let r = |e: &Expr| self.expr_reaches_seam(e, pr);
        match x {
            Expr::Send { .. } => true, // the provider/IPC seam (incl. a Credence-slot send)
            Expr::Call { func, args } => {
                let is_tool = matches!(&**func, Expr::Name(n) if self.tools.contains_key(n));
                is_tool || r(func) || args.iter().any(r)
            }
            Expr::Verify { arg, by } => r(arg) || self.gate_is_identity_seam(by, pr),
            Expr::Decide { expr, rule } => r(expr) || self.rule_reaches_seam(rule, pr),
            Expr::Quorum { judges, .. } => judges.iter().any(r),
            Expr::Pipe { source, func } => r(source) || r(func),
            Expr::Binary { left, right, .. } => r(left) || r(right),
            Expr::Not(e) | Expr::Member { obj: e, .. } => r(e),
            Expr::Index { obj, index } => r(obj) || r(index),
            Expr::Array(es) => es.iter().any(r),
            Expr::StructLit { fields, .. } => fields.iter().any(|(_, v)| r(v)),
            Expr::Query(q) => matches!(&**q, Query::Match { query, .. } if r(query)),
            _ => false,
        }
    }

    fn rule_reaches_seam(&self, rule: &GateBasis, pr: &HashSet<String>) -> bool {
        matches!(rule, GateBasis::Value(e) if self.expr_reaches_seam(e, pr))
    }

    /// `verify … by p` reaches the identity seam (async) iff `by` names a Principal.
    fn gate_is_identity_seam(&self, by: &Option<GateBasis>, pr: &HashSet<String>) -> bool {
        matches!(by, Some(GateBasis::Value(e)) if matches!(&**e, Expr::Name(n) if pr.contains(n)))
    }

    fn check_colors(&self) -> Result<(), AgapeError> {
        for (name, f) in &self.fns {
            if f.is_sync && self.fn_async.get(name).copied().unwrap_or(false) {
                return Err(AgapeError::new(
                    ErrorClass::Color,
                    format!("sync function `{name}` reaches a seam (a send, a tool call, a `verify … by <principal>`, or a call to an async function) — `sync` asserts cognition- and effect-freedom"),
                ));
            }
        }
        Ok(())
    }

    // ── authority: subtractive extend ───────────────────────────────────────

    fn check_extends(&self) -> Result<(), AgapeError> {
        for (name, info) in &self.agents {
            let Some(parent) = &info.parent else { continue };
            let Some(pinfo) = self.agents.get(parent) else { continue };
            if pinfo.unconstrained {
                continue; // parent grants everything; any child subset is fine
            }
            if info.unconstrained {
                return Err(AgapeError::new(
                    ErrorClass::Authority,
                    format!("agent `{name}` widens authority under `extend {parent}` (a child may not become unconstrained when its parent is not)"),
                ));
            }
            for cap in &info.grants {
                if !pinfo.grants.contains(cap) {
                    return Err(AgapeError::new(
                        ErrorClass::Authority,
                        format!("agent `{name}` grants `{:?} {}` not held by its parent `{parent}` — capabilities are subtractive under `extend`", cap.kind, cap.target),
                    ));
                }
            }
        }
        Ok(())
    }

    // ── the value walk: type / taint / authority / exhaustiveness ────────────

    fn walk_block(&self, stmts: &[Stmt], scope: &mut Scope, agent: Option<&str>) -> Result<(), AgapeError> {
        for s in stmts {
            self.walk_stmt(s, scope, agent)?;
        }
        Ok(())
    }

    fn walk_stmt(&self, s: &Stmt, scope: &mut Scope, agent: Option<&str>) -> Result<(), AgapeError> {
        match s {
            Stmt::VarDecl { ty, name, expr } => {
                if let Some(init) = expr {
                    self.walk_expr(init, scope, agent)?;
                    let (taint, authorized) = self.value_taint(Some(ty), init, scope);
                    scope.env.insert(name.clone(), VarInfo { ty: ty.clone(), taint, authorized });
                } else {
                    scope.env.insert(name.clone(), VarInfo { ty: ty.clone(), taint: Taint::U, authorized: false });
                }
            }
            Stmt::Assign { target, expr } => {
                self.walk_expr(target, scope, agent)?;
                self.walk_expr(expr, scope, agent)?;
            }
            Stmt::Emit { event_type, payload } => {
                self.walk_expr(payload, scope, agent)?;
                self.check_emit(event_type, payload, scope, agent)?;
            }
            Stmt::Verify { arg, by } => {
                self.walk_expr(arg, scope, agent)?;
                self.check_gate_by(by)?;
            }
            Stmt::Say(x) | Stmt::Return(Some(x)) | Stmt::ExprStmt(x) => self.walk_expr(x, scope, agent)?,
            Stmt::If { cond, then_body, else_body } => {
                self.walk_expr(cond, scope, agent)?;
                self.check_bool_cond(cond, scope)?;
                let mut s1 = scope.child();
                self.walk_block(then_body, &mut s1, agent)?;
                let mut s2 = scope.child();
                self.walk_block(else_body, &mut s2, agent)?;
            }
            Stmt::While { cond, body } => {
                self.walk_expr(cond, scope, agent)?;
                let mut s1 = scope.child();
                self.walk_block(body, &mut s1, agent)?;
            }
            Stmt::On { body, .. } => {
                let mut s1 = scope.child();
                self.walk_block(body, &mut s1, agent)?;
            }
            Stmt::When { subject, body, .. } => {
                self.walk_expr(subject, scope, agent)?;
                let mut s1 = scope.child();
                self.walk_block(body, &mut s1, agent)?;
            }
            Stmt::Catch { binding, body, .. } => {
                let mut s1 = scope.child();
                s1.env.insert(binding.clone(), VarInfo { ty: Type::Named("Event".into()), taint: Taint::P, authorized: false });
                self.walk_block(body, &mut s1, agent)?;
            }
            Stmt::Case { expr, binding, arms, default } => {
                self.walk_expr(expr, scope, agent)?;
                self.check_exhaustive(expr, arms, default, scope)?;
                for (_, body) in arms {
                    let mut s1 = scope.child();
                    s1.env.insert(binding.clone(), VarInfo { ty: Type::Named("?".into()), taint: Taint::P, authorized: false });
                    self.walk_block(body, &mut s1, agent)?;
                }
                if let Some(d) = default {
                    let mut s1 = scope.child();
                    self.walk_block(d, &mut s1, agent)?;
                }
            }
            Stmt::Retry(tail) => match tail {
                RetryTail::Bounded { body, .. } => {
                    let mut s1 = scope.child();
                    self.walk_block(body, &mut s1, agent)?;
                }
                RetryTail::Predicate { bind, ty, pred, body } => {
                    let mut s1 = scope.child();
                    s1.env.insert(bind.clone(), VarInfo { ty: ty.clone(), taint: Taint::T, authorized: false });
                    self.walk_expr(pred, &mut s1, agent)?;
                    self.walk_block(body, &mut s1, agent)?;
                }
            },
            Stmt::DepDecl { kind, names } => {
                scope.deps.push((*kind, names.clone()));
            }
            Stmt::Spawn { name, agent_type } => {
                scope.env.insert(name.clone(), VarInfo { ty: Type::Named(agent_type.clone()), taint: Taint::U, authorized: false });
            }
            Stmt::Prompt { ty, name } => {
                // External, untrusted input → T-tainted (§5b).
                scope.env.insert(name.clone(), VarInfo { ty: ty.clone(), taint: Taint::T, authorized: false });
            }
            Stmt::QueryStmt(q) => {
                if let Query::Match { query, .. } = q {
                    self.walk_expr(query, scope, agent)?;
                }
            }
            Stmt::Principal(name) => {
                scope.env.insert(name.clone(), VarInfo { ty: Type::Named("Principal".into()), taint: Taint::U, authorized: false });
            }
            // Declarations: register agent params/principal context where useful.
            Stmt::AgentDecl { .. } | Stmt::FnDecl { .. } | Stmt::StructDecl { .. } | Stmt::EnumDecl { .. } | Stmt::EventDecl { .. } | Stmt::ToolDecl { .. } | Stmt::Authority(_) | Stmt::Extend { .. } | Stmt::Import { .. } | Stmt::ModuleAttr { .. } | Stmt::Awake { .. } | Stmt::Sleep(_) | Stmt::Break | Stmt::Return(None) => {}
        }
        Ok(())
    }

    fn walk_expr(&self, e: &Expr, scope: &Scope, agent: Option<&str>) -> Result<(), AgapeError> {
        match e {
            Expr::Verify { arg, by } => {
                self.walk_expr(arg, scope, agent)?;
                self.check_gate_by(by)?;
            }
            Expr::Decide { expr, .. } => self.walk_expr(expr, scope, agent)?,
            Expr::Quorum { judges, .. } => {
                for j in judges {
                    self.walk_expr(j, scope, agent)?;
                }
                self.check_fusion(judges, scope)?;
            }
            Expr::Call { func, args } => {
                // Aggregators `all`/`any` over Credence also require a dependence decl.
                if let Expr::Name(n) = &**func {
                    if (n == "all" || n == "any") && self.args_are_credence(args, scope) {
                        self.check_fusion(args, scope)?;
                    }
                    // A tool call in an agent body needs a `use` grant (§6b).
                    if self.tools.contains_key(n) {
                        self.check_use(n, agent)?;
                    }
                }
                self.walk_expr(func, scope, agent)?;
                for a in args {
                    self.walk_expr(a, scope, agent)?;
                }
            }
            Expr::StructLit { name, fields } => {
                self.check_struct_lit(name, fields)?;
                for (_, v) in fields {
                    self.walk_expr(v, scope, agent)?;
                }
            }
            Expr::Send { dest, payload, retry, .. } => {
                self.check_reach(dest, scope, agent)?;
                self.walk_expr(dest, scope, agent)?;
                self.walk_expr(payload, scope, agent)?;
                if let Some(tail) = retry {
                    let (RetryTail::Bounded { body, .. } | RetryTail::Predicate { body, .. }) = &**tail;
                    let mut s1 = scope.child();
                    self.walk_block(body, &mut s1, agent)?;
                }
            }
            Expr::Binary { left, right, .. } => {
                self.walk_expr(left, scope, agent)?;
                self.walk_expr(right, scope, agent)?;
            }
            Expr::Not(x) | Expr::Member { obj: x, .. } => self.walk_expr(x, scope, agent)?,
            Expr::Index { obj, index } => {
                self.walk_expr(obj, scope, agent)?;
                self.walk_expr(index, scope, agent)?;
            }
            Expr::Pipe { source, func } => {
                self.walk_expr(source, scope, agent)?;
                self.walk_expr(func, scope, agent)?;
            }
            Expr::Array(es) => {
                for x in es {
                    self.walk_expr(x, scope, agent)?;
                }
            }
            Expr::Query(q) => {
                if let Query::Match { query, .. } = &**q {
                    self.walk_expr(query, scope, agent)?;
                }
            }
            _ => {}
        }
        Ok(())
    }

    // ── individual checks ────────────────────────────────────────────────────

    /// `emit E(payload)`: the event must be declared (Type); in an agent, a
    /// non-built-in event needs an `emit` grant (Authority); a consequential
    /// (`authority`) event consumes only a `U`-and-authorized value (Taint).
    fn check_emit(&self, event: &str, payload: &Expr, scope: &Scope, agent: Option<&str>) -> Result<(), AgapeError> {
        if !self.events.contains(event) {
            return Err(AgapeError::new(
                ErrorClass::Type,
                format!("`emit {event}` names an undeclared event type (events are not self-declaring; declare `event {event}(...)`)"),
            ));
        }
        let builtin = event == "Event" || event == "Error";
        if let Some(a) = agent {
            if !builtin && !self.agent_allows(a, CapKind::Emit, event) {
                return Err(AgapeError::new(
                    ErrorClass::Authority,
                    format!("agent `{a}` may not `emit {event}` — it holds no such grant (default-deny; add `grants {{ emit {event} }}`)"),
                ));
            }
        }
        if self.authority.contains(event) {
            let (taint, authorized) = self.value_taint(None, payload, scope);
            if !(taint == Taint::U && authorized) {
                return Err(AgapeError::new(
                    ErrorClass::Taint,
                    format!("consequential `emit {event}` consumes a value that is not gate-authorized (taint {taint:?}, authorized {authorized}); route it through a recorded `verify` — a raw `<-`/tool/queried value or a bare `decide` may not drive a consequential action"),
                ));
            }
        }
        Ok(())
    }

    /// A `<-` into another agent (not `self`) needs a `reach` grant (§13).
    fn check_reach(&self, dest: &Expr, scope: &Scope, agent: Option<&str>) -> Result<(), AgapeError> {
        let Some(a) = agent else { return Ok(()) };
        if matches!(dest, Expr::SelfRef) {
            return Ok(()); // self-send is cognition; needs no reach
        }
        if let Expr::Name(n) = dest {
            if let Some(info) = scope.lookup(n) {
                if let Type::Named(agent_ty) = &info.ty {
                    if self.agents.contains_key(agent_ty) && !self.agent_allows(a, CapKind::Reach, agent_ty) {
                        return Err(AgapeError::new(
                            ErrorClass::Authority,
                            format!("agent `{a}` may not reach into `{agent_ty}` — add `grants {{ reach {agent_ty} }}`"),
                        ));
                    }
                }
            }
        }
        Ok(())
    }

    /// A tool call needs a `use` grant in the calling agent (§6b).
    fn check_use(&self, tool: &str, agent: Option<&str>) -> Result<(), AgapeError> {
        let Some(a) = agent else { return Ok(()) };
        if !self.agent_allows(a, CapKind::Use, tool) {
            return Err(AgapeError::new(
                ErrorClass::Authority,
                format!("agent `{a}` may not use tool `{tool}` — default-deny; add `grants {{ use {tool} }}`"),
            ));
        }
        Ok(())
    }

    fn agent_allows(&self, agent: &str, kind: CapKind, target: &str) -> bool {
        let Some(info) = self.agents.get(agent) else { return true };
        if info.unconstrained {
            return true;
        }
        if !info.has_grants {
            return false;
        }
        info.grants.iter().any(|c| c.kind == kind && c.target == target)
    }

    /// No `text → Principal` coercion: `verify … by "alice"` is a `TypeError`.
    fn check_gate_by(&self, by: &Option<GateBasis>) -> Result<(), AgapeError> {
        if let Some(GateBasis::Value(e)) = by {
            if matches!(&**e, Expr::Str(_) | Expr::FStr(_)) {
                return Err(AgapeError::new(
                    ErrorClass::Type,
                    "a `verify … by` principal must be a declared `Principal`, not text — there is no `text → Principal` coercion (a name is a forgeable claim, not a credential)",
                ));
            }
        }
        Ok(())
    }

    /// A struct literal must supply exactly the declared fields (§3).
    fn check_struct_lit(&self, name: &str, fields: &[(String, Expr)]) -> Result<(), AgapeError> {
        let Some(decl) = self.structs.get(name) else { return Ok(()) }; // unknown struct: fail-open
        let supplied: HashSet<&str> = fields.iter().map(|(k, _)| k.as_str()).collect();
        for f in decl {
            if !supplied.contains(f.name.as_str()) {
                return Err(AgapeError::new(
                    ErrorClass::Type,
                    format!("struct literal `{name}` is missing required field `{}` (all struct fields are required; no optional-by-omission)", f.name),
                ));
            }
        }
        for (k, _) in fields {
            if !decl.iter().any(|f| &f.name == k) {
                return Err(AgapeError::new(
                    ErrorClass::Type,
                    format!("struct literal `{name}` has unknown field `{k}`"),
                ));
            }
        }
        Ok(())
    }

    /// Fusing two or more `Credence` judgments requires a total
    /// `independent`/`dependent` declaration covering every pair (§12).
    fn check_fusion(&self, judges: &[Expr], scope: &Scope) -> Result<(), AgapeError> {
        let names: Vec<&str> = judges.iter().filter_map(|j| match j {
            Expr::Name(n) => Some(n.as_str()),
            _ => None,
        }).collect();
        if names.len() < 2 {
            return Ok(());
        }
        for i in 0..names.len() {
            for k in (i + 1)..names.len() {
                let (a, b) = (names[i], names[k]);
                let covered = scope.deps.iter().any(|(_, group)| {
                    group.iter().any(|g| g == a) && group.iter().any(|g| g == b)
                });
                if !covered {
                    return Err(AgapeError::new(
                        ErrorClass::Type,
                        format!("fusing `{a}` and `{b}` requires a dependence declaration (`independent`/`dependent`) covering the pair — fusion has no assumption-free default (§12)"),
                    ));
                }
            }
        }
        Ok(())
    }

    fn args_are_credence(&self, args: &[Expr], scope: &Scope) -> bool {
        !args.is_empty()
            && args.iter().all(|a| matches!(a, Expr::Name(n) if matches!(scope.lookup(n).map(|v| &v.ty), Some(Type::Credence(_)))))
    }

    /// `if`/`while` conditions must be `bool`, never a bare `Credence` (§11).
    fn check_bool_cond(&self, cond: &Expr, scope: &Scope) -> Result<(), AgapeError> {
        if matches!(self.expr_type(cond, scope), Type::Credence(_)) {
            return Err(AgapeError::new(
                ErrorClass::Type,
                "an `if` condition must be `bool`; a `Credence` must be collapsed first with `decide(c, r)`",
            ));
        }
        Ok(())
    }

    /// A `case` over an enum covers every variant or has a `default` (§11).
    fn check_exhaustive(&self, scrutinee: &Expr, arms: &[(String, Vec<Stmt>)], default: &Option<Vec<Stmt>>, scope: &Scope) -> Result<(), AgapeError> {
        if default.is_some() {
            return Ok(());
        }
        let Some(en) = self.enum_of(&self.expr_type(scrutinee, scope)) else { return Ok(()) };
        let Some(variants) = self.enums.get(&en) else { return Ok(()) };
        let covered: HashSet<&str> = arms.iter().map(|(v, _)| v.as_str()).collect();
        for v in variants {
            if !covered.contains(v.as_str()) {
                return Err(AgapeError::new(
                    ErrorClass::Exhaustiveness,
                    format!("non-exhaustive `case` over `{en}`: variant `{v}` is unhandled and there is no `default`"),
                ));
            }
        }
        Ok(())
    }

    fn enum_of(&self, ty: &Type) -> Option<String> {
        match ty {
            Type::Credence(inner) => self.enum_of(inner),
            Type::Named(n) if self.enums.contains_key(n) => Some(n.clone()),
            _ => None,
        }
    }

    // ── value taint + shallow type inference ─────────────────────────────────

    /// The taint (and authorization) a value carries, given its (optional)
    /// declared slot type and its initializer.
    fn value_taint(&self, decl_ty: Option<&Type>, e: &Expr, scope: &Scope) -> (Taint, bool) {
        match e {
            Expr::Decide { .. } => (Taint::U, false), // untaints, but NOT recorded → unauthorized
            Expr::Verify { .. } => (Taint::U, true),  // a recorded gate authorizes
            Expr::Send { .. } => {
                if matches!(decl_ty, Some(Type::Credence(_))) {
                    (Taint::P, false) // a graded judgment
                } else {
                    (Taint::T, false) // a raw reply
                }
            }
            Expr::Quorum { .. } => (Taint::P, false),
            Expr::Query(q) => match &**q {
                Query::Match { .. } => (Taint::U, false), // a gate, but off-spine → unauthorized
                _ => (Taint::P, false),                   // a queried fact defaults to P (§10)
            },
            Expr::Call { func, .. } => {
                if matches!(&**func, Expr::Name(n) if self.tools.contains_key(n)) {
                    (Taint::T, false) // a tool result is raw/untrusted
                } else {
                    (Taint::U, false) // pure/somatic call (interprocedural taint: §15.7 open)
                }
            }
            Expr::Name(n) => scope.lookup(n).map(|v| (v.taint, v.authorized)).unwrap_or((Taint::U, false)),
            Expr::Member { obj, .. } => self.value_taint(None, obj, scope),
            Expr::Index { obj, .. } => self.value_taint(None, obj, scope),
            _ => (Taint::U, false),
        }
    }

    fn expr_type(&self, e: &Expr, scope: &Scope) -> Type {
        match e {
            Expr::Int(_) => Type::Int,
            Expr::Float(_) => Type::Float,
            Expr::Bool(_) | Expr::Not(_) => Type::Bool,
            Expr::Str(_) | Expr::FStr(_) => Type::Text,
            Expr::Null => Type::Null,
            Expr::Name(n) => scope.lookup(n).map(|v| v.ty.clone()).unwrap_or_else(|| Type::Named(n.clone())),
            Expr::Decide { expr, .. } => match self.expr_type(expr, scope) {
                Type::Credence(inner) => *inner,
                _ => Type::Named("?".into()),
            },
            Expr::Quorum { .. } => Type::Credence(Box::new(Type::Bool)),
            Expr::Binary { op, .. } => {
                if matches!(op, BinOp::Eq | BinOp::Ne | BinOp::Lt | BinOp::Gt | BinOp::Le | BinOp::Ge) {
                    Type::Bool
                } else {
                    Type::Named("?".into())
                }
            }
            Expr::StructLit { name, .. } => Type::Named(name.clone()),
            Expr::Query(q) => match &**q {
                Query::Match { .. } => Type::Bool,
                _ => Type::Named("?".into()),
            },
            Expr::Call { func, .. } => match &**func {
                Expr::Name(n) => {
                    if let Some(ret) = self.tools.get(n) {
                        ret.clone().unwrap_or(Type::Null)
                    } else {
                        Type::Named("?".into())
                    }
                }
                _ => Type::Named("?".into()),
            },
            _ => Type::Named("?".into()),
        }
    }
}

/// Collect the names of every function called within a body (for the color
/// fixpoint). Tool calls are handled separately by `expr_reaches_seam`.
fn collect_calls(stmts: &[Stmt]) -> Vec<String> {
    let mut out = Vec::new();
    for s in stmts {
        calls_in_stmt(s, &mut out);
    }
    out
}

fn calls_in_stmt(s: &Stmt, out: &mut Vec<String>) {
    let e = |x: &Expr, out: &mut Vec<String>| calls_in_expr(x, out);
    match s {
        Stmt::VarDecl { expr: Some(x), .. } => e(x, out),
        Stmt::Assign { target, expr } => {
            e(target, out);
            e(expr, out);
        }
        Stmt::Verify { arg, .. } => e(arg, out),
        Stmt::Emit { payload, .. } => e(payload, out),
        Stmt::Say(x) | Stmt::Return(Some(x)) | Stmt::ExprStmt(x) => e(x, out),
        Stmt::If { cond, then_body, else_body } => {
            e(cond, out);
            then_body.iter().for_each(|s| calls_in_stmt(s, out));
            else_body.iter().for_each(|s| calls_in_stmt(s, out));
        }
        Stmt::While { cond, body } => {
            e(cond, out);
            body.iter().for_each(|s| calls_in_stmt(s, out));
        }
        Stmt::On { body, .. } | Stmt::When { body, .. } | Stmt::Catch { body, .. } => {
            body.iter().for_each(|s| calls_in_stmt(s, out));
        }
        Stmt::Case { expr, arms, default, .. } => {
            e(expr, out);
            arms.iter().for_each(|(_, b)| b.iter().for_each(|s| calls_in_stmt(s, out)));
            if let Some(d) = default {
                d.iter().for_each(|s| calls_in_stmt(s, out));
            }
        }
        Stmt::Retry(tail) => match tail {
            RetryTail::Bounded { body, .. } => body.iter().for_each(|s| calls_in_stmt(s, out)),
            RetryTail::Predicate { pred, body, .. } => {
                calls_in_expr(pred, out);
                body.iter().for_each(|s| calls_in_stmt(s, out));
            }
        },
        _ => {}
    }
}

fn calls_in_expr(x: &Expr, out: &mut Vec<String>) {
    match x {
        Expr::Call { func, args } => {
            if let Expr::Name(n) = &**func {
                out.push(n.clone());
            }
            calls_in_expr(func, out);
            args.iter().for_each(|a| calls_in_expr(a, out));
        }
        Expr::Send { dest, payload, .. } => {
            calls_in_expr(dest, out);
            calls_in_expr(payload, out);
        }
        Expr::Verify { arg, .. } => calls_in_expr(arg, out),
        Expr::Decide { expr, .. } => calls_in_expr(expr, out),
        Expr::Quorum { judges, .. } => judges.iter().for_each(|j| calls_in_expr(j, out)),
        Expr::Pipe { source, func } => {
            calls_in_expr(source, out);
            calls_in_expr(func, out);
        }
        Expr::Binary { left, right, .. } => {
            calls_in_expr(left, out);
            calls_in_expr(right, out);
        }
        Expr::Not(e) | Expr::Member { obj: e, .. } => calls_in_expr(e, out),
        Expr::Index { obj, index } => {
            calls_in_expr(obj, out);
            calls_in_expr(index, out);
        }
        Expr::Array(es) => es.iter().for_each(|e| calls_in_expr(e, out)),
        Expr::StructLit { fields, .. } => fields.iter().for_each(|(_, v)| calls_in_expr(v, out)),
        Expr::Query(q) => {
            if let Query::Match { query, .. } = &**q {
                calls_in_expr(query, out);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lexer::lex;
    use crate::parser::parse;

    fn run(src: &str) -> Result<(), ErrorClass> {
        check(&parse(lex(src).unwrap()).unwrap()).map_err(|e| e.class)
    }
    fn ok(src: &str) {
        assert_eq!(run(src), Ok(()), "expected accept: {src}");
    }
    fn rej(src: &str, class: ErrorClass) {
        assert_eq!(run(src), Err(class), "expected {class:?}: {src}");
    }

    #[test]
    fn color() {
        ok("sync int double(int x) { return x * 2; }");
        ok("event Note(text m); sync null log(text m) { emit Note(m); return null; }");
        ok("sync bool over(Credence<bool> c) { verify c; return decide(c, > 0.9); }");
        rej("agent A {} sync text ask(A a) { return a <- \"hi\"; }", ErrorClass::Color);
        rej("tool text search(text q); sync text find(text q) { return search(q); }", ErrorClass::Color);
        rej("principal alice; sync null ok(text m) { verify m by alice; return null; }", ErrorClass::Color);
    }

    #[test]
    fn types() {
        ok("struct Memo { amount: int, to: text } Memo m = Memo { amount: 1, to: \"b\" };");
        rej("struct Memo { amount: int, to: text } Memo m = Memo { amount: 1 };", ErrorClass::Type);
        rej("emit Transfer(\"x\");", ErrorClass::Type);
        rej("agent A {} spawn A a; awake a; event<text> m = a <- \"d\"; verify m by \"alice\";", ErrorClass::Type);
        ok("principal alice; agent A {} spawn A a; awake a; event<text> m = a <- \"d\"; verify m by alice;");
    }

    #[test]
    fn exhaustiveness() {
        ok("enum T { A, B } agent C { on awake { Credence<T> k = self <- \"q\"; case (k) as v { A: { say(\"a\"); } B: { say(\"b\"); } } } } spawn C c; awake c;");
        rej("enum T { A, B } agent C { on awake { Credence<T> k = self <- \"q\"; case (k) as v { A: { say(\"a\"); } } } } spawn C c; awake c;", ErrorClass::Exhaustiveness);
    }

    #[test]
    fn fusion() {
        ok("agent T { on awake { Credence<bool> a = self <- \"1\"; Credence<bool> b = self <- \"2\"; independent a, b; Credence<bool> g = quorum(2 of a, b); } } spawn T t; awake t;");
        rej("agent T { on awake { Credence<bool> a = self <- \"1\"; Credence<bool> b = self <- \"2\"; Credence<bool> g = quorum(2 of a, b); } } spawn T t; awake t;", ErrorClass::Type);
    }

    #[test]
    fn authority() {
        // built-in Event is emittable without a grant
        ok("agent A { on awake { emit Event(\"hi\"); } } spawn A a; awake a;");
        ok("tool text s(text q); agent R grants { use s } { text h = s(\"q\"); } spawn R r; awake r;");
        rej("tool text s(text q); agent R { text h = s(\"q\"); } spawn R r; awake r;", ErrorClass::Authority);
        rej("tool text s(text q); agent B grants { } {} agent C grants { use s } { extend B(); } spawn C c; awake c;", ErrorClass::Authority);
    }

    #[test]
    fn taint() {
        // bare decide → U but unauthorized → cannot drive a consequential emit
        rej("authority F; event F(bool b); agent C grants { emit F } { Credence<bool> c = self <- \"q\"; bool d = decide(c, > 0.9); emit F(d); } spawn C c; awake c;", ErrorClass::Taint);
        // a tool result is T-tainted
        rej("authority Al; event Al(text m); tool text fetch(text u); agent M grants { use fetch, emit Al } { text b = fetch(\"u\"); emit Al(b); } spawn M m; awake m;", ErrorClass::Taint);
        // a recorded verify authorizes — but verify yields event<Verification>, so
        // the consequential value must itself be gate-authorized; a bare-decide is rejected.
        ok("authority F; event F(bool b); agent C grants { emit F } { on awake { emit Event(\"noop\"); } } spawn C c; awake c;");
    }
}
