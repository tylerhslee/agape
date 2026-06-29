//! The static checker (M3) — SPEC-1.0 §14 / §15.3.
//!
//! One pass over the AST that enforces the trusted-kernel guarantees, mapping
//! each to the conformance error classes:
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
//! The kernel policy is fail-closed at consequential boundaries: if type, trust,
//! endorsement, grant, tool effect, or replay standing cannot be established, the
//! conformant result is rejection. During the reference implementation's WIP
//! phases, unresolved non-kernel surface cases may still be accepted until the
//! relevant conformance test pins them; kernel bypasses should never be accepted.

use std::collections::{HashMap, HashSet};

use crate::ast::*;
use crate::diag::{AgapeError, ErrorClass};
use crate::Module;

/// The three-level taint lattice (§15.3.1): `U ⊑ P ⊑ T`. Declaration order is the
/// lattice order, so `max` is the join `⊔` (a value is as un-settled as its least
/// trusted input).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
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
    /// `true` iff the value's untainting was recorded by a gate (`verify`/`endorse`),
    /// which is what authorizes it for a consequential sink (§13).
    authorized: bool,
}

#[derive(Debug, Clone)]
struct AgentInfo {
    grants: Vec<Capability>,
    has_grants: bool,
    unconstrained: bool,
    ifaces: Vec<String>,
    parent: Option<String>,
    params: Vec<Param>,
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
    /// Set inside a `case` whose scrutinee is a bare `c by R` collapse: an
    /// unendorsed, cognition-derived branch may not license a `perform` (§13).
    consequential_blocked: bool,
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
    event_fields: HashMap<String, Vec<Field>>,
    actions: HashMap<String, Vec<Field>>,
    prompt_types: HashMap<String, Type>,
    tools: HashMap<String, Option<Type>>, // name -> return type
    tool_effects: HashMap<String, ToolEffect>, // name -> read/write (§6b)
    agents: HashMap<String, AgentInfo>,
    fns: HashMap<String, FnInfo>,
    principals: HashSet<String>, // top-level principals
    authority: HashSet<String>,  // consequential event types
    fn_async: HashMap<String, bool>,
    interfaces: HashMap<String, Vec<IfaceMember>>,
    /// Type params in scope (generic struct/fn) — treated as valid opaque types.
    typarams: HashSet<String>,
    /// Struct declarations that actually accept type arguments (§19.5).
    generic_structs: HashSet<String>,
    /// Reversible action/tool sinks (§20), by name.
    reversible_sinks: HashSet<String>,
    /// The file-level conformal default (§20); used by the gate desugaring.
    file_conformal: Option<f64>,
}

/// Lex + parse already done; run the static pass over the AST.
pub fn check(stmts: &[Stmt]) -> Result<(), AgapeError> {
    let root = Module {
        path: String::new(),
        stmts: stmts.to_vec(),
    };
    check_program(&[root])
}

/// Check a whole program (the root module plus its companion modules, §19). Runs the
/// library-layer static checks (modules / visibility / interfaces / the gate / error
/// subtyping) and then the per-module value walk (color / taint / authority /
/// exhaustiveness) over the combined declaration set.
pub fn check_program(modules: &[Module]) -> Result<(), AgapeError> {
    // ── library layer (§19): module resolution, visibility, interfaces ──────────
    let table = ModuleTable::build(modules);
    table.check_imports()?; // ModuleError / VisibilityError
    table.check_error_supertypes()?; // TypeError (non-Error supertype)

    // ── the value-level checker over the combined declaration set ───────────────
    let mut c = Checker::new();
    for m in modules {
        c.collect(&m.path, &m.stmts);
    }
    c.seed_prelude();
    c.check_interfaces()?; // InterfaceError
    c.check_gates(modules)?; // GateError
    c.compute_colors();
    c.check_colors()?;
    c.check_extends()?;

    for m in modules {
        // Top-level scope (not an agent: no authority context).
        let mut scope = Scope::default();
        c.walk_block(&m.stmts, &mut scope, None)?;
    }

    // Each agent body under its own authority context.
    let agent_names: Vec<String> = c.agents.keys().cloned().collect();
    for name in agent_names {
        let info = c.agents[&name].clone();
        let mut ascope = Scope::default();
        // Seed the agent's constructor parameters (a `reach`/`use`/`perform` over a
        // param — e.g. an injected agent handle — is checked against this binding).
        for p in &info.params {
            let taint = c.param_taint(&p.ty);
            ascope.env.insert(
                p.name.clone(),
                VarInfo {
                    ty: p.ty.clone(),
                    taint,
                    authorized: false,
                },
            );
        }
        c.walk_block(&info.body, &mut ascope, Some(&name))?;
    }
    Ok(())
}

// ── the library layer (§19): modules, imports, visibility ────────────────────

/// One declaration's visibility within its module (§19.4).
#[derive(Debug, Clone)]
struct DeclInfo {
    is_pub: bool,
}

/// The static module table — every module's declarations, used for import
/// resolution and visibility (§19.2, §19.4).
struct ModuleTable<'a> {
    modules: &'a [Module],
    /// module path → (decl name → info).
    decls: HashMap<String, HashMap<String, DeclInfo>>,
}

impl<'a> ModuleTable<'a> {
    fn build(modules: &'a [Module]) -> Self {
        let mut decls: HashMap<String, HashMap<String, DeclInfo>> = HashMap::new();
        for m in modules {
            let entry = decls.entry(m.path.clone()).or_default();
            for s in &m.stmts {
                let (inner, is_pub) = match s {
                    Stmt::Pub(b) => (b.as_ref(), true),
                    other => (other, false),
                };
                if let Some(name) = inner.decl_name() {
                    entry.insert(name.to_string(), DeclInfo { is_pub });
                }
            }
        }
        ModuleTable { modules, decls }
    }

    fn module_exists(&self, path: &str) -> bool {
        self.decls.contains_key(path)
    }

    /// Resolve imports: a missing module / cycle / unexported selective name is a
    /// ModuleError; a private selective name is a VisibilityError. Also detects an
    /// ambiguous bare reference (the same name selectively imported from two modules).
    fn check_imports(&self) -> Result<(), AgapeError> {
        // Import graph for cycle detection.
        let mut graph: HashMap<String, Vec<String>> = HashMap::new();
        for m in self.modules {
            let deps: Vec<String> = m
                .stmts
                .iter()
                .filter_map(|s| match unwrap_pub(s) {
                    Stmt::Import { module, .. } => Some(module.clone()),
                    _ => None,
                })
                .collect();
            graph.entry(m.path.clone()).or_default().extend(deps);
        }

        for m in self.modules {
            // Track bare-name imports to detect ambiguity (§19.2).
            let mut bare: HashMap<String, String> = HashMap::new(); // name → module
            for s in &m.stmts {
                let Stmt::Import { module, names, .. } = unwrap_pub(s) else {
                    continue;
                };
                if !self.module_exists(module) {
                    return Err(AgapeError::new(
                        ErrorClass::Module,
                        format!("import `{module}` resolves to no module (§19.2)"),
                    ));
                }
                // Cycle: a module reachable from `module` that returns to `m.path`.
                if self.reaches(&graph, module, &m.path) {
                    return Err(AgapeError::new(
                        ErrorClass::Module,
                        format!("import cycle through `{module}` and `{}` — imports are acyclic (§19.2)", m.path),
                    ));
                }
                let exports = &self.decls[module];
                for name in names {
                    match exports.get(name) {
                        None => {
                            return Err(AgapeError::new(
                                ErrorClass::Module,
                                format!("module `{module}` does not export `{name}` (§19.2)"),
                            ));
                        }
                        Some(info) if !info.is_pub => {
                            return Err(AgapeError::new(
                                ErrorClass::Visibility,
                                format!("`{name}` is not `pub` in module `{module}` — a non-pub declaration is not importable (§19.4)"),
                            ));
                        }
                        Some(_) => {
                            if let Some(prev) = bare.insert(name.clone(), module.clone()) {
                                if &prev != module {
                                    return Err(AgapeError::new(
                                        ErrorClass::Module,
                                        format!("`{name}` is ambiguous — selectively imported from both `{prev}` and `{module}`; qualify it (§19.2)"),
                                    ));
                                }
                            }
                        }
                    }
                }
            }
            // Qualified cross-module references (`spawn m.Name`, `m.Name` types, etc.)
            // against visibility.
            self.check_qualified_visibility(m)?;
        }
        Ok(())
    }

    /// True if `from` can reach `target` in the import graph (a path back to a
    /// module that imports `from` ⇒ a cycle).
    fn reaches(&self, graph: &HashMap<String, Vec<String>>, from: &str, target: &str) -> bool {
        let mut seen = HashSet::new();
        let mut stack = vec![from.to_string()];
        while let Some(cur) = stack.pop() {
            if !seen.insert(cur.clone()) {
                continue;
            }
            if let Some(deps) = graph.get(&cur) {
                for d in deps {
                    if d == target {
                        return true;
                    }
                    stack.push(d.clone());
                }
            }
        }
        false
    }

    /// A qualified reference `prefix.Name` (via an `import`/`alias`) into another
    /// module naming a non-`pub` declaration is a VisibilityError (§19.4).
    fn check_qualified_visibility(&self, m: &Module) -> Result<(), AgapeError> {
        // prefix (alias or module bare name) → module path.
        let mut prefix: HashMap<String, String> = HashMap::new();
        for s in &m.stmts {
            if let Stmt::Import {
                module,
                alias,
                names,
                ..
            } = unwrap_pub(s)
            {
                if names.is_empty() {
                    let p = alias.clone().unwrap_or_else(|| module.clone());
                    prefix.insert(p, module.clone());
                }
            }
        }
        let mut bad: Option<(String, String)> = None;
        for s in &m.stmts {
            walk_qualified_names(s, &mut |q| {
                if bad.is_some() {
                    return;
                }
                if let Some((pfx, name)) = q.rsplit_once('.') {
                    if let Some(modpath) = prefix.get(pfx) {
                        if let Some(info) = self.decls.get(modpath).and_then(|d| d.get(name)) {
                            if !info.is_pub {
                                bad = Some((modpath.clone(), name.to_string()));
                            }
                        }
                    }
                }
            });
        }
        if let Some((modpath, name)) = bad {
            return Err(AgapeError::new(
                ErrorClass::Visibility,
                format!(
                    "`{modpath}.{name}` names a non-pub declaration from another module (§19.4)"
                ),
            ));
        }
        Ok(())
    }

    /// A user `event` may only declare the supertype `Error` (§19.5); anything else
    /// is a TypeError. Also a `pub` decl exposing a private type is a VisibilityError.
    fn check_error_supertypes(&self) -> Result<(), AgapeError> {
        for m in self.modules {
            for s in &m.stmts {
                if let Stmt::EventDecl {
                    super_name: Some(sup),
                    ..
                } = unwrap_pub(s)
                {
                    if sup != "Error" {
                        return Err(AgapeError::new(
                            ErrorClass::Type,
                            format!("a user `event` may only extend the built-in `Error`, not `{sup}` (§19.5)"),
                        ));
                    }
                }
            }
            // Shallow export: a pub decl's signature may not expose a private type
            // declared in the SAME module (§19.4).
            let local = &self.decls[&m.path];
            for s in &m.stmts {
                if let Stmt::Pub(_) = s {
                    let inner = unwrap_pub(s);
                    for ty in sig_types_of(inner) {
                        if let Some(info) = local.get(&ty) {
                            if !info.is_pub {
                                return Err(AgapeError::new(
                                    ErrorClass::Visibility,
                                    format!("`pub` declaration exposes the private type `{ty}` in its signature — `pub` is shallow (§19.4)"),
                                ));
                            }
                        }
                    }
                }
            }
        }
        Ok(())
    }
}

fn unwrap_pub(s: &Stmt) -> &Stmt {
    match s {
        Stmt::Pub(inner) => inner.as_ref(),
        other => other,
    }
}

/// The bare nominal name behind a `when (Type …)` type (qualified or not).
fn type_nominal(t: &Type) -> Option<String> {
    match t {
        Type::Named(n) | Type::Generic(n, _) => Some(n.clone()),
        Type::Event(inner) => type_nominal(inner),
        _ => None,
    }
}

/// Capability targets match modulo a module prefix (`reach Engineer` ≡
/// `reach m.Engineer`).
fn cap_target_matches(a: &str, b: &str) -> bool {
    let ab = a.rsplit('.').next().unwrap_or(a);
    let bb = b.rsplit('.').next().unwrap_or(b);
    a == b || ab == bb
}

/// The user nominal type names appearing in a declaration's public signature
/// (fields / params / return) — for the shallow-export check (§19.4).
fn sig_types_of(s: &Stmt) -> Vec<String> {
    let mut out = Vec::new();
    let push = |t: &Type, out: &mut Vec<String>| {
        if let Some(n) = nominal_name(t) {
            out.push(n);
        }
    };
    match s {
        Stmt::StructDecl { fields, .. } => {
            for f in fields {
                push(&f.ty, &mut out);
            }
        }
        Stmt::FnDecl { ret, params, .. } => {
            push(ret, &mut out);
            for p in params {
                push(&p.ty, &mut out);
            }
        }
        Stmt::AgentDecl { params, .. } => {
            for p in params {
                push(&p.ty, &mut out);
            }
        }
        _ => {}
    }
    out
}

/// The bare nominal name behind a type, if it is a user type worth a visibility
/// check (not a scalar / prelude wrapper).
fn nominal_name(t: &Type) -> Option<String> {
    match t {
        Type::Named(n) if !n.contains('.') => Some(n.clone()),
        Type::Generic(n, _) if !n.contains('.') => Some(n.clone()),
        _ => None,
    }
}

/// Visit every qualified name (`a.b[.c]`) referenced by a statement — in `spawn`,
/// types, `emit`/`perform`, `when`, `reach`, struct literals. Conservative: only
/// dotted names whose head is a single identifier are reported.
fn walk_qualified_names(s: &Stmt, f: &mut impl FnMut(&str)) {
    let ty = |t: &Type, f: &mut dyn FnMut(&str)| {
        if let Type::Named(n) | Type::Generic(n, _) = t {
            if n.contains('.') {
                f(n);
            }
        }
    };
    match unwrap_pub(s) {
        Stmt::Spawn { agent_type, .. } => {
            if agent_type.contains('.') {
                f(agent_type);
            }
        }
        Stmt::Emit { event_type, .. } => {
            if event_type.contains('.') {
                f(event_type);
            }
        }
        Stmt::Perform { action_type, .. } => {
            if action_type.contains('.') {
                f(action_type);
            }
        }
        Stmt::VarDecl { ty: t, .. } => ty(t, f),
        Stmt::When { ty: t, body, .. } => {
            ty(t, f);
            for b in body {
                walk_qualified_names(b, f);
            }
        }
        Stmt::Extend { parent, .. } => {
            if parent.contains('.') {
                f(parent);
            }
        }
        Stmt::AgentDecl {
            body,
            ifaces,
            grants,
            ..
        } => {
            for i in ifaces {
                if i.contains('.') {
                    f(i);
                }
            }
            for cap in grants {
                if cap.target.contains('.') {
                    f(&cap.target);
                }
            }
            for b in body {
                walk_qualified_names(b, f);
            }
        }
        Stmt::On { body, .. } | Stmt::Block(body) => {
            for b in body {
                walk_qualified_names(b, f);
            }
        }
        Stmt::If {
            then_body,
            else_body,
            ..
        } => {
            for b in then_body.iter().chain(else_body) {
                walk_qualified_names(b, f);
            }
        }
        _ => {}
    }
}

impl Checker {
    /// Nominal interface conformance (§19.5): for each `agent : Iface`, every
    /// `when E decide R` member needs a `when (E …)` handler, and every `requires
    /// cap` must be in the agent's grants. A failure is an InterfaceError.
    fn check_interfaces(&self) -> Result<(), AgapeError> {
        for (aname, info) in &self.agents {
            for iface_name in &info.ifaces {
                let bare = iface_name.rsplit('.').next().unwrap_or(iface_name);
                let Some(members) = self
                    .interfaces
                    .get(bare)
                    .or_else(|| self.interfaces.get(iface_name))
                else {
                    return Err(AgapeError::new(
                        ErrorClass::Interface,
                        format!(
                            "agent `{aname}` declares unknown interface `{iface_name}` (§19.5)"
                        ),
                    ));
                };
                // The events this agent handles via `when (E …)`.
                let handled = self.agent_handled_events(&info.body);
                for member in members {
                    match member {
                        IfaceMember::When { event, result } => {
                            let want = event.rsplit('.').next().unwrap_or(event);
                            if !handled.iter().any(|h| h == want || h == event) {
                                return Err(AgapeError::new(
                                    ErrorClass::Interface,
                                    format!("agent `{aname}` declares interface `{iface_name}` but has no `when ({event} …)` handler (§19.5)"),
                                ));
                            }
                            if let Some(actual) = self.handler_decision_result(&info.body, want) {
                                let want_result = result.rsplit('.').next().unwrap_or(result);
                                if actual != want_result && actual != *result {
                                    return Err(AgapeError::new(
                                        ErrorClass::Interface,
                                        format!("agent `{aname}` handler for `{event}` decides `{actual}`, not interface result `{result}` (§19.5)"),
                                    ));
                                }
                            }
                        }
                        IfaceMember::Requires(cap) => {
                            if !info.unconstrained
                                && !info.grants.iter().any(|c| {
                                    c.kind == cap.kind && cap_target_matches(&c.target, &cap.target)
                                })
                            {
                                return Err(AgapeError::new(
                                    ErrorClass::Interface,
                                    format!("agent `{aname}` lacks the capability `{:?} {}` required by interface `{iface_name}` (§19.5)", cap.kind, cap.target),
                                ));
                            }
                        }
                    }
                }
            }
        }
        Ok(())
    }

    /// The readable gate's static checks (§20). A `decide` with a non-reversible arm
    /// and no reachable principal (subject or `defer to`) is a GateError. Also: a
    /// `spawn` of an interface is a TypeError (§19.5).
    fn check_gates(&self, modules: &[Module]) -> Result<(), AgapeError> {
        for m in modules {
            self.check_gates_block(&m.stmts)?;
        }
        Ok(())
    }

    fn check_gates_block(&self, stmts: &[Stmt]) -> Result<(), AgapeError> {
        for s in stmts {
            self.check_gates_stmt(s)?;
        }
        Ok(())
    }

    fn check_gates_stmt(&self, s: &Stmt) -> Result<(), AgapeError> {
        match unwrap_pub(s) {
            Stmt::Decide {
                subject,
                arms,
                default,
                defer_to,
                ..
            } => {
                let has_principal = subject.is_some() || defer_to.is_some();
                if !has_principal {
                    // Any arm reaching a non-reversible sink requires a principal.
                    let mut bodies: Vec<&Vec<Stmt>> = arms.iter().map(|(_, b)| b).collect();
                    if let Some(d) = default {
                        bodies.push(d);
                    }
                    let non_reversible = bodies
                        .iter()
                        .any(|b| self.body_reaches_nonreversible_sink(b));
                    if non_reversible {
                        return Err(AgapeError::new(
                            ErrorClass::Gate,
                            "a `decide` with a non-reversible arm needs a reachable principal (a `subject decide` or `defer to p`) — autonomy is earned via human-label deferral; a `default:` does not substitute (§20)",
                        ));
                    }
                }
                for (_, b) in arms {
                    self.check_gates_block(b)?;
                }
                if let Some(d) = default {
                    self.check_gates_block(d)?;
                }
            }
            Stmt::Spawn { agent_type, .. } => {
                let bare = agent_type.rsplit('.').next().unwrap_or(agent_type);
                if self.interfaces.contains_key(bare) || self.interfaces.contains_key(agent_type) {
                    return Err(AgapeError::new(
                        ErrorClass::Type,
                        format!("`spawn {agent_type}` — an interface is a type but is not instantiable (§19.5)"),
                    ));
                }
            }
            Stmt::AgentDecl { body, .. }
            | Stmt::On { body, .. }
            | Stmt::Block(body)
            | Stmt::When { body, .. } => {
                self.check_gates_block(body)?;
            }
            Stmt::If {
                then_body,
                else_body,
                ..
            } => {
                self.check_gates_block(then_body)?;
                self.check_gates_block(else_body)?;
            }
            Stmt::Case { arms, default, .. } => {
                for (_, b) in arms {
                    self.check_gates_block(b)?;
                }
                if let Some(d) = default {
                    self.check_gates_block(d)?;
                }
            }
            _ => {}
        }
        Ok(())
    }

    /// True if a block reaches a non-reversible consequential sink — a `perform` of a
    /// non-reversible `action`, or a call to a non-reversible `write tool` (§20).
    fn body_reaches_nonreversible_sink(&self, body: &[Stmt]) -> bool {
        body.iter().any(|s| self.stmt_reaches_nonreversible_sink(s))
    }

    fn stmt_reaches_nonreversible_sink(&self, s: &Stmt) -> bool {
        match s {
            Stmt::Perform { action_type, .. } => {
                let bare = action_type.rsplit('.').next().unwrap_or(action_type);
                !self.reversible_sinks.contains(action_type)
                    && !self.reversible_sinks.contains(bare)
            }
            Stmt::ExprStmt(e) | Stmt::Say(e) | Stmt::Return(Some(e)) => {
                self.expr_reaches_nonreversible_sink(e)
            }
            Stmt::VarDecl { expr: Some(e), .. } => self.expr_reaches_nonreversible_sink(e),
            Stmt::Block(b) => self.body_reaches_nonreversible_sink(b),
            Stmt::If {
                then_body,
                else_body,
                ..
            } => {
                self.body_reaches_nonreversible_sink(then_body)
                    || self.body_reaches_nonreversible_sink(else_body)
            }
            Stmt::Certify { arms, abstain, .. } => {
                arms.iter()
                    .any(|(_, b)| self.body_reaches_nonreversible_sink(b))
                    || abstain
                        .as_deref()
                        .is_some_and(|b| self.body_reaches_nonreversible_sink(b))
            }
            _ => false,
        }
    }

    fn expr_reaches_nonreversible_sink(&self, e: &Expr) -> bool {
        if let Expr::Call { func, args } = e {
            if let Expr::Name(n) = &**func {
                if matches!(self.tool_effects.get(n), Some(ToolEffect::Write))
                    && !self.reversible_sinks.contains(n)
                {
                    return true;
                }
            }
            return args.iter().any(|a| self.expr_reaches_nonreversible_sink(a));
        }
        false
    }

    /// The event-type names a body subscribes to via `when (E …)`.
    fn agent_handled_events(&self, body: &[Stmt]) -> Vec<String> {
        let mut out = Vec::new();
        for s in body {
            if let Stmt::When { ty, .. } = s {
                if let Some(n) = type_nominal(ty) {
                    out.push(n.rsplit('.').next().unwrap_or(&n).to_string());
                }
            }
        }
        out
    }

    fn handler_decision_result(&self, body: &[Stmt], event: &str) -> Option<String> {
        for s in body {
            let Stmt::When { ty, body, .. } = s else {
                continue;
            };
            let Some(n) = type_nominal(ty) else { continue };
            if n.rsplit('.').next().unwrap_or(&n) != event && n != event {
                continue;
            }
            let mut credence_bindings: HashMap<String, String> = HashMap::new();
            for stmt in body {
                if let Stmt::VarDecl {
                    ty: Type::Credence(inner),
                    name,
                    ..
                } = stmt
                {
                    if let Some(en) = self.enum_of(inner) {
                        credence_bindings.insert(name.clone(), en);
                    }
                }
            }
            for stmt in body {
                match stmt {
                    Stmt::Endorse {
                        arg: Expr::Name(c), ..
                    }
                    | Stmt::Decide {
                        expr: Expr::Name(c),
                        ..
                    } => {
                        if let Some(en) = credence_bindings.get(c) {
                            return Some(en.clone());
                        }
                    }
                    _ => {}
                }
            }
        }
        None
    }

    fn new() -> Self {
        Checker {
            structs: HashMap::new(),
            enums: HashMap::new(),
            events: HashSet::new(),
            event_fields: HashMap::new(),
            actions: HashMap::new(),
            prompt_types: HashMap::new(),
            tools: HashMap::new(),
            tool_effects: HashMap::new(),
            agents: HashMap::new(),
            fns: HashMap::new(),
            principals: HashSet::new(),
            authority: HashSet::new(),
            fn_async: HashMap::new(),
            interfaces: HashMap::new(),
            typarams: HashSet::new(),
            generic_structs: HashSet::new(),
            reversible_sinks: HashSet::new(),
            file_conformal: None,
        }
    }

    // ── declaration collection ──────────────────────────────────────────────

    fn collect(&mut self, module_path: &str, stmts: &[Stmt]) {
        for s in stmts {
            let s = match s {
                Stmt::Pub(inner) => inner.as_ref(),
                other => other,
            };
            match s {
                Stmt::StructDecl {
                    name,
                    typarams,
                    fields,
                } => {
                    self.structs.insert(name.clone(), fields.clone());
                    if !module_path.is_empty() {
                        self.structs
                            .insert(format!("{module_path}.{name}"), fields.clone());
                    }
                    if !typarams.is_empty() {
                        self.generic_structs.insert(name.clone());
                        if !module_path.is_empty() {
                            self.generic_structs.insert(format!("{module_path}.{name}"));
                        }
                    }
                    for tp in typarams {
                        self.typarams.insert(tp.clone());
                    }
                }
                Stmt::EnumDecl { name, variants } => {
                    self.enums.insert(name.clone(), variants.clone());
                }
                Stmt::EventDecl { name, fields, .. } => {
                    self.events.insert(name.clone());
                    self.event_fields.insert(name.clone(), fields.clone());
                }
                Stmt::ActionDecl {
                    name,
                    fields,
                    reversible,
                } => {
                    self.actions.insert(name.clone(), fields.clone());
                    if *reversible {
                        self.reversible_sinks.insert(name.clone());
                    }
                }
                Stmt::ToolDecl {
                    name,
                    ret,
                    effect,
                    reversible,
                    ..
                } => {
                    self.tools.insert(name.clone(), ret.clone());
                    self.tool_effects.insert(name.clone(), *effect);
                    if *reversible {
                        self.reversible_sinks.insert(name.clone());
                    }
                }
                Stmt::InterfaceDecl { name, members } => {
                    self.interfaces.insert(name.clone(), members.clone());
                }
                Stmt::ConformalDecl(a) => {
                    self.file_conformal = Some(*a);
                }
                Stmt::Prompt { ty, name } => {
                    self.prompt_types.insert(name.clone(), ty.clone());
                }
                Stmt::Authority(name) => {
                    self.authority.insert(name.clone());
                }
                Stmt::Principal(name) => {
                    self.principals.insert(name.clone());
                }
                Stmt::FnDecl {
                    is_sync,
                    name,
                    typarams,
                    params,
                    body,
                    ..
                } => {
                    self.fns.insert(
                        name.clone(),
                        FnInfo {
                            is_sync: *is_sync,
                            params: params.clone(),
                            body: body.clone(),
                        },
                    );
                    for tp in typarams {
                        self.typarams.insert(tp.clone());
                    }
                }
                Stmt::AgentDecl {
                    name,
                    params,
                    ifaces,
                    grants,
                    has_grants,
                    unconstrained,
                    body,
                    ..
                } => {
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
                            ifaces: ifaces.clone(),
                            parent,
                            params: params.clone(),
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
        // `Basis` — how a Decision was settled (Decision.basis, §20/§9).
        self.enums
            .entry("Basis".into())
            .or_insert_with(|| vec!["Argmax".into(), "Conformal".into(), "Principal".into()]);
        self.structs.entry("Rule".into()).or_insert_with(|| {
            vec![
                Field {
                    name: "threshold".into(),
                    ty: Type::Float,
                },
                Field {
                    name: "margin".into(),
                    ty: Type::Float,
                },
            ]
        });
        // The built-in ledger-event channels, always emittable (§9).
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
                if calls
                    .iter()
                    .any(|c| self.fn_async.get(c).copied().unwrap_or(false))
                {
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
            // `attest e by p` always reaches the identity dependency → async (§13).
            Stmt::Attest { .. } => true,
            Stmt::Emit { args, .. } => args.iter().any(e),
            Stmt::Perform { args, .. } => args.iter().any(e),
            Stmt::Certify {
                artifact,
                certifier,
                arms,
                abstain,
                ..
            } => {
                e(artifact)
                    || match certifier {
                        Certifier::Gate { arg, .. } => e(arg),
                        Certifier::Endorsement(endorsement) => e(endorsement),
                    }
                    || arms.iter().any(|(_, body)| b(body))
                    || abstain.as_deref().is_some_and(b)
            }
            Stmt::Endorse {
                arg, arms, abstain, ..
            } => {
                e(arg) || arms.iter().any(|(_, body)| b(body)) || abstain.as_deref().is_some_and(b)
            }
            Stmt::Say(x) | Stmt::Return(Some(x)) | Stmt::ExprStmt(x) => e(x),
            Stmt::If {
                cond,
                then_body,
                else_body,
            } => e(cond) || b(then_body) || b(else_body),
            Stmt::While { cond, body } => e(cond) || b(body),
            Stmt::On { body, .. } | Stmt::Catch { body, .. } | Stmt::Block(body) => b(body),
            Stmt::When {
                about, guard, body, ..
            } => about.as_ref().is_some_and(e) || guard.as_ref().is_some_and(e) || b(body),
            Stmt::Case {
                expr,
                arms,
                default,
                ..
            } => {
                e(expr) || arms.iter().any(|(_, body)| b(body)) || default.as_deref().is_some_and(b)
            }
            Stmt::Retry(tail) => match tail {
                RetryTail::Bounded { body, .. } => b(body),
                RetryTail::Predicate { pred, body, .. } => e(pred) || b(body),
            },
            Stmt::Decide {
                expr,
                arms,
                default,
                ..
            } => {
                e(expr) || arms.iter().any(|(_, body)| b(body)) || default.as_deref().is_some_and(b)
            }
            Stmt::Pub(inner) => self.stmt_reaches_seam(inner, pr),
            _ => false,
        }
    }

    fn expr_reaches_seam(&self, x: &Expr, pr: &HashSet<String>) -> bool {
        let r = |e: &Expr| self.expr_reaches_seam(e, pr);
        match x {
            Expr::Send { .. } => true, // the provider/IPC seam (incl. a Credence-slot send)
            Expr::Recall { .. } => true, // the memory seam (§10) — agentic, async
            Expr::Call { func, args } => {
                let is_tool = matches!(&**func, Expr::Name(n) if self.tools.contains_key(n));
                let is_memory_seam =
                    matches!(&**func, Expr::Name(n) if n == "store" || n == "embed");
                is_tool || is_memory_seam || r(func) || args.iter().any(r)
            }
            Expr::Verify { arg, by } => r(arg) || self.gate_is_identity_seam(by, pr),
            Expr::Decide { expr, rule } => r(expr) || self.rule_reaches_seam(rule, pr),
            // `c by R` / `endorse(c by R)` are in-hand projections: sync unless the
            // operand itself reaches a seam (§13, §4).
            Expr::Collapse { expr, rule } => r(expr) || self.rule_reaches_seam(rule, pr),
            Expr::EndorseExpr { arg, rule } => r(arg) || self.rule_reaches_seam(rule, pr),
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
            let Some(pinfo) = self.agents.get(parent) else {
                continue;
            };
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

    fn walk_block(
        &self,
        stmts: &[Stmt],
        scope: &mut Scope,
        agent: Option<&str>,
    ) -> Result<(), AgapeError> {
        for s in stmts {
            self.walk_stmt(s, scope, agent)?;
        }
        Ok(())
    }

    fn walk_stmt(
        &self,
        s: &Stmt,
        scope: &mut Scope,
        agent: Option<&str>,
    ) -> Result<(), AgapeError> {
        match s {
            Stmt::VarDecl { ty, name, expr } => {
                self.check_type_instantiation(ty)?;
                if let Some(init) = expr {
                    self.walk_expr(init, scope, agent)?;
                    // A `Credence<E>` is produced ONLY by a provider judgment (a send,
                    // a fusion/quorum) — never constructed from a settled scalar (§3, §8).
                    if matches!(ty, Type::Credence(_))
                        && matches!(
                            self.expr_type(init, scope),
                            Type::Bool | Type::Int | Type::Float | Type::Text | Type::Null
                        )
                    {
                        return Err(AgapeError::new(
                            ErrorClass::Type,
                            "a `Credence<E>` is produced only by a provider judgment (a `<-` send, `quorum`/`all`/`any`); it cannot be constructed from a settled value",
                        ));
                    }
                    self.check_gate_decl_initializer(ty, init, scope)?;
                    let (taint, authorized) = self.value_taint(Some(ty), init, scope);
                    scope.env.insert(
                        name.clone(),
                        VarInfo {
                            ty: ty.clone(),
                            taint,
                            authorized,
                        },
                    );
                } else {
                    scope.env.insert(
                        name.clone(),
                        VarInfo {
                            ty: ty.clone(),
                            taint: Taint::U,
                            authorized: false,
                        },
                    );
                }
            }
            Stmt::MemDecl { name, init } => {
                if let Some(e) = init {
                    self.walk_expr(e, scope, agent)?;
                }
                // The handle itself is settled; values RECALLED through it are tainted (§10).
                scope.env.insert(
                    name.clone(),
                    VarInfo {
                        ty: Type::Mem,
                        taint: Taint::U,
                        authorized: false,
                    },
                );
            }
            Stmt::Assign { target, expr } => {
                if let Expr::Member { obj, prop } = target {
                    if matches!(prop.as_str(), "committed" | "basis" | "margin")
                        && matches!(
                            self.expr_type(obj, scope),
                            Type::Decision(_) | Type::Endorsement(_)
                        )
                    {
                        return Err(AgapeError::new(
                            ErrorClass::Type,
                            "Decision/Endorsement provenance fields are read-only (§20.4)",
                        ));
                    }
                }
                self.walk_expr(target, scope, agent)?;
                self.walk_expr(expr, scope, agent)?;
            }
            Stmt::Emit { event_type, args } => {
                for arg in args {
                    self.walk_expr(arg, scope, agent)?;
                }
                self.check_emit(event_type, args, scope, agent)?;
            }
            Stmt::Verify { arg, by } => {
                self.walk_expr(arg, scope, agent)?;
                self.check_gate_by(by)?;
            }
            Stmt::ActionDecl { .. } | Stmt::PolicyDecl { .. } => {}
            Stmt::Perform { action_type, args } => {
                for arg in args {
                    self.walk_expr(arg, scope, agent)?;
                }
                self.check_perform(action_type, args, scope, agent)?;
            }
            // `endorse` records the gate — its arms are the licensed (endorsed)
            // context where a `perform` may run; clear any inherited block.
            Stmt::Endorse {
                arg, arms, abstain, ..
            } => {
                self.walk_expr(arg, scope, agent)?;
                for (_, body) in arms {
                    let mut s = scope.child();
                    s.consequential_blocked = false;
                    self.walk_block(body, &mut s, agent)?;
                }
                if let Some(b) = abstain {
                    let mut s = scope.child();
                    s.consequential_blocked = false;
                    self.walk_block(b, &mut s, agent)?;
                }
            }
            Stmt::Certify {
                artifact,
                certifier,
                arms,
                abstain,
            } => {
                self.walk_expr(artifact, scope, agent)?;
                let artifact_name = match artifact {
                    Expr::Name(n) => n,
                    _ => {
                        return Err(AgapeError::new(
                            ErrorClass::Type,
                            "`certify` can settle only an exact named artifact binding in the legacy gate surface",
                        ));
                    }
                };
                let success = match certifier {
                    Certifier::Gate { arg, rule } => {
                        self.walk_expr(arg, scope, agent)?;
                        self.check_gate_by(&Some(rule.clone()))?;
                        self.certifying_variant_from_credence(arg, scope).ok_or_else(|| {
                            AgapeError::new(
                                ErrorClass::Type,
                                "`certify` inline verifier must be a `Credence<bool>`, `Credence<Verification>`, `Credence<Entailment>`, or a `Credence<Enum>`",
                            )
                        })?
                    }
                    Certifier::Endorsement(endorsement) => {
                        self.walk_expr(endorsement, scope, agent)?;
                        let success = self.certifying_variant_from_endorsement(endorsement, scope).ok_or_else(|| {
                            AgapeError::new(
                                ErrorClass::Type,
                                "`certify` by Endorsement requires an `Endorsement<bool>`, `Endorsement<Verification>`, `Endorsement<Entailment>`, or `Endorsement<Enum>`",
                            )
                        })?;
                        let (taint, authorized) = self.value_taint(None, endorsement, scope);
                        if !(taint == Taint::U && authorized) {
                            return Err(AgapeError::new(
                                ErrorClass::Taint,
                                format!("`certify` by Endorsement requires a recorded gate value (taint {taint:?}, authorized {authorized})"),
                            ));
                        }
                        success
                    }
                };
                for (label, body) in arms {
                    let mut s = scope.child();
                    s.consequential_blocked = false;
                    if label == &success {
                        if let Some(info) = scope.lookup(artifact_name).cloned() {
                            s.env.insert(
                                artifact_name.clone(),
                                VarInfo {
                                    ty: info.ty,
                                    taint: Taint::U,
                                    authorized: true,
                                },
                            );
                        }
                    }
                    self.walk_block(body, &mut s, agent)?;
                }
                if let Some(b) = abstain {
                    let mut s = scope.child();
                    s.consequential_blocked = false;
                    self.walk_block(b, &mut s, agent)?;
                }
            }
            Stmt::Attest { arg, by, arms } => {
                self.walk_expr(arg, scope, agent)?;
                self.check_attest_by(by)?;
                for (_, body) in arms {
                    let mut s = scope.child();
                    s.consequential_blocked = false;
                    self.walk_block(body, &mut s, agent)?;
                }
            }
            Stmt::Block(body) => {
                let mut s = scope.child();
                self.walk_block(body, &mut s, agent)?;
            }
            Stmt::Say(x) | Stmt::Return(Some(x)) | Stmt::ExprStmt(x) => {
                self.walk_expr(x, scope, agent)?
            }
            Stmt::If {
                cond,
                then_body,
                else_body,
            } => {
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
            Stmt::When {
                ty,
                binder,
                about,
                guard,
                body,
            } => {
                if let Some(a) = about {
                    self.walk_expr(a, scope, agent)?;
                }
                let mut s1 = scope.child();
                // The bound event evaluates to its payload; a ledger event (incl. an
                // external `Prompt`, settled by origin §5b) is a settled fact.
                if let Some(b) = binder {
                    let bty = self.when_binder_type(ty, about.as_ref(), scope);
                    s1.env.insert(
                        b.clone(),
                        VarInfo {
                            ty: bty,
                            taint: Taint::U,
                            authorized: false,
                        },
                    );
                }
                if let Some(g) = guard {
                    self.walk_expr(g, &mut s1, agent)?;
                }
                self.walk_block(body, &mut s1, agent)?;
            }
            Stmt::Catch { binding, body, .. } => {
                let mut s1 = scope.child();
                s1.env.insert(
                    binding.clone(),
                    VarInfo {
                        ty: Type::Named("Event".into()),
                        taint: Taint::P,
                        authorized: false,
                    },
                );
                self.walk_block(body, &mut s1, agent)?;
            }
            Stmt::Case {
                expr,
                binding,
                arms,
                default,
            } => {
                self.walk_expr(expr, scope, agent)?;
                // A `case` consumes a Decision, never a bare `Credence` — gate it first.
                if matches!(self.expr_type(expr, scope), Type::Credence(_)) {
                    return Err(AgapeError::new(
                        ErrorClass::Type,
                        "a `case` scrutinee must be a gated `Decision`, not a bare `Credence` — collapse it first (`case (c by R)`)",
                    ));
                }
                self.check_exhaustive(expr, arms, default, scope)?;
                // A case over a *bare* collapse (`c by R`, unendorsed) may dispatch but
                // not license a `perform` in its arms (§13): mark the branch blocked.
                let blocked = matches!(expr, Expr::Collapse { .. });
                let variant_ty = self.case_variant_type(expr, scope);
                for (_, body) in arms {
                    let mut s1 = scope.child();
                    s1.consequential_blocked = blocked;
                    s1.env.insert(
                        binding.clone(),
                        VarInfo {
                            ty: variant_ty.clone(),
                            taint: Taint::U,
                            authorized: false,
                        },
                    );
                    self.walk_block(body, &mut s1, agent)?;
                }
                if let Some(d) = default {
                    let mut s1 = scope.child();
                    s1.consequential_blocked = blocked;
                    self.walk_block(d, &mut s1, agent)?;
                }
            }
            Stmt::Retry(tail) => match tail {
                RetryTail::Bounded { body, .. } => {
                    let mut s1 = scope.child();
                    self.walk_block(body, &mut s1, agent)?;
                }
                RetryTail::Predicate {
                    bind,
                    ty,
                    pred,
                    body,
                } => {
                    let mut s1 = scope.child();
                    s1.env.insert(
                        bind.clone(),
                        VarInfo {
                            ty: ty.clone(),
                            taint: Taint::T,
                            authorized: false,
                        },
                    );
                    self.walk_expr(pred, &mut s1, agent)?;
                    self.walk_block(body, &mut s1, agent)?;
                }
            },
            Stmt::DepDecl { kind, names } => {
                scope.deps.push((*kind, names.clone()));
            }
            Stmt::Spawn {
                name,
                agent_type,
                args,
            } => {
                for a in args {
                    self.walk_expr(a, scope, agent)?;
                }
                scope.env.insert(
                    name.clone(),
                    VarInfo {
                        ty: Type::Named(agent_type.clone()),
                        taint: Taint::U,
                        authorized: false,
                    },
                );
            }
            Stmt::Prompt { ty, name } => {
                // External, untrusted input → T-tainted (§5b).
                scope.env.insert(
                    name.clone(),
                    VarInfo {
                        ty: ty.clone(),
                        taint: Taint::T,
                        authorized: false,
                    },
                );
            }
            Stmt::QueryStmt(q) => {
                if let Query::Match { query, .. } = q {
                    self.walk_expr(query, scope, agent)?;
                }
            }
            Stmt::Principal(name) => {
                scope.env.insert(
                    name.clone(),
                    VarInfo {
                        ty: Type::Named("Principal".into()),
                        taint: Taint::U,
                        authorized: false,
                    },
                );
            }
            // The readable gate (§20): desugars to the engine; walk the arms as the
            // licensed (recorded-gate) context — like `endorse` — so a `perform` in an
            // arm is treated as endorsed.
            Stmt::Decide {
                expr,
                arms,
                default,
                ..
            } => {
                self.walk_expr(expr, scope, agent)?;
                for (_, body) in arms {
                    let mut s = scope.child();
                    s.consequential_blocked = false;
                    self.walk_block(body, &mut s, agent)?;
                }
                if let Some(d) = default {
                    let mut s = scope.child();
                    s.consequential_blocked = false;
                    self.walk_block(d, &mut s, agent)?;
                }
            }
            Stmt::Pub(inner) => self.walk_stmt(inner, scope, agent)?,
            // Declarations: register agent params/principal context where useful.
            Stmt::Forget(name) => {
                scope.env.remove(name);
            }
            Stmt::AgentDecl { .. }
            | Stmt::FnDecl { .. }
            | Stmt::StructDecl { .. }
            | Stmt::EnumDecl { .. }
            | Stmt::EventDecl { .. }
            | Stmt::ToolDecl { .. }
            | Stmt::InterfaceDecl { .. }
            | Stmt::ConformalDecl(_)
            | Stmt::Authority(_)
            | Stmt::Extend { .. }
            | Stmt::Import { .. }
            | Stmt::ModuleDecl { .. }
            | Stmt::ModuleAttr { .. }
            | Stmt::Awake { .. }
            | Stmt::Sleep(_)
            | Stmt::Break
            | Stmt::Return(None)
            | Stmt::Instruction(_) => {}
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
            Expr::Collapse { expr, .. } | Expr::EndorseExpr { arg: expr, .. } => {
                self.walk_expr(expr, scope, agent)?
            }
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
                    // A `write` tool is a consequential sink: every input must be settled
                    // (§6b, §13, W-Consequential-static). A cognition-derived arg rejects.
                    if matches!(self.tool_effects.get(n), Some(ToolEffect::Write)) {
                        for a in args {
                            let (taint, _) = self.value_taint(None, a, scope);
                            if taint != Taint::U {
                                return Err(AgapeError::new(
                                    ErrorClass::Taint,
                                    format!("write tool `{n}` is a consequential sink; its input is un-settled (taint {taint:?}) — gate cognition-derived values before a write"),
                                ));
                            }
                        }
                    }
                    // A bare-name call must resolve to a declared callable — a tool, a
                    // user function, or a builtin. Tools/events are not self-declaring,
                    // so an unknown callable (e.g. `search`, `sample`) is a TypeError (§6b, §8).
                    self.check_callable(n, scope)?;
                }
                self.walk_expr(func, scope, agent)?;
                for a in args {
                    self.walk_expr(a, scope, agent)?;
                }
            }
            Expr::StructLit { name, fields } => {
                self.check_generic_instantiation(name)?;
                self.check_struct_lit(name, fields)?;
                for (_, v) in fields {
                    self.walk_expr(v, scope, agent)?;
                }
            }
            Expr::Send {
                dest,
                payload,
                retry,
                ..
            } => {
                self.check_reach(dest, scope, agent)?;
                self.walk_expr(dest, scope, agent)?;
                self.walk_expr(payload, scope, agent)?;
                if let Some(tail) = retry {
                    let (RetryTail::Bounded { body, .. } | RetryTail::Predicate { body, .. }) =
                        &**tail;
                    let mut s1 = scope.child();
                    self.walk_block(body, &mut s1, agent)?;
                }
            }
            Expr::Recall { mem, query } => {
                self.walk_expr(mem, scope, agent)?;
                self.walk_expr(query, scope, agent)?;
                // `->` requires a `mem` handle on the left; an agent (or anything else) is a
                // TypeError — this is what makes `a -> "x"` reject (§10).
                if !matches!(self.expr_type(mem, scope), Type::Mem) {
                    return Err(AgapeError::new(
                        ErrorClass::Type,
                        "`->` recall requires a `mem` handle on the left (§10)",
                    ));
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

    /// `emit E(args...)`: the event must be declared (Type); in an agent, a
    /// non-built-in event needs an `emit` grant (Authority); a consequential
    /// (`authority`) event consumes only a `U`-and-authorized value (Taint).
    fn check_emit(
        &self,
        event: &str,
        args: &[Expr],
        scope: &Scope,
        _agent: Option<&str>,
    ) -> Result<(), AgapeError> {
        let bare = event.rsplit('.').next().unwrap_or(event);
        if !self.events.contains(event) && !self.events.contains(bare) {
            return Err(AgapeError::new(
                ErrorClass::Type,
                format!("`emit {event}` names an undeclared event type (events are not self-declaring; declare `event {event}(...)`)"),
            ));
        }
        if let Some(fields) = self
            .event_fields
            .get(event)
            .or_else(|| self.event_fields.get(bare))
        {
            self.check_positional_payload("emit", event, fields, args, scope)?;
        } else if matches!(bare, "Event" | "Error") {
            let fields = [Field {
                name: "message".into(),
                ty: Type::Text,
            }];
            self.check_positional_payload("emit", event, &fields, args, scope)?;
        }
        // A plain `emit` needs no power (§13, W-Auth): only `perform`/`reach`/`use`
        // are gated. A consequential act is a `perform` of an `action`, not an emit.
        if self.authority.contains(event) {
            let (taint, authorized) = self.args_taint(args, scope);
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
    fn check_reach(
        &self,
        dest: &Expr,
        scope: &Scope,
        agent: Option<&str>,
    ) -> Result<(), AgapeError> {
        let Some(a) = agent else { return Ok(()) };
        if matches!(dest, Expr::SelfRef) {
            return Ok(()); // self-send is cognition; needs no reach
        }
        if let Expr::Name(n) = dest {
            if let Some(info) = scope.lookup(n) {
                if let Type::Named(agent_ty) = &info.ty {
                    if self.agents.contains_key(agent_ty)
                        && !self.agent_allows(a, CapKind::Reach, agent_ty)
                    {
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

    /// `perform A(args...)` (§13): default-deny `perform` grant (Authority); settled
    /// payload (Taint, W-Consequential-static); and a *recorded* licensing gate —
    /// a `perform` inside a bare-collapse `case` branch is unendorsed (Taint).
    fn check_perform(
        &self,
        action: &str,
        args: &[Expr],
        scope: &Scope,
        agent: Option<&str>,
    ) -> Result<(), AgapeError> {
        let bare = action.rsplit('.').next().unwrap_or(action);
        let fields = self.actions.get(action).or_else(|| self.actions.get(bare)).ok_or_else(|| {
            AgapeError::new(
                ErrorClass::Type,
                format!("`perform {action}` names an undeclared action type (actions are not self-declaring; declare `action {action}(...)`)"),
            )
        })?;
        self.check_positional_payload("perform", action, fields, args, scope)?;
        if let Some(a) = agent {
            if !self.agent_allows(a, CapKind::Perform, action) {
                return Err(AgapeError::new(
                    ErrorClass::Authority,
                    format!("agent `{a}` may not `perform {action}` — default-deny; add `grants {{ perform {action} }}`"),
                ));
            }
        }
        let (taint, _) = self.args_taint(args, scope);
        if taint != Taint::U {
            return Err(AgapeError::new(
                ErrorClass::Taint,
                format!("consequential `perform {action}` consumes an un-settled (cognition-derived) value (taint {taint:?}) — gate it first; a raw `<-`/tool/queried value may not drive a perform"),
            ));
        }
        if scope.consequential_blocked {
            return Err(AgapeError::new(
                ErrorClass::Taint,
                format!("`perform {action}` is licensed by a bare `c by R` collapse (settled but unendorsed/off-ledger) — only a recorded gate (`endorse`/`attest`) may license a consequential action (§13)"),
            ));
        }
        Ok(())
    }

    fn check_positional_payload(
        &self,
        op: &str,
        name: &str,
        fields: &[Field],
        args: &[Expr],
        scope: &Scope,
    ) -> Result<(), AgapeError> {
        if args.len() != fields.len() {
            return Err(AgapeError::new(
                ErrorClass::Type,
                format!(
                    "`{op} {name}` expects {} argument(s) from its declaration, got {}",
                    fields.len(),
                    args.len()
                ),
            ));
        }
        for (idx, (arg, field)) in args.iter().zip(fields).enumerate() {
            let got = self.expr_type(arg, scope);
            if got != field.ty {
                return Err(AgapeError::new(
                    ErrorClass::Type,
                    format!(
                        "`{op} {name}` argument {} (`{}`) has type {got:?}, expected {:?}",
                        idx + 1,
                        field.name,
                        field.ty
                    ),
                ));
            }
        }
        Ok(())
    }

    /// `attest e by p` (§13): `p` must be a declared `Principal`, never text — there
    /// is no `text → Principal` coercion (a name is a forgeable claim).
    fn check_attest_by(&self, by: &Expr) -> Result<(), AgapeError> {
        if matches!(by, Expr::Str(_) | Expr::FStr(_)) {
            return Err(AgapeError::new(
                ErrorClass::Type,
                "an `attest … by` principal must be a declared `Principal`, not text — there is no `text → Principal` coercion",
            ));
        }
        Ok(())
    }

    /// A bare-name call must resolve to a declared callable: a tool, a user `fn`, a
    /// builtin, or a bound local. An unknown callable is a `TypeError` (§6b, §8).
    fn check_callable(&self, name: &str, scope: &Scope) -> Result<(), AgapeError> {
        const BUILTINS: &[&str] = &["say", "len", "all", "any", "store", "embed"];
        if self.fns.contains_key(name)
            || self.tools.contains_key(name)
            || BUILTINS.contains(&name)
            || scope.lookup(name).is_some()
        {
            return Ok(());
        }
        Err(AgapeError::new(
            ErrorClass::Type,
            format!("call to undeclared `{name}` — tools and functions are not self-declaring (declare a `tool`/`fn`, or use a builtin)"),
        ))
    }

    /// The taint a constructor/function parameter carries: a `Credence` is graded;
    /// everything else is a settled input.
    fn param_taint(&self, ty: &Type) -> Taint {
        match ty {
            Type::Credence(_) => Taint::P,
            _ => Taint::U,
        }
    }

    /// The variant type a `case` binding takes (the enum behind a Decision/Credence).
    fn case_variant_type(&self, scrutinee: &Expr, scope: &Scope) -> Type {
        match self.enum_of(&self.expr_type(scrutinee, scope)) {
            Some(en) => Type::Named(en),
            None => Type::Named("?".into()),
        }
    }

    /// The verifier variant whose committed gate certifies an artifact (§13).
    /// `bool` uses `true`; the prelude enums use their positive variants; a custom
    /// verifier enum certifies on its first declared variant.
    fn certifying_variant_from_credence(&self, arg: &Expr, scope: &Scope) -> Option<String> {
        match self.expr_type(arg, scope) {
            Type::Credence(inner) => self.certifying_variant_from_inner(&inner),
            _ => None,
        }
    }

    fn certifying_variant_from_endorsement(
        &self,
        endorsement: &Expr,
        scope: &Scope,
    ) -> Option<String> {
        match self.expr_type(endorsement, scope) {
            Type::Endorsement(inner) => self.certifying_variant_from_inner(&inner),
            _ => None,
        }
    }

    fn certifying_variant_from_inner(&self, inner: &Type) -> Option<String> {
        match inner {
            Type::Bool => Some("true".into()),
            Type::Named(n) if n == "Verification" => Some("Pass".into()),
            Type::Named(n) if n == "Entailment" => Some("Entails".into()),
            Type::Named(n) => self.enums.get(n).and_then(|vs| vs.first().cloned()),
            _ => None,
        }
    }

    fn check_gate_decl_initializer(
        &self,
        declared: &Type,
        init: &Expr,
        scope: &Scope,
    ) -> Result<(), AgapeError> {
        let actual = self.expr_type(init, scope);
        match (declared, &actual) {
            (Type::Decision(want), Type::Decision(got))
            | (Type::Endorsement(want), Type::Endorsement(got))
                if want.as_ref() == got.as_ref() =>
            {
                Ok(())
            }
            (Type::Decision(_), Type::Endorsement(_)) => Err(AgapeError::new(
                ErrorClass::Type,
                "`endorse(c by R)` returns `Endorsement<E>`, not `Decision<E>`",
            )),
            (Type::Endorsement(_), Type::Decision(_)) => Err(AgapeError::new(
                ErrorClass::Type,
                "`c by R` returns off-ledger `Decision<E>`, not `Endorsement<E>`; use `endorse(c by R)`",
            )),
            (Type::Decision(want), _) => Err(AgapeError::new(
                ErrorClass::Type,
                format!(
                    "`Decision<{:?}>` initializer must be a `Decision`, got `{actual:?}`",
                    want
                ),
            )),
            (Type::Endorsement(want), _) => Err(AgapeError::new(
                ErrorClass::Type,
                format!(
                    "`Endorsement<{:?}>` initializer must be an `Endorsement`, got `{actual:?}`",
                    want
                ),
            )),
            _ => Ok(()),
        }
    }

    fn agent_allows(&self, agent: &str, kind: CapKind, target: &str) -> bool {
        let Some(info) = self.agents.get(agent) else {
            return true;
        };
        if info.unconstrained {
            return true;
        }
        if !info.has_grants {
            return false;
        }
        info.grants
            .iter()
            .any(|c| c.kind == kind && c.target == target)
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
        let Some(decl) = self.resolve_struct_fields(name) else {
            return Err(AgapeError::new(
                ErrorClass::Type,
                format!("struct literal `{name}` names no declared struct (§3)"),
            ));
        };
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

    /// Resolve a struct name exactly, or by a unique bare-name fallback for static
    /// facades/re-exports. Ambiguous fallbacks are rejected rather than guessed.
    fn resolve_struct_fields(&self, name: &str) -> Option<&Vec<Field>> {
        if let Some(fields) = self.structs.get(name) {
            return Some(fields);
        }
        let bare = name.rsplit('.').next().unwrap_or(name);
        if let Some(fields) = self.structs.get(bare) {
            return Some(fields);
        }
        let mut found: Option<&Vec<Field>> = None;
        for (decl_name, fields) in &self.structs {
            if decl_name.rsplit('.').next().unwrap_or(decl_name) == bare {
                if found.is_some() {
                    return None;
                }
                found = Some(fields);
            }
        }
        found
    }

    fn check_generic_instantiation(&self, name: &str) -> Result<(), AgapeError> {
        if let Some((base, _)) = name.split_once('<') {
            if !self.generic_structs.contains(base) {
                return Err(AgapeError::new(
                    ErrorClass::Type,
                    format!("type arguments instantiate generic declarations only; `{base}` is not generic (§19.5)"),
                ));
            }
        }
        Ok(())
    }

    fn check_type_instantiation(&self, ty: &Type) -> Result<(), AgapeError> {
        match ty {
            Type::Generic(name, args) => {
                if !self.generic_structs.contains(name) {
                    return Err(AgapeError::new(
                        ErrorClass::Type,
                        format!("type arguments instantiate generic declarations only; `{name}` is not generic (§19.5)"),
                    ));
                }
                for a in args {
                    self.check_type_instantiation(a)?;
                }
            }
            Type::Event(inner)
            | Type::Array(inner)
            | Type::Credence(inner)
            | Type::Decision(inner)
            | Type::Endorsement(inner) => {
                self.check_type_instantiation(inner)?;
            }
            _ => {}
        }
        Ok(())
    }

    fn when_binder_type(&self, ty: &Type, about: Option<&Expr>, _scope: &Scope) -> Type {
        if matches!(ty, Type::Named(n) if n == "Prompt") {
            if let Some(Expr::Name(sensor)) = about {
                if let Some(t) = self.prompt_types.get(sensor) {
                    return t.clone();
                }
            }
        }
        ty.clone()
    }

    /// Fusing two or more `Credence` judgments requires a total
    /// `independent`/`dependent` declaration covering every pair (§12).
    fn check_fusion(&self, judges: &[Expr], scope: &Scope) -> Result<(), AgapeError> {
        let names: Vec<&str> = judges
            .iter()
            .filter_map(|j| match j {
                Expr::Name(n) => Some(n.as_str()),
                _ => None,
            })
            .collect();
        if names.len() < 2 {
            return Ok(());
        }
        for i in 0..names.len() {
            for k in (i + 1)..names.len() {
                let (a, b) = (names[i], names[k]);
                let covered = scope
                    .deps
                    .iter()
                    .any(|(_, group)| group.iter().any(|g| g == a) && group.iter().any(|g| g == b));
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
    fn check_exhaustive(
        &self,
        scrutinee: &Expr,
        arms: &[(String, Vec<Stmt>)],
        default: &Option<Vec<Stmt>>,
        scope: &Scope,
    ) -> Result<(), AgapeError> {
        if default.is_some() {
            return Ok(());
        }
        let Some(en) = self.enum_of(&self.expr_type(scrutinee, scope)) else {
            return Ok(());
        };
        let Some(variants) = self.enums.get(&en) else {
            return Ok(());
        };
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
            Type::Credence(inner) | Type::Decision(inner) | Type::Endorsement(inner) => {
                self.enum_of(inner)
            }
            Type::Named(n) if self.enums.contains_key(n) => Some(n.clone()),
            _ => None,
        }
    }

    // ── value taint + shallow type inference ─────────────────────────────────

    /// The taint (and authorization) a value carries, given its (optional)
    /// declared slot type and its initializer.
    fn args_taint(&self, args: &[Expr], scope: &Scope) -> (Taint, bool) {
        let mut taint = Taint::U;
        let mut authorized = !args.is_empty();
        for arg in args {
            let (arg_taint, arg_authorized) = self.value_taint(None, arg, scope);
            taint = taint.max(arg_taint);
            authorized &= arg_authorized;
        }
        (taint, authorized)
    }

    fn value_taint(&self, decl_ty: Option<&Type>, e: &Expr, scope: &Scope) -> (Taint, bool) {
        match e {
            Expr::Decide { .. } => (Taint::U, false), // untaints, but NOT recorded → unauthorized
            Expr::Collapse { .. } => (Taint::U, false), // settled but off-ledger/unendorsed
            Expr::EndorseExpr { .. } => (Taint::U, true), // a recorded gate authorizes
            Expr::Verify { .. } => (Taint::U, true),  // a recorded gate authorizes
            Expr::Send { .. } => {
                if matches!(decl_ty, Some(Type::Credence(_))) {
                    (Taint::P, false) // a graded judgment
                } else {
                    (Taint::T, false) // a raw reply
                }
            }
            // A recall from a `mem` is agentic — tainted like a send reply (§10): graded
            // when bound to a `Credence` slot, else raw. Re-gate before a consequential sink.
            Expr::Recall { .. } => {
                if matches!(decl_ty, Some(Type::Credence(_))) {
                    (Taint::P, false)
                } else {
                    (Taint::T, false)
                }
            }
            Expr::Quorum { .. } => (Taint::P, false),
            Expr::Query(q) => match &**q {
                Query::Match { .. } => (Taint::U, false), // a gate, but off-ledger → unauthorized
                _ => (Taint::P, false),                   // a queried fact defaults to P (§10)
            },
            Expr::Call { func, args } => {
                if matches!(&**func, Expr::Name(n) if self.tools.contains_key(n)) {
                    // A tool result carries the JOIN of its inputs' trust (§6b, T-Tool-Read):
                    // settled inputs → a settled result (external data settled by origin).
                    let join = args.iter().fold(Taint::U, |acc, a| {
                        acc.max(self.value_taint(None, a, scope).0)
                    });
                    (join, false)
                } else {
                    (Taint::U, false) // pure/somatic call (interprocedural taint: §15.7 open)
                }
            }
            Expr::FStr(raw) => (self.fstring_taint(raw, scope), false),
            Expr::Name(n) => scope
                .lookup(n)
                .map(|v| (v.taint, v.authorized))
                .unwrap_or((Taint::U, false)),
            Expr::Member { obj, .. } => self.value_taint(None, obj, scope),
            Expr::Index { obj, .. } => self.value_taint(None, obj, scope),
            _ => (Taint::U, false),
        }
    }

    /// The taint an f-string carries: the join of its interpolated `{expr}` holes —
    /// a template embedding a cognition-derived value is as un-settled as that value.
    fn fstring_taint(&self, raw: &str, scope: &Scope) -> Taint {
        let mut taint = Taint::U;
        let chars: Vec<char> = raw.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            if chars[i] == '{' {
                let mut depth = 1;
                let mut inner = String::new();
                i += 1;
                while i < chars.len() && depth > 0 {
                    match chars[i] {
                        '{' => depth += 1,
                        '}' => {
                            depth -= 1;
                            if depth == 0 {
                                break;
                            }
                        }
                        c => inner.push(c),
                    }
                    i += 1;
                }
                if let Ok(toks) = crate::lexer::lex(&inner) {
                    if let Ok(e) = crate::parser::parse_expr(toks) {
                        taint = taint.max(self.value_taint(None, &e, scope).0);
                    }
                }
            }
            i += 1;
        }
        taint
    }

    fn expr_type(&self, e: &Expr, scope: &Scope) -> Type {
        match e {
            Expr::Int(_) => Type::Int,
            Expr::Float(_) => Type::Float,
            Expr::Bool(_) | Expr::Not(_) => Type::Bool,
            Expr::Str(_) | Expr::FStr(_) => Type::Text,
            Expr::Null => Type::Null,
            Expr::Name(n) => scope
                .lookup(n)
                .map(|v| v.ty.clone())
                .unwrap_or_else(|| Type::Named(n.clone())),
            Expr::Decide { expr, .. } => match self.expr_type(expr, scope) {
                Type::Credence(inner) => *inner,
                _ => Type::Named("?".into()),
            },
            // `c by R` collapses a `Credence<E>` to an off-ledger Decision over E.
            Expr::Collapse { expr, .. } => match self.expr_type(expr, scope) {
                Type::Credence(inner) => Type::Decision(inner),
                Type::Decision(inner) => Type::Decision(inner),
                Type::Endorsement(inner) => Type::Decision(inner),
                other => Type::Decision(Box::new(other)),
            },
            // `endorse(c by R)` records the gate and yields Endorsement<E>.
            Expr::EndorseExpr { arg: expr, .. } => match self.expr_type(expr, scope) {
                Type::Credence(inner) => Type::Endorsement(inner),
                Type::Decision(inner) | Type::Endorsement(inner) => Type::Endorsement(inner),
                other => Type::Endorsement(Box::new(other)),
            },
            Expr::Quorum { .. } => Type::Credence(Box::new(Type::Bool)),
            // A recall yields text by default; bind it to a typed slot to shape it (§10).
            Expr::Recall { .. } => Type::Text,
            Expr::Binary { op, .. } => {
                if matches!(
                    op,
                    BinOp::Eq | BinOp::Ne | BinOp::Lt | BinOp::Gt | BinOp::Le | BinOp::Ge
                ) {
                    Type::Bool
                } else {
                    Type::Named("?".into())
                }
            }
            Expr::StructLit { name, .. } => Type::Named(name.clone()),
            // Decision/Endorsement introspection (§20.4): `.committed` (E),
            // `.basis` (Basis enum), `.margin` (float).
            Expr::Member { obj, prop } => {
                if let Type::Decision(inner) | Type::Endorsement(inner) = self.expr_type(obj, scope)
                {
                    match prop.as_str() {
                        "basis" => Type::Named("Basis".into()),
                        "margin" => Type::Float,
                        "committed" => *inner,
                        _ => Type::Named("?".into()),
                    }
                } else {
                    // A struct field's declared type, if resolvable.
                    let oty = self.expr_type(obj, scope);
                    if let Type::Named(sn) = &oty {
                        if let Some(fields) = self.structs.get(sn) {
                            if let Some(f) = fields.iter().find(|f| &f.name == prop) {
                                return f.ty.clone();
                            }
                        }
                        if let Some(fields) = self.event_fields.get(sn) {
                            if let Some(f) = fields.iter().find(|f| &f.name == prop) {
                                return f.ty.clone();
                            }
                        }
                    }
                    Type::Named("?".into())
                }
            }
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
        Stmt::Emit { args, .. } | Stmt::Perform { args, .. } => {
            args.iter().for_each(|arg| e(arg, out));
        }
        Stmt::Attest { arg, arms, .. } => {
            e(arg, out);
            arms.iter()
                .for_each(|(_, b)| b.iter().for_each(|s| calls_in_stmt(s, out)));
        }
        Stmt::Endorse {
            arg, arms, abstain, ..
        } => {
            e(arg, out);
            arms.iter()
                .for_each(|(_, b)| b.iter().for_each(|s| calls_in_stmt(s, out)));
            if let Some(d) = abstain {
                d.iter().for_each(|s| calls_in_stmt(s, out));
            }
        }
        Stmt::Certify {
            artifact,
            certifier,
            arms,
            abstain,
            ..
        } => {
            e(artifact, out);
            match certifier {
                Certifier::Gate { arg, .. } => e(arg, out),
                Certifier::Endorsement(endorsement) => e(endorsement, out),
            }
            arms.iter()
                .for_each(|(_, b)| b.iter().for_each(|s| calls_in_stmt(s, out)));
            if let Some(d) = abstain {
                d.iter().for_each(|s| calls_in_stmt(s, out));
            }
        }
        Stmt::Block(body) => body.iter().for_each(|s| calls_in_stmt(s, out)),
        Stmt::Say(x) | Stmt::Return(Some(x)) | Stmt::ExprStmt(x) => e(x, out),
        Stmt::If {
            cond,
            then_body,
            else_body,
        } => {
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
        Stmt::Case {
            expr,
            arms,
            default,
            ..
        } => {
            e(expr, out);
            arms.iter()
                .for_each(|(_, b)| b.iter().for_each(|s| calls_in_stmt(s, out)));
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
        Stmt::Decide {
            expr,
            arms,
            default,
            ..
        } => {
            calls_in_expr(expr, out);
            arms.iter()
                .for_each(|(_, b)| b.iter().for_each(|s| calls_in_stmt(s, out)));
            if let Some(d) = default {
                d.iter().for_each(|s| calls_in_stmt(s, out));
            }
        }
        Stmt::Pub(inner) => calls_in_stmt(inner, out),
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
        Expr::Collapse { expr, .. } | Expr::EndorseExpr { arg: expr, .. } => {
            calls_in_expr(expr, out)
        }
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
        rej(
            "agent A {} sync text ask(A a) { return a <- \"hi\"; }",
            ErrorClass::Color,
        );
        rej(
            "read tool text search(text q); sync text find(text q) { return search(q); }",
            ErrorClass::Color,
        );
        rej(
            "principal alice; sync null ok(text m) { verify m by alice; return null; }",
            ErrorClass::Color,
        );
    }

    #[test]
    fn types() {
        ok("struct Memo { amount: int, to: text } Memo m = Memo { amount: 1, to: \"b\" };");
        rej(
            "struct Memo { amount: int, to: text } Memo m = Memo { amount: 1 };",
            ErrorClass::Type,
        );
        rej("emit Transfer(\"x\");", ErrorClass::Type);
        rej(
            "agent A {} spawn A a; awake a; event<text> m = a <- \"d\"; verify m by \"alice\";",
            ErrorClass::Type,
        );
        ok("principal alice; agent A {} spawn A a; awake a; event<text> m = a <- \"d\"; verify m by alice;");
    }

    #[test]
    fn exhaustiveness() {
        ok("enum T { A, B } agent C { on awake { Credence<T> k = self <- \"q\"; case (k by confidence 0.8) as v { A: { say(\"a\"); } B: { say(\"b\"); } } } } spawn C c; awake c;");
        rej("enum T { A, B } agent C { on awake { Credence<T> k = self <- \"q\"; case (k by confidence 0.8) as v { A: { say(\"a\"); } } } } spawn C c; awake c;", ErrorClass::Exhaustiveness);
    }

    #[test]
    fn fusion() {
        ok("agent T { on awake { Credence<bool> a = self <- \"1\"; Credence<bool> b = self <- \"2\"; independent a, b; Credence<bool> g = quorum(2, [a, b]); } } spawn T t; awake t;");
        rej("agent T { on awake { Credence<bool> a = self <- \"1\"; Credence<bool> b = self <- \"2\"; Credence<bool> g = quorum(2, [a, b]); } } spawn T t; awake t;", ErrorClass::Type);
    }

    #[test]
    fn authority() {
        // built-in Event is emittable without a grant
        ok("agent A { on awake { emit Event(\"hi\"); } } spawn A a; awake a;");
        ok("read tool text s(text q); agent R grants { use s } { text h = s(\"q\"); } spawn R r; awake r;");
        rej(
            "read tool text s(text q); agent R { text h = s(\"q\"); } spawn R r; awake r;",
            ErrorClass::Authority,
        );
        rej("read tool text s(text q); agent B grants { } {} agent C grants { use s } { extend B(); } spawn C c; awake c;", ErrorClass::Authority);
    }

    #[test]
    fn taint() {
        // bare decide → U but unauthorized → cannot drive a consequential emit
        rej("authority F; event F(bool b); agent C grants { emit F } { Credence<bool> c = self <- \"q\"; bool d = decide(c, > 0.9); emit F(d); } spawn C c; awake c;", ErrorClass::Taint);
        // a tool result is T-tainted
        rej("authority Al; event Al(text m); read tool text fetch(text u); agent M grants { use fetch, emit Al } { text b = fetch(\"u\"); emit Al(b); } spawn M m; awake m;", ErrorClass::Taint);
        // a recorded verify authorizes — but verify yields event<Verification>, so
        // the consequential value must itself be gate-authorized; a bare-decide is rejected.
        ok("authority F; event F(bool b); agent C grants { emit F } { on awake { emit Event(\"noop\"); } } spawn C c; awake c;");
    }
}
