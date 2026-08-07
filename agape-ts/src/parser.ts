// Parser — tokens -> AST (a v0 subset of SPEC.md §15.2).

import { lex, type Token, type FStringPart } from "./lexer.js";
import type * as A from "./ast.js";

export class ParseError extends Error {}

// contextual keywords — lexed as keyword tokens but valid as plain names in a declaration
// name-position (§2: these are matched positionally, not reserved).
const CONTEXTUAL = new Set(["where", "select", "from", "all", "any", "quorum"]);

export function parse(source: string): A.Program {
  const program = new Parser(lex(source)).parseProgram();
  assertCore(program); // reject any construct outside the core kernel (§15.2) — full grammar lockstep
  return program;
}

// The core kernel is the complete language with NO syntactic sugar and NO library layer. Constructs the
// full surface once had — the arm block, all/any fusion, the policy declaration, reversible
// sinks, agent-memory queries, and the whole library layer (modules,
// imports, visibility, generics, interfaces) — are not part of the core grammar, so accepting one would
// break lockstep with the stripped SPEC.md. This pass walks the parsed program and rejects each as a
// ParseError, so agape-ts accepts EXACTLY the core grammar. (Kept from the surface: gates as plain
// expressions branched with `if`, quorum fusion, store/recall memory, and the objective select-from-ledger.)
function assertCore(p: A.Program): void {
  const bad = (msg: string): never => { throw new ParseError(`${msg} is not part of the core kernel`); };

  const walkType = (t: A.TypeRef): void => {
    if (t.kind === "named" && t.typeArgs && t.typeArgs.length && t.name !== "LedgerEntry") {
      bad("a generic type instantiation");
    }
    if (t.kind === "event" || t.kind === "array" || t.kind === "task") walkType(t.inner);
    if (t.kind === "named" && t.typeArgs) t.typeArgs.forEach(walkType);
  };
  const walkExpr = (e: A.Expr): void => {
    switch (e.kind) {
      case "agg": return bad("`all`/`any` fusion (use `quorum`)");
      case "pipe": walkExpr(e.source); walkExpr(e.fn); break;
      case "select": if (e.target !== "ledger") bad("a `select` over anything except `ledger`"); break;
      case "member": walkExpr(e.obj); break;
      case "index": walkExpr(e.obj); walkExpr(e.index); break;
      case "call": walkExpr(e.callee); e.args.forEach(walkExpr); break;
      case "spawnexpr": e.args.forEach(walkExpr); break;
      case "binary": walkExpr(e.left); walkExpr(e.right); break;
      case "unary": walkExpr(e.operand); break;
      case "send": walkExpr(e.dest); walkExpr(e.message); break;
      case "recall": walkExpr(e.mem); walkExpr(e.query); break;
      case "decide": walkExpr(e.credence); break;
      case "endorse": walkExpr(e.subject); walkExpr(e.decision); break;
      case "quorum": walkExpr(e.source); break;
      case "structlit": if (e.typeArgs && e.typeArgs.length) bad("a generic struct literal"); e.fields.forEach((f) => walkExpr(f.value)); break;
      case "arraylit": e.items.forEach(walkExpr); break;
      case "tasklit": if (e.objective) walkExpr(e.objective); if (e.acceptance) walkExpr(e.acceptance); break; // core (§6c)
      case "performexpr": e.args.forEach(walkExpr); if (e.expires) walkExpr(e.expires); break; // core (§6b)
      case "fstring": e.parts.forEach((pt) => { if (pt.kind === "expr") walkExpr(pt.expr); }); break;
      case "mdimport": break;
      default: break;
    }
  };
  const walkStmt = (s: A.Stmt): void => {
    switch (s.kind) {
      case "dispatch": return bad("a gate arm block (branch on `.committed` with `if`)");
      case "retry": s.body.forEach(walkStmt); break; // core (§11): the sole bounded loop — recovery on a TypeMismatch
      case "complete": walkExpr(s.value); break;  // core (§6c)
      case "fail": walkExpr(s.reason); break;     // core (§6c)
      case "cancel": walkExpr(s.handle); break;   // core (§6c)
      case "var": walkType(s.type); if (s.init) walkExpr(s.init); break;
      case "assign": walkExpr(s.target); walkExpr(s.value); break;
      case "spawn": s.args.forEach(walkExpr); break;
      case "emit": case "perform": s.args.forEach(walkExpr); break;
      case "say": walkExpr(s.arg); break;
      case "return": if (s.value) walkExpr(s.value); break;
      case "if": walkExpr(s.cond); s.then.forEach(walkStmt); if (s.else) s.else.forEach(walkStmt); break;
      case "when": if (s.about) walkExpr(s.about); if (s.guard) walkExpr(s.guard); s.body.forEach(walkStmt); break;
      case "memdecl": if (s.init) walkExpr(s.init); break;
      case "exprstmt": walkExpr(s.expr); break;
      default: break;
    }
  };
  const walkDecl = (d: A.Decl): void => {
    switch (d.kind) {
      case "policydecl": return bad("a `policy` declaration (put the rule inline on the gate)");
      case "interface": return bad("an `interface` (the library layer is deferred)");
      case "struct": if (d.typarams && d.typarams.length) bad("a generic `struct`"); d.fields.forEach((f) => walkType(f.type)); break;
      case "fn": if (d.typarams && d.typarams.length) bad("a generic `fn`"); d.params.forEach((f) => walkType(f.type)); d.body.forEach(walkStmt); break;
      case "action": if (d.reversible) bad("a `reversible` action"); d.fields.forEach((f) => walkType(f.type)); break;
      case "event": d.fields.forEach((f) => walkType(f.type)); break;
      case "prompt": walkType(d.type); break;
      case "agent":
        if (d.ifaces && d.ifaces.length) bad("an `agent : Interface` implements-clause");
        d.fields.forEach((f) => walkType(f.type));
        d.mems.forEach((m) => m.clauses.forEach((c) => { if (c.kind === "type") walkType(c.type); }));
        d.ctor.forEach(walkStmt);
        d.hooks.forEach((h) => h.body.forEach(walkStmt));
        d.whens.forEach((w) => { if (w.about) walkExpr(w.about); if (w.guard) walkExpr(w.guard); w.body.forEach(walkStmt); });
        break;
      default: break;
    }
  };

  if (p.module) bad("a `module` header");
  if (p.imports?.length) bad("an `import`");
  p.decls.forEach(walkDecl);
  p.stmts.forEach(walkStmt);
}

class Parser {
  private i = 0;
  constructor(private toks: Token[]) {}

  private peek(k = 0): Token {
    return this.toks[Math.min(this.i + k, this.toks.length - 1)]!;
  }
  private at(type: string): boolean {
    return this.peek().type === type;
  }
  private atIdent(value: string): boolean {
    const t = this.peek();
    return t.type === "ident" && t.value === value;
  }
  private next(): Token {
    return this.toks[this.i++]!;
  }
  private eat(type: string): Token {
    if (!this.at(type)) this.err(`expected '${type}'`);
    return this.next();
  }
  private eatIdent(value: string): Token {
    if (!this.atIdent(value)) this.err(`expected '${value}'`);
    return this.next();
  }
  private err(msg: string): never {
    const t = this.peek();
    throw new ParseError(`${msg} but got '${t.value || t.type}' at ${t.pos.line}:${t.pos.col}`);
  }

  parseProgram(): A.Program {
    const decls: A.Decl[] = [];
    const stmts: A.Stmt[] = [];
    const pos = this.peek().pos;
    // moduledecl? import* decl*  (§19.2 grammar). A leading `module modpath;` header overrides the
    // path-derived module name; then a contiguous `import*` block; only after it do decls/stmts begin.
    let module: string | undefined;
    if (this.at("module")) {
      this.next();
      module = this.qname();
      this.eat(";");
    }
    const imports: A.ImportDecl[] = [];
    // an import statement starts at `import`, or at `pub` immediately followed by `import` (a re-export,
    // §19.2a). A `pub struct/fn/agent/...` DECL also starts at `pub`, so peek past it to disambiguate:
    // only `pub import …` is an import here; everything else is a declaration handled below.
    while (this.at("import") || (this.at("pub") && this.peek(1).type === "import")) {
      imports.push(this.parseImport());
    }
    while (!this.at("eof")) {
      if (this.isDeclStart()) decls.push(this.parseDecl());
      else stmts.push(this.parseStmt());
    }
    return { kind: "program", module, imports, decls, stmts, pos };
  }

  // import ::= "pub"? "import" ( modpath ("as" Ident)? | "{" Ident ("," Ident)* "}" "from" modpath ) ";"
  // (§19.2/§19.2a). A `pub import` re-exports; a `{ … } from M` form is selective (binds bare names),
  // else a whole-module import (optionally aliased to a new prefix).
  private parseImport(): A.ImportDecl {
    let pub = false;
    if (this.at("pub")) { pub = true; this.next(); }
    const pos = this.eat("import").pos;
    if (this.at("{")) {
      this.next();
      const selective: string[] = [this.eat("ident").value];
      while (this.at(",")) { this.next(); selective.push(this.eat("ident").value); }
      this.eat("}");
      this.eat("from");
      const module = this.qname();
      this.eat(";");
      return { kind: "import", pub, module, selective, pos };
    }
    const module = this.qname();
    let alias: string | undefined;
    if (this.atIdent("as")) { this.next(); alias = this.eat("ident").value; }
    this.eat(";");
    return { kind: "import", pub, module, alias, pos };
  }

  // qname ::= Ident ("." Ident)*  — a (possibly dotted) qualified name, joined by '.'. A bare name stays
  // undotted, so an existing single-module program reads byte-identically (§19.2 fully-qualified names).
  private qname(): string {
    let name = this.eat("ident").value;
    while (this.at(".")) { this.next(); name += "." + this.eat("ident").value; }
    return name;
  }

  private isDeclStart(): boolean {
    const t = this.peek().type;
    // `pub` (§19.4 visibility marker) always opens a declaration; the marked decl follows.
    if (t === "pub") return true;
    if (t === "interface") return true;
    if (t === "enum" || t === "struct" || t === "action" || t === "event" || t === "agent" || t === "instruction") return true;
    // declared dependencies at the top level (§3/§5b): `principal NAME …;` and `prompt T NAME;` — both
    // are keyword-headed. The grammar routes them through `stmt`, but at the top level a declared
    // dependency reads as a decl (config-bound, static — no runtime statement effect).
    if (t === "principal" || t === "prompt") return true;
    // a named decision policy: `policy NAME { … }` (§13). `policy` is a keyword; a policy NAME is referenced
    // elsewhere as a bare ident (`decide c by NAME`), so the keyword only heads the decl.
    if (t === "policy") return true;
    // a file-level `conformal Number;` (confdecl, §15.2 line 1416) — `conformal` is a CONTEXTUAL ident,
    // so only treat it as a decl head when a number literal immediately follows (an ordinary `conformal`
    // used as a name elsewhere is left alone). A `by conformal α` rule is parsed inside parseRule, not here.
    if (this.atIdent("conformal") && (this.peek(1).type === "int" || this.peek(1).type === "float")) return true;
    if (t === "reversible") {
      return this.peek(1).type === "action";
    }
    // function decl: `pure RET NAME(…)` or a bare top-level `RET NAME(…)` (async is default, §15.2).
    if (t === "pure") return true;
    if (this.looksLikeFnDecl()) return true;
    return false;
  }

  // a bare top-level function declaration `RET NAME ( … ) {` (no `pure`), distinguished from a
  // top-level statement by LL lookahead to the `(`/`{` shape after a type and a name.
  private looksLikeFnDecl(): boolean {
    const save = this.i;
    try {
      const t = this.peek();
      const typeStart = t.type === "int" || t.type === "float" || t.type === "bool" || t.type === "text" ||
        t.type === "null" || t.type === "event" || t.type === "array" ||
        (t.type === "ident" && /^[A-Z]/.test(t.value));
      if (!typeStart) return false;
      this.parseType();
      if (!this.at("ident") && !CONTEXTUAL.has(this.peek().type)) return false;
      this.next();
      return this.at("("); // `RET NAME(` — a function signature (a vardecl would be `RET NAME =`/`;`)
    } catch {
      return false;
    } finally {
      this.i = save;
    }
  }

  // ---- declarations ----
  private parseDecl(): A.Decl {
    const pos = this.peek().pos;
    // vis ::= "pub" (§19.4) — the only visibility marker; default (absent) is module-private. The flag
    // is threaded onto whatever declaration follows; a `pub` on a bare statement is a ParseError (a
    // statement is not a declaration surface).
    let pub = false;
    if (this.at("pub")) { pub = true; this.next(); }
    if (this.at("enum")) {
      this.next();
      const name = this.eat("ident").value;
      // enums stay MONOMORPHIC — a type-parameter list on an enum is a ParseError (§19.5).
      if (this.at("<")) this.err("enums are not generic (only `struct` and `fn` carry type parameters)");
      this.eat("{");
      const variants: string[] = [];
      while (!this.at("}")) {
        variants.push(this.eat("ident").value);
        if (this.at(",")) this.next();
      }
      this.eat("}");
      return { kind: "enum", name, variants, pub, pos };
    }
    if (this.at("struct")) {
      this.next();
      const name = this.eat("ident").value;
      // type parameters `<A, B, …>` (§19.5) — parsed and carried for the non-generic check; the brace
      // body then declares the fields NAME-FIRST (`name: T`), the canonical struct form (§3).
      const typarams = this.parseTypeParams();
      this.eat("{");
      const fields: A.Field[] = [];
      while (!this.at("}") && !this.at("eof")) {
        fields.push(this.parseStructField());
        if (this.at(",")) this.next();
      }
      this.eat("}");
      return { kind: "struct", name, fields, typarams, pub, pos };
    }
    if (this.at("interface")) return this.parseInterface(pub);
    if (this.at("action")) {
      this.eat("action");
      const name = this.eat("ident").value;
      const fields = this.parseFieldList();
      this.eat(";");
      return { kind: "action", name, fields, reversible: false, pub, pos };
    }
    if (this.at("reversible")) {
      this.next();
      this.eat("action");
      const name = this.eat("ident").value;
      const fields = this.parseFieldList();
      this.eat(";");
      return { kind: "action", name, fields, reversible: true, pub, pos };
    }
    if (this.at("pure") || this.looksLikeFnDecl()) return this.withPub(this.parseFn(), pub);
    if (this.at("event")) {
      this.next();
      if (this.at("<")) this.err("`event<T>` is no longer a reply type; declare a named `event Foo(...)` or use a bare reply type `T`");
      const name = this.eat("ident").value;
      const fields = this.parseFieldList();
      let errorSuper = false;
      let superName: string | undefined;
      if (this.at(":")) {
        this.next();
        // A supertype ident is structurally well-formed here; whether it is the ONLY permitted supertype
        // (`Error`) is a TYPE question, not a syntax one — §19.5/§19.6 classify a non-`Error` user-event
        // supertype as a TypeError. So the parser only RECORDS the name; the checker validates it.
        superName = this.eat("ident").value;
        errorSuper = superName === "Error";
      }
      this.eat(";");
      return { kind: "event", name, fields, errorSuper, superName, pub, pos };
    }
    if (this.at("instruction")) {
      this.next();
      const text = this.eat("string").value;
      this.eat(";");
      return { kind: "instruction", text, pos };
    }
    if (this.at("agent")) return this.withPub(this.parseAgent(), pub);
    // principal ::= "principal" Ident config? ";"  (§15.2 line 1463) — an accountable identity, bound by
    // an identity backend in config. An optional trailing `config { … }` block is consumed and ignored in
    // v0 (mirroring parseTool), since the manifest, not source, carries the binding (§17.1).
    if (this.at("principal")) {
      this.next();
      const name = this.eat("ident").value;
      if (this.at("{")) this.skipBraces(); // optional `config { … }` binding block (§17) — ignored in v0
      this.eat(";");
      return { kind: "principal", name, pos };
    }
    // prompt ::= "prompt" type Ident ";"  (§15.2 line 1459) — a standing external input sensor. TYPE-FIRST
    // (`prompt text question`), reading as `TYPE name` like a param; distinct from the name-first struct field.
    if (this.at("prompt")) {
      this.next();
      const type = this.parseType();
      const name = this.eat("ident").value;
      this.eat(";");
      return { kind: "prompt", type, name, pos };
    }
    // policy ::= "policy" Ident "{" (("threshold"|"margin"|"floor") Number)* "}"  (§13) — a named decision
    // rule bundle in SOURCE (never the manifest, §17.2). threshold/margin/floor are contextual idents.
    if (this.at("policy")) {
      this.next();
      const name = this.eat("ident").value;
      this.eat("{");
      const decl: A.PolicyDecl = { kind: "policydecl", name, pos };
      while (!this.at("}")) {
        const dir = this.eat("ident").value;
        const n = this.number();
        if (dir === "threshold") decl.threshold = n;
        else if (dir === "margin") decl.margin = n;
        else if (dir === "floor") decl.floor = n;
        // unknown directives are ignored (forward-compatible with richer §13 policy bundles).
      }
      this.eat("}");
      return decl;
    }
    // confdecl ::= "conformal" Number ";"  (§15.2 line 1416) — the file-level default conformal α. Parse-only.
    if (this.atIdent("conformal")) {
      this.next();
      const alpha = this.number();
      this.eat(";");
      return { kind: "conformal", alpha, pos };
    }
    this.err("expected a declaration");
  }

  // attach a `pub` flag to a declaration produced by a helper (tool/fn/agent).
  private withPub<D extends A.Decl>(d: D, pub: boolean): D {
    if (pub && d.kind !== "instruction") (d as { pub?: boolean }).pub = true;
    return d;
  }

  // interface ::= "interface" Ident "{" ifmember* "}"  (§19.5). Not generic: a `<` after the name is a
  // ParseError. Each member is `when EVENT decide RESULT` (NO arrow — `->` is memory-recall, §10) or
  // `requires CAP NAME`, optionally `;`-terminated.
  private parseInterface(pub: boolean): A.InterfaceDecl {
    const pos = this.eat("interface").pos;
    const name = this.eat("ident").value;
    if (this.at("<")) this.err("interfaces are not generic (only `struct` and `fn` carry type parameters)");
    this.eat("{");
    const members: A.IfMember[] = [];
    while (!this.at("}") && !this.at("eof")) {
      if (this.at("when")) {
        this.next();
        const event = this.parseType();
        // an interface member uses `decide`, NEVER an arrow — `when A -> B` is a ParseError (§19.5).
        if (this.at("->")) this.err("an interface member uses `when EVENT decide RESULT`, never `->` (`->` is the memory-recall operator)");
        this.eat("decide");
        const outcome = this.parseType();
        members.push({ kind: "handler", event, outcome });
      } else if (this.at("requires")) {
        this.next();
        let cap: "perform" | "reach" | "use";
        if (this.at("perform")) cap = "perform";
        else if (this.atIdent("reach")) cap = "reach";
        else if (this.atIdent("use")) cap = "use";
        else this.err("expected perform/reach/use after `requires`");
        this.next();
        // a required cap target may be QUALIFIED (`requires reach geo.Worker`, §19.2).
        const capName = this.qname();
        members.push({ kind: "requires", cap, name: capName });
      } else {
        this.err("expected an interface member (`when EVENT decide RESULT` or `requires CAP NAME`)");
      }
      if (this.at(";")) this.next();
    }
    this.eat("}");
    return { kind: "interface", name, members, pub, pos };
  }

  // fn ::= "pure"? type Ident typarams? params block  (async is the default, §15.2)
  private parseFn(): A.FnDecl {
    const pos = this.peek().pos;
    let pure = false;
    if (this.at("pure")) { pure = true; this.next(); }
    const ret = this.parseType();
    const name = this.declName();
    const typarams = this.parseTypeParams(); // `<T, …>` between name and params (§19.5)
    const params = this.parseFieldList();
    const body = this.parseBlock();
    return { kind: "fn", pure, ret, name, params, body, typarams, pos };
  }

  // a declared name in name-position: an Ident, or a CONTEXTUAL keyword used as a name
  // (e.g. `find`/`select`/`match`/`all` are query/contextual words, valid identifiers elsewhere — §2).
  private declName(): string {
    const t = this.peek();
    if (t.type === "ident" || CONTEXTUAL.has(t.type)) { this.next(); return t.value; }
    this.err("expected a name");
  }

  // consume a balanced `{ … }` block without interpreting it (for an ignored config tail).
  private skipBraces(): void {
    this.eat("{");
    let depth = 1;
    while (depth > 0 && !this.at("eof")) {
      const t = this.next();
      if (t.type === "{") depth++;
      else if (t.type === "}") depth--;
    }
  }

  private parseFieldList(): A.Field[] {
    this.eat("(");
    const fields: A.Field[] = [];
    while (!this.at(")")) {
      fields.push(this.parseParamField());
      if (this.at(",")) this.next();
    }
    this.eat(")");
    return fields;
  }

  // A parameter of an action/event/tool/function signature is TYPE-FIRST only: `T name` (§3, the same
  // order as `var` declarations). Name-first `name: T` here is a ParseError.
  private parseParamField(): A.Field {
    if (this.at("ident") && this.peek(1).type === ":") {
      this.err("action/event/tool/function parameters are type-first (`T name`), not `name: T`");
    }
    const type = this.parseType();
    const name = this.eat("ident").value;
    return { type, name };
  }

  // A struct field is NAME-FIRST only: `name: T` (§3), mirroring the struct literal `{ name: value }`.
  // Type-first `T name` inside a struct body is a ParseError.
  private parseStructField(): A.Field {
    const name = this.eat("ident").value;
    this.eat(":");
    const type = this.parseType();
    return { type, name };
  }

  // typarams ::= "<" Ident ("," Ident)* ">"  (§19.5) — a generic declaration's type parameters (struct/fn
  // only). Returns the parameter names (empty when absent). Monomorphization is lenient in v0: the names are
  // carried for the non-generic check but not bound to a type environment.
  private parseTypeParams(): string[] {
    if (!this.at("<")) return [];
    this.eat("<");
    const params: string[] = [this.eat("ident").value];
    while (this.at(",")) { this.next(); params.push(this.eat("ident").value); }
    this.eat(">");
    return params;
  }

  private parseAgent(): A.AgentDecl {
    const pos = this.eat("agent").pos;
    const name = this.eat("ident").value;
    // agents are NOT generic — a type-parameter list on an agent is a ParseError (§19.5).
    if (this.at("<")) this.err("agents are not generic (only `struct` and `fn` carry type parameters)");
    // constructor params `agent Boss(Worker hand)` — TYPE-FIRST like any action/event/tool/fn param
    // signature (§3). Bound at spawn (E-Spawn §15.4.2); `reach` covers such agent-typed params (§13).
    const params: A.Field[] = this.at("(") ? this.parseFieldList() : [];
    // ifaces (`: Iface, …`) — the implemented-interface list, captured for nominal conformance (§19.5).
    const ifaces: string[] = [];
    if (this.at(":")) {
      this.next();
      ifaces.push(this.ifaceName());
      while (this.at(",")) { this.next(); ifaces.push(this.ifaceName()); }
    }
    let grants: A.Grant[] | "all" = [];
    if (this.at("grants")) grants = this.parseGrants();
    this.eat("{");
    const fields: A.Field[] = [];
    const mems: A.MemoryDescriptor[] = [];
    const hooks: A.OnHook[] = [];
    const whens: A.WhenStmt[] = [];
    const instructions: string[] = [];
    const ctor: A.Stmt[] = [];
    let extendsClause: { name: string; args: A.Expr[] } | undefined;
    while (!this.at("}") && !this.at("eof")) {
      if (this.at("on")) hooks.push(this.parseOnHook());
      else if (this.at("mem") && this.peek(1).type === "ident" && this.peek(2).type === "{") mems.push(this.parseMemoryDescriptor());
      else if (this.at("when")) whens.push(this.parseWhen());
      else if (this.at("extend")) {
        // extend ::= "extend" modpath args ";"  — subtractive inheritance (§5/§13); the base may be a
        // QUALIFIED cross-module agent (`extend m.Base()`, §19.2).
        this.next();
        const base = this.qname();
        const args = this.at("(") ? this.parseArgs() : [];
        this.eat(";");
        extendsClause = { name: base, args };
      } else if (this.at("instruction")) {
        this.next();
        instructions.push(this.eat("string").value);
        this.eat(";");
      } else {
        // abody ::= stmt — a constructor statement. A bare `Type Ident;` is an (uninitialized) field;
        // an initialized `Type Ident = e;` (or any other statement) runs at spawn (E-Spawn, §15.4.2).
        const st = this.parseStmt();
        if (st.kind === "var" && st.init === undefined) fields.push({ type: st.type, name: st.name });
        else ctor.push(st);
      }
    }
    this.eat("}");
    return { kind: "agent", name, grants, params, fields, mems, hooks, whens, instructions, ctor, extends: extendsClause, ifaces, pos };
  }

  private parseMemoryDescriptor(): A.MemoryDescriptor {
    const pos = this.eat("mem").pos;
    const name = this.eat("ident").value;
    const clauses: A.MemoryClause[] = [];
    this.eat("{");
    while (!this.at("}") && !this.at("eof")) {
      if (this.atIdent("type")) {
        this.next();
        clauses.push({ kind: "type", type: this.parseType() });
        this.eat(";");
      } else if (this.atIdent("modality")) {
        this.next();
        clauses.push({ kind: "modality", value: this.eat("ident").value });
        this.eat(";");
      } else if (this.atIdent("scope")) {
        this.next();
        const values = [this.eat("ident").value];
        while (this.at(",")) {
          this.next();
          values.push(this.eat("ident").value);
        }
        clauses.push({ kind: "scope", values });
        this.eat(";");
      } else if (this.atIdent("retention")) {
        this.next();
        clauses.push({ kind: "retention", value: this.eat("ident").value });
        this.eat(";");
      } else {
        this.err("expected memory descriptor clause type/modality/scope/retention");
      }
    }
    this.eat("}");
    return { kind: "memdesc", name, clauses, pos };
  }

  // an implemented-interface name in an `agent : Iface, …` clause (§19.5). A `modpath` in the grammar, but
  // v0 is single-module, so it is a plain identifier (the leaf name).
  private ifaceName(): string {
    return this.eat("ident").value;
  }

  private parseGrants(): A.Grant[] | "all" {
    this.eat("grants");
    this.eat("{");
    if (this.at("*")) {
      this.next();
      this.eat("}");
      return "all";
    }
    const grants: A.Grant[] = [];
    while (!this.at("}")) {
      let cap: "perform" | "reach" | "use";
      if (this.at("perform")) cap = "perform";
      else if (this.atIdent("reach")) cap = "reach";
      else if (this.atIdent("use")) cap = "use";
      else this.err("expected perform/reach/use");
      this.next();
      // a cap target may be QUALIFIED (`reach m.Worker`, §19.2).
      const name = this.qname();
      grants.push({ cap, name } as A.Grant);
      if (this.at(",")) this.next();
    }
    this.eat("}");
    return grants;
  }

  private parseOnHook(): A.OnHook {
    const pos = this.eat("on").pos;
    let event: A.OnHook["event"];
    if (this.at("awake")) event = "awake";
    else if (this.at("sleep")) event = "sleep";
    else if (this.at("crash")) event = "crash";
    // the two task hooks (§6c): `assigned`/`cancelled` are contextual idents, not keywords.
    else if (this.atIdent("assigned")) event = "assigned";
    else if (this.atIdent("cancelled")) event = "cancelled";
    else this.err("expected awake/sleep/crash/assigned/cancelled");
    this.next();
    const body = this.parseBlock();
    return { kind: "on", event, body, pos };
  }

  private parseWhen(): A.WhenStmt {
    const pos = this.eat("when").pos;
    this.eat("(");
    // the matched event type may be QUALIFIED (`when (a.Tick t)` / `when (m.Secret s)`, §19.2) — read it
    // as a dotted name; a bare `when (Error e)` stays undotted. The binder still follows.
    const etype = this.qname();
    let binder: string | undefined;
    if (this.at("ident")) binder = this.next().value;
    let about: A.Expr | undefined;
    if (this.atIdent("about")) {
      this.next();
      about = this.parseExpr();
    }
    this.eat(")");
    let guard: A.Expr | undefined;
    if (this.at("if")) {
      this.next();
      this.eat("(");
      guard = this.parseExpr();
      this.eat(")");
    }
    const body = this.parseBlock();
    return { kind: "when", etype, binder, about, guard, body, pos };
  }

  // ---- types ----
  private parseType(): A.TypeRef {
    let t = this.parseTypePrimary();
    while (this.at("[")) {
      this.next();
      this.eat("]");
      t = { kind: "array", inner: t };
    }
    return t;
  }

  private parseTypePrimary(): A.TypeRef {
    const t = this.peek();
    if (t.type === "int" || t.type === "float" || t.type === "bool" || t.type === "text" || t.type === "null") {
      this.next();
      return { kind: "scalar", name: t.type as any };
    }
    if (t.type === "mem") {
      this.next();
      return { kind: "mem" };
    }
    if (t.type === "event") {
      this.err("`event<T>` is no longer a reply type; use a bare `T` for provider replies, or declare a named `event Foo(...)` for ledger records");
    }
    if (t.type === "array") {
      this.next();
      this.eat("<");
      const inner = this.parseType();
      this.eat(">");
      return { kind: "array", inner };
    }
    if (t.type === "ident") {
      const name = t.value;
      if (name === "Credence") {
        this.next();
        this.eat("<");
        const enumName = this.parseTypeArgName();
        this.eat(">");
        return { kind: "credence", enumName };
      }
      if (name === "Decision") {
        this.next();
        this.eat("<");
        const enumName = this.parseTypeArgName();
        this.eat(">");
        return { kind: "decision", enumName };
      }
      if (name === "Endorsement") {
        this.next();
        this.eat("<");
        const inner = this.parseType();
        this.eat(">");
        return { kind: "endorsement", inner };
      }
      if (name === "Task") {
        // Task<T> — a background-task handle (§6c).
        this.next();
        this.eat("<");
        const inner = this.parseType();
        this.eat(">");
        return { kind: "task", inner };
      }
      this.next();
      // a QUALIFIED type name `geometry.Shape` / `facade.internal.Shape` (§19.2): greedily consume
      // `('.' Ident)*` into a dotted name BEFORE the optional `<typeargs>`, so a cross-module type reads
      // as one qualified name (a bare name stays undotted — existing single-module tests are unchanged).
      let qualified = name;
      while (this.at(".")) { this.next(); qualified += "." + this.eat("ident").value; }
      // a generic instantiation `Box<int>` (§19.5): consume the optional type-argument list. Carried on the
      // `named` type so the checker can reject type-args applied to a NON-generic declaration; erased past it.
      let typeArgs: A.TypeRef[] | undefined;
      if (this.at("<")) typeArgs = this.parseTypeArgs();
      return { kind: "named", name: qualified, typeArgs };
    }
    this.err("expected a type");
  }

  // a type-argument name inside Credence<…>/Decision<…>: an enum identifier OR a scalar keyword
  // (e.g. `Credence<bool>` — `bool` is graded over { true, false }, §3).
  private parseTypeArgName(): string {
    const t = this.peek();
    if (t.type === "ident" || t.type === "bool" || t.type === "int" || t.type === "float" || t.type === "text" || t.type === "null") {
      this.next();
      return t.value || t.type;
    }
    this.err("expected an enum or scalar type argument");
  }

  // ---- statements ----
  private parseBlock(): A.Stmt[] {
    this.eat("{");
    const stmts: A.Stmt[] = [];
    while (!this.at("}") && !this.at("eof")) stmts.push(this.parseStmt());
    this.eat("}");
    return stmts;
  }

  private parseStmt(): A.Stmt {
    const t = this.peek();
    switch (t.type) {
      case "spawn": return this.parseSpawn();
      case "awake": { this.next(); const name = this.eat("ident").value; this.eat(";"); return { kind: "awake", name, pos: t.pos }; }
      case "sleep": { this.next(); const name = this.eat("ident").value; this.eat(";"); return { kind: "sleep", name, pos: t.pos }; }
      case "emit": return this.parseInvoke("emit");
      case "perform": return this.parseInvoke("perform");
      case "say": { this.next(); this.eat("("); const arg = this.parseExpr(); this.eat(")"); this.eat(";"); return { kind: "say", arg, pos: t.pos }; }
      case "return": { this.next(); let value: A.Expr | undefined; if (!this.at(";")) value = this.parseExpr(); this.eat(";"); return { kind: "return", value, pos: t.pos }; }
      case "if": return this.parseIf();
      case "when": return this.parseWhen();
      case "mem": {
        // memdecl ::= "mem" Ident ("<-" expr)? ";"  (§10)
        this.next();
        const name = this.eat("ident").value;
        let init: A.Expr | undefined;
        if (this.at("<-")) { this.next(); init = this.parseExpr(); }
        this.eat(";");
        return { kind: "memdecl", name, init, pos: t.pos };
      }
      case "forget": {
        // forget ::= "forget" Ident ";"  (§10)
        this.next();
        const name = this.eat("ident").value;
        this.eat(";");
        return { kind: "forget", name, pos: t.pos };
      }
      case "complete": {
        // complete ::= "complete" expr ";"  (§6c) — resolve the active assigned task programmatically.
        this.next();
        const value = this.parseExpr();
        this.eat(";");
        return { kind: "complete", value, pos: t.pos };
      }
      case "fail": {
        // fail ::= "fail" expr ";"  (§6c) — fail the active assigned task with a text reason.
        this.next();
        const reason = this.parseExpr();
        this.eat(";");
        return { kind: "fail", reason, pos: t.pos };
      }
      case "cancel": {
        // cancel ::= "cancel" postfix ";"  (§6c) — delegator-side cooperative cancellation.
        this.next();
        const handle = this.parsePostfix();
        this.eat(";");
        return { kind: "cancel", handle, pos: t.pos };
      }
      case "independent":
      case "dependent": {
        // depdecl ::= ("independent"|"dependent") Ident ("," Ident)* ";"  (§12, §15.2) — declares the
        // dependence structure of a fused Credence set.
        const relation = t.type as "independent" | "dependent";
        this.next();
        const names: string[] = [this.eat("ident").value];
        while (this.at(",")) { this.next(); names.push(this.eat("ident").value); }
        this.eat(";");
        return { kind: "depdecl", relation, names, pos: t.pos };
      }
    }
    // retry ::= "{" stmt* "}" "retry" "(" Int ")"  (§11) — the only loop, bounded. A bare block at statement
    // position is always a retry block (there is no other bare-block statement in the grammar).
    if (this.at("{")) {
      const body = this.parseBlock();
      this.eat("retry");
      this.eat("(");
      const n = this.int();
      this.eat(")");
      return { kind: "retry", body, n, pos: t.pos };
    }
    // gate dispatch / gate expr-statement
    if (this.at("decide") || this.at("endorse") || (this.at("ident") && this.peek(1).type === "decide")) {
      const gate = this.parseGate();
      if (this.at("{")) return this.parseDispatch(gate);
      this.eat(";");
      return { kind: "exprstmt", expr: gate, pos: gate.pos };
    }
    // vardecl?  (Type Ident ...)
    if (this.looksLikeVarDecl()) return this.parseVarDecl();
    // assign or expr statement
    const expr = this.parseExpr();
    if (this.at("=")) {
      this.next();
      const value = this.parseExpr();
      this.eat(";");
      return { kind: "assign", target: expr, value, pos: t.pos };
    }
    this.eat(";");
    return { kind: "exprstmt", expr, pos: t.pos };
  }

  private looksLikeVarDecl(): boolean {
    const save = this.i;
    try {
      const t = this.peek();
      if (t.type === "event") return true;
      const typeStart = t.type === "int" || t.type === "float" || t.type === "bool" || t.type === "text" ||
        t.type === "null" || t.type === "event" || t.type === "array" ||
        // a type name is conventionally capitalized; a QUALIFIED type head may be a lowercase MODULE
        // prefix (`geometry.Shape s`, §19.2), recognized by the following `.` (an expr `obj.field = …`
        // is distinguished below: after the dotted type parse it is NOT followed by a var-name ident).
        (t.type === "ident" && (/^[A-Z]/.test(t.value) || this.peek(1).type === "."));
      if (!typeStart) return false;
      this.parseType();
      const ok = this.at("ident");
      return ok;
    } catch {
      return false;
    } finally {
      this.i = save;
    }
  }

  private parseVarDecl(): A.VarDecl {
    const pos = this.peek().pos;
    const type = this.parseType();
    const name = this.eat("ident").value;
    let init: A.Expr | undefined;
    if (this.at("=")) {
      this.next();
      init = this.parseExpr();
    }
    this.eat(";");
    return { kind: "var", type, name, init, pos };
  }

  private parseSpawn(): A.SpawnStmt {
    const pos = this.eat("spawn").pos;
    // the spawned agent type may be QUALIFIED (`spawn m.Worker w`, §19.2).
    const agentType = this.qname();
    const name = this.eat("ident").value;
    let args: A.Expr[] = [];
    if (this.at("(")) args = this.parseArgs();
    this.eat(";");
    return { kind: "spawn", agentType, name, args, pos };
  }

  private parseInvoke(kind: "emit" | "perform"): A.Stmt {
    const pos = this.next().pos;
    // the emitted event / performed action may be QUALIFIED (`emit a.Tick(1)`, `perform m.Secret(..)`, §19.2).
    const name = this.qname();
    const args = this.at("(") ? this.parseArgs() : [];
    this.eat(";");
    return { kind, name, args, pos } as A.EmitStmt | A.PerformStmt;
  }

  private parseIf(): A.IfStmt {
    const pos = this.eat("if").pos;
    this.eat("(");
    const cond = this.parseExpr();
    this.eat(")");
    const then = this.parseBlock();
    let els: A.Stmt[] | undefined;
    if (this.at("else")) {
      this.next();
      // `else if …` is an else-body containing a single nested `if` statement (the standard chain);
      // a plain `else { … }` is a block. Both land as the `else` statement list.
      if (this.at("if")) els = [this.parseIf()];
      else els = this.parseBlock();
    }
    return { kind: "if", cond, then, else: els, pos };
  }

  private parseDispatch(gate: A.GateExpr): A.DispatchStmt {
    const pos = gate.pos;
    this.eat("{");
    const arms: A.Arm[] = [];
    while (!this.at("}") && !this.at("eof")) {
      // armhead: Ident | true | false
      let head: string;
      if (this.at("true")) { head = "true"; this.next(); }
      else if (this.at("false")) { head = "false"; this.next(); }
      else head = this.eat("ident").value;
      let binder: string | undefined;
      if (this.atIdent("as")) {
        this.next();
        binder = this.eat("ident").value;
      }
      const body = this.parseBlock();
      arms.push({ head, binder, body });
    }
    this.eat("}");
    let abstain: { binder?: string; body: A.Stmt[] } | undefined;
    if (this.at("abstain")) {
      this.next();
      let binder: string | undefined;
      if (this.atIdent("as")) {
        this.next();
        binder = this.eat("ident").value;
      }
      abstain = { binder, body: this.parseBlock() };
    }
    if (this.at(";")) this.next();
    return { kind: "dispatch", gate, arms, abstain, pos };
  }

  // ---- expressions ----
  private parseExpr(): A.Expr {
    // The top-level ledger query form is its own production (§15.2 expr grammar). `select` is contextual:
    // only a query here when followed by the query's shape.
    if (this.at("select") && this.startsSelect()) return this.parseSelect();
    return this.parseSend();
  }

  // `select` opens a query when followed by `*`, an Ident-list projection, or `Event as e`.
  private startsSelect(): boolean {
    return this.peek(1).type === "*" || this.peek(1).type === "ident";
  }

  private parseSend(): A.Expr {
    let left = this.parsePipe();
    // `<-` send/store and `->` recall share precedence (§10/§15.2 expr grammar); both are right-associative.
    if (this.at("<-")) {
      const pos = this.next().pos;
      const message = this.parsePipe();
      // `expires EXPR` (§6): any settled numeric expression, not only a literal.
      let expires: A.Expr | undefined;
      if (this.atIdent("expires")) {
        this.next();
        expires = this.parseGateOrBinary();
      }
      return { kind: "send", dest: left, message, expires, pos };
    }
    if (this.at("->")) {
      const pos = this.next().pos;
      const query = this.parsePipe();
      return { kind: "recall", mem: left, query, pos };
    }
    return left;
  }

  // pipe ::= expr "|>" expr  (§12, §15.2) — binds tighter than `<-`/`->`, looser than gates/binaries.
  // Left-associative: `a |> f |> g` = `(a |> f) |> g`.
  private parsePipe(): A.Expr {
    let left = this.parseGateOrBinary();
    while (this.at("|>")) {
      const pos = this.next().pos;
      const fn = this.parseGateOrBinary();
      left = { kind: "pipe", source: left, fn, pos };
    }
    return left;
  }

  // select ::= "select" (Ident ("," Ident)* | "*") "from" "ledger" "where" "{" cond "}"  (§10)
  //         | "select" Ident "as" Ident "from" "ledger" "where" "{" cond "}"
  private parseSelect(): A.SelectExpr {
    const pos = this.eat("select").pos;
    const save = this.i;
    if (this.at("ident")) {
      try {
        const eventType = this.qname();
        if (this.atIdent("as")) {
          this.next();
          const alias = this.eat("ident").value;
          this.eat("from");
          const targetName = this.colName();
          if (targetName !== "ledger") this.err("expected 'ledger'");
          const target: "ledger" = "ledger";
          this.eat("where");
          const cond = this.parseQueryCond();
          return { kind: "select", cols: "*", target, eventType, alias, cond, pos };
        }
      } catch {
        // Restore and let the projection form produce the user's syntax error.
      }
      this.i = save;
    }
    let cols: string[] | "*";
    if (this.at("*")) { this.next(); cols = "*"; }
    else {
      const cs: string[] = [this.colName()];
      while (this.at(",")) { this.next(); cs.push(this.colName()); }
      cols = cs;
    }
    this.eat("from");
    const targetName = this.colName();
    if (targetName !== "ledger") this.err("expected 'ledger'");
    const target: "ledger" = "ledger";
    this.eat("where");
    const cond = this.parseQueryCond();
    return { kind: "select", cols, target, cond, pos };
  }


  // a where-condition body: `{ field op value (&& | || field op value)* }`. A bare `field: value`
  // is sugar for `field == value` (§10 — the suite uses both the `:` and the explicit-op forms).
  private parseQueryCond(): A.QueryCond[] {
    this.eat("{");
    const conds: A.QueryCond[] = [];
    let connective: "&&" | "||" | undefined;
    while (!this.at("}") && !this.at("eof")) {
      const field = this.queryFieldName();
      let op: string;
      if (this.at(":")) { this.next(); op = "=="; }
      else {
        const t = this.peek().type;
        if (["==", "!=", "<", ">", "<=", ">="].includes(t)) { op = t; this.next(); }
        else this.err("expected a comparison operator or ':' in a query condition");
      }
      const value = this.parseAdd();
      conds.push({ field, op, value, connective });
      connective = undefined;
      if (this.at("&&")) { connective = "&&"; this.next(); }
      else if (this.at("||")) { connective = "||"; this.next(); }
    }
    this.eat("}");
    return conds;
  }

  // an operand inside a `find` triple, or a column/target name: an Ident, a contextual keyword,
  // or a literal rendered to its text.
  private operandName(): string {
    const t = this.peek();
    if (t.type === "ident" || CONTEXTUAL.has(t.type)) { this.next(); return t.value; }
    if (t.type === "string") { this.next(); return t.value; }
    if (t.type === "int" || t.type === "float") { this.next(); return t.value; }
    this.err("expected an operand");
  }
  private colName(): string {
    const t = this.peek();
    if (t.type === "ident" || CONTEXTUAL.has(t.type)) { this.next(); return t.value; }
    this.err("expected a name");
  }
  private queryFieldName(): string {
    let name = this.colName();
    while (this.at(".")) {
      this.next();
      name += "." + this.colName();
    }
    return name;
  }
  // a member/accessor field name: an ident, or a keyword token used positionally as a name (§2: keywords are
  // matched positionally), so `.text`, `.body`, `.committed`, etc. are valid field accessors.
  private fieldName(): string {
    const t = this.peek();
    if (t.type === "ident" || /^[A-Za-z_]\w*$/.test(t.value)) { this.next(); return t.value; }
    this.err("expected a field name");
  }

  private parseGateOrBinary(): A.Expr {
    // a decide, optionally with a `<principal> decide` prefix (an ident — a declared principal — or, to
    // produce a clean TypeError, a STRING literal in the prefix position: `"alice" decide c`, §3/§13).
    if (this.at("decide") || this.at("endorse") ||
        ((this.at("ident") || this.at("string")) && this.peek(1).type === "decide")) {
      return this.parseGate();
    }
    return this.parseComparison();
  }

  private parseGate(): A.GateExpr {
    if (this.at("endorse")) {
      const pos = this.next().pos;
      const subject = this.parseComparison();
      this.eatIdent("by");
      const decision = this.parseComparison();
      return { kind: "endorse", subject, decision, pos };
    }
    // decide, optionally principal-prefixed. The prefix is a declared `principal` ident; a STRING literal in
    // the prefix position parses but is flagged for a TypeError (a principal is not a text claim, §3/§13).
    let principal: string | undefined;
    let principalStr = false;
    let pos = this.peek().pos;
    if ((this.at("ident") || this.at("string")) && this.peek(1).type === "decide") {
      principalStr = this.at("string");
      principal = this.next().value;
    }
    pos = this.eat("decide").pos;
    const credence = this.parseComparison();
    this.eatIdent("by");
    const rule = this.parseRule();
    return { kind: "decide", principal, principalStr, credence, rule, pos };
  }

  private parseRule(): A.Rule {
    if (this.atIdent("confidence")) {
      this.next();
      const theta = this.number();
      let margin: number | undefined;
      if (this.atIdent("margin")) {
        this.next();
        margin = this.number();
      }
      let floor: number | undefined;
      if (this.atIdent("floor")) {
        this.next();
        floor = this.number();
      }
      return { kind: "confidence", theta, margin, floor };
    }
    if (this.atIdent("conformal")) {
      this.next();
      let alpha: number | undefined;
      if (this.at("int") || this.at("float")) alpha = this.number();
      // conformal carries optional `readiness N` (labelled-case minimum) then optional `floor m`.
      let readiness: number | undefined;
      if (this.atIdent("readiness")) {
        this.next();
        readiness = this.number();
      }
      let floor: number | undefined;
      if (this.atIdent("floor")) {
        this.next();
        floor = this.number();
      }
      return { kind: "conformal", alpha, readiness, floor };
    }
    if (this.at("(")) {
      this.next();
      const expr = this.parseExpr();
      this.eat(")");
      return { kind: "expr", expr };
    }
    // a named policy
    const name = this.eat("ident").value;
    return { kind: "policy", name };
  }

  private number(): number {
    const t = this.peek();
    if (t.type !== "int" && t.type !== "float") this.err("expected a number");
    this.next();
    return Number(t.value);
  }

  // an INT literal only (grammar positions that require an `Int`, e.g. the `quorum` threshold k, §15.2).
  // A float token here is a syntax error rather than being silently truncated.
  private int(): number {
    const t = this.peek();
    if (t.type !== "int") this.err("expected an integer literal");
    this.next();
    return Number(t.value);
  }

  private parseComparison(): A.Expr {
    let left = this.parseAdd();
    const ops = ["==", "!=", "<", ">", "<=", ">="];
    if (ops.includes(this.peek().type)) {
      const op = this.next();
      const right = this.parseAdd();
      return { kind: "binary", op: op.type, left, right, pos: op.pos };
    }
    return left;
  }

  private parseAdd(): A.Expr {
    let left = this.parseMul();
    while (this.at("+") || this.at("-")) {
      const op = this.next();
      const right = this.parseMul();
      left = { kind: "binary", op: op.type, left, right, pos: op.pos };
    }
    return left;
  }

  private parseMul(): A.Expr {
    let left = this.parseUnary();
    while (this.at("*") || this.at("/")) {
      const op = this.next();
      const right = this.parseUnary();
      left = { kind: "binary", op: op.type, left, right, pos: op.pos };
    }
    return left;
  }

  private parseUnary(): A.Expr {
    if (this.at("!") || this.at("-")) {
      const op = this.next();
      const operand = this.parseUnary();
      return { kind: "unary", op: op.type, operand, pos: op.pos };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): A.Expr {
    let e = this.parsePrimary();
    for (;;) {
      if (this.at("[")) {
        const pos = this.next().pos;
        const index = this.parseExpr();
        this.eat("]");
        e = { kind: "index", obj: e, index, pos };
      } else if (this.at(".")) {
        const pos = this.next().pos;
        const field = this.fieldName();
        e = { kind: "member", obj: e, field, pos };
      } else if (this.at("<") && this.callTypeArgsAhead()) {
        // a generic call `id<int>(5)` (§19.5): consume the `<typeargs>` immediately before the argument
        // list. Monomorphization is lenient in v0 — the type arguments are erased. Only consumed when the
        // `<…>` is a complete type-argument list DIRECTLY followed by `(`, so `a < b` comparisons are safe.
        this.parseTypeArgs();
        const args = this.parseArgs();
        e = { kind: "call", callee: e, args, pos: e.pos };
      } else if (this.at("(")) {
        const args = this.parseArgs();
        e = { kind: "call", callee: e, args, pos: e.pos };
      } else break;
    }
    return e;
  }

  // Lookahead: does a complete type-argument list `< type (, type)* >` start here AND is it immediately
  // followed by a `(`? Only then does the `<` open a generic call (`id<int>(5)`); otherwise the `<` is a
  // comparison operator and must be left for `parseComparison`.
  private callTypeArgsAhead(): boolean {
    const save = this.i;
    try {
      this.parseTypeArgs();
      return this.at("(");
    } catch {
      return false;
    } finally {
      this.i = save;
    }
  }

  // typeargs ::= "<" type ("," type)* ">"  (§19.5). Consumed and returned at an instantiation site.
  private parseTypeArgs(): A.TypeRef[] {
    this.eat("<");
    const args: A.TypeRef[] = [this.parseType()];
    while (this.at(",")) { this.next(); args.push(this.parseType()); }
    this.eat(">");
    return args;
  }

  private parseArgs(): A.Expr[] {
    this.eat("(");
    const args: A.Expr[] = [];
    while (!this.at(")")) {
      args.push(this.parseExpr());
      if (this.at(",")) this.next();
    }
    this.eat(")");
    return args;
  }

  private parsePrimary(): A.Expr {
    const t = this.peek();
    // §3: a bare gate RULE (`confidence θ`, `conformal α`) in a value/expression position is not first-class —
    // parse it as a non-storable placeholder so the surrounding context (e.g. a `Rule r = …` binding) reports a
    // TypeError (a Rule is the gate parameter, never a stored value) rather than a ParseError.
    if ((this.atIdent("confidence") || this.atIdent("conformal")) &&
        (this.peek(1).type === "int" || this.peek(1).type === "float")) {
      this.next(); this.number();
      if (this.atIdent("margin") && (this.peek(1).type === "int" || this.peek(1).type === "float")) { this.next(); this.number(); }
      return { kind: "ident", name: "__rule__", pos: t.pos };
    }
    if (this.atIdent("md") && this.peek(1).type === "string") {
      const pos = this.next().pos;
      const path = this.next().value;
      return { kind: "mdimport", path, pos };
    }
    switch (t.type) {
      case "int": this.next(); return { kind: "int", value: Number(t.value), pos: t.pos };
      case "float": this.next(); return { kind: "float", value: Number(t.value), pos: t.pos };
      case "string": this.next(); return { kind: "string", value: t.value, pos: t.pos };
      case "fstring": this.next(); return this.buildFString(t.fparts!, t.pos);
      case "promptmd": this.next(); return this.buildFString(t.fparts!, t.pos);
      case "true": this.next(); return { kind: "bool", value: true, pos: t.pos };
      case "false": this.next(); return { kind: "bool", value: false, pos: t.pos };
      case "abstained": this.next(); return { kind: "ident", name: "abstained", pos: t.pos };
      case "null": this.next(); return { kind: "null", pos: t.pos };
      case "self": this.next(); return { kind: "self", pos: t.pos };
      case "spawn": {
        // the EXPRESSION form: `spawn Type (args)?` with no instance name — mints a fresh instance
        // per evaluation (the statement form `spawn Type name;` keeps its own parse path). §6/§15.4.
        this.next();
        const agentType = this.qname();
        const args = this.at("(") ? this.parseArgs() : [];
        return { kind: "spawnexpr", agentType, args, pos: t.pos };
      }
      case "ident": {
        this.next();
        // a QUALIFIED struct-literal head `geo.Shape { … }` / `facade.internal.Shape { … }` (§19.2): if a
        // `.` follows, tentatively read the dotted name and only KEEP it when it heads a struct literal
        // (`typeargs? { field: … }`). Otherwise restore, so an ordinary `M.member` expression continues to
        // parse through parsePostfix exactly as before (the conservative rule the plan requires).
        let typeName = t.value;
        if (this.at(".")) {
          const save = this.i;
          let dotted = t.value;
          while (this.at(".") && this.peek(1).type === "ident") { this.next(); dotted += "." + this.next().value; }
          const headsStructLit =
            (this.at("{") && this.looksLikeStructBody()) ||
            (this.at("<") && this.structLitTypeArgsAhead());
          if (headsStructLit) typeName = dotted;
          else this.i = save; // not a qualified struct literal — leave the `.` for parsePostfix
        }
        // a generic struct literal `Box<int> { value: 7 }` (§19.5): consume the `<typeargs>` before the
        // body. Only when the `<…>` is a complete type-argument list directly followed by a struct body,
        // so `a < b` comparisons stay unaffected.
        let typeArgs: A.TypeRef[] | undefined;
        if (this.at("<") && this.structLitTypeArgsAhead()) typeArgs = this.parseTypeArgs();
        // a qualified/typed struct literal: `TypeName typeargs? { field: expr, … }` (§15.2 primary).
        if (this.at("{") && this.looksLikeStructBody()) return this.parseStructLit(typeName, t.pos, typeArgs);
        return { kind: "ident", name: t.value, pos: t.pos };
      }
      case "{": return this.parseStructLit(undefined, t.pos); // a bare struct literal `{ f: e, … }`
      case "(": { this.next(); const e = this.parseExpr(); this.eat(")"); return e; }
      case "[": return this.parseArrayLit(t.pos); // an array literal `[e, …]` (§15.2 primary)
      case "task": return this.parseTaskLit(t.pos); // a TaskSpec-building task literal (§6c)
      case "perform": {
        // §6b foreground perform binding — an EXPRESSION-position perform (`T r = perform A(…) expires N`).
        // Statement-position performs never reach here (parseStmt handles them first).
        this.next();
        const name = this.qname();
        const args = this.at("(") ? this.parseArgs() : [];
        let expires: A.Expr | undefined;
        if (this.atIdent("expires")) {
          this.next();
          expires = this.parseGateOrBinary();
        }
        return { kind: "performexpr", name, args, expires, pos: t.pos };
      }
    }
    // `all`/`any`/`quorum` are contextual (§2): a fusion reducer only when immediately followed by `(`;
    // otherwise the word is an ordinary identifier in name-position.
    if ((t.type === "all" || t.type === "any") && this.peek(1).type === "(") {
      this.next(); // the all/any keyword
      this.eat("(");
      const operands: A.Expr[] = [];
      while (!this.at(")") && !this.at("eof")) {
        operands.push(this.parseExpr());
        if (this.at(",")) this.next();
      }
      this.eat(")");
      return { kind: "agg", op: t.type as "all" | "any", operands, pos: t.pos };
    }
    if (t.type === "quorum" && this.peek(1).type === "(") {
      this.next(); // the quorum keyword
      this.eat("(");
      // quorum ::= "quorum" "(" Int "," expr ")"  — k is an INT literal per the grammar (§15.2); a float
      // threshold (`quorum(2.5, …)`) is a syntax error, not silently truncated.
      const k = this.int();
      this.eat(",");
      const source = this.parseExpr();
      this.eat(")");
      return { kind: "quorum", k, source, pos: t.pos };
    }
    // a bare contextual `all`/`any`/`quorum` (not followed by `(`) is an ordinary identifier name.
    if (CONTEXTUAL.has(t.type)) {
      this.next();
      return { kind: "ident", name: t.value, pos: t.pos };
    }
    this.err("expected an expression");
  }

  // a `{` begins a struct-literal body when it is `{ Ident : … }` (or the empty `{}`); otherwise the
  // caller's `{` is something else (an armblock tail, a block) and we must not consume it here.
  private looksLikeStructBody(): boolean {
    if (this.peek(1).type === "}") return true; // `{}`
    const fieldTok = this.peek(1);
    const isName = fieldTok.type === "ident" || CONTEXTUAL.has(fieldTok.type);
    return isName && this.peek(2).type === ":";
  }

  // Lookahead: does a complete type-argument list `< type (, type)* >` start here AND is it immediately
  // followed by a struct-literal body? Only then does the `<` open a generic struct literal (`Box<int>{…}`);
  // otherwise the `<` is a comparison operator.
  private structLitTypeArgsAhead(): boolean {
    const save = this.i;
    try {
      this.parseTypeArgs();
      return this.at("{") && this.looksLikeStructBody();
    } catch {
      return false;
    } finally {
      this.i = save;
    }
  }

  // structlit ::= TypeName? typeargs? "{" (Ident ":" expr ("," Ident ":" expr)*)? "}"  (§15.2 primary)
  private parseStructLit(typeName: string | undefined, pos: { line: number; col: number }, typeArgs?: A.TypeRef[]): A.StructLit {
    this.eat("{");
    const fields: { name: string; value: A.Expr }[] = [];
    while (!this.at("}") && !this.at("eof")) {
      const name = this.colName();
      this.eat(":");
      const value = this.parseExpr();
      fields.push({ name, value });
      if (this.at(",")) this.next();
    }
    this.eat("}");
    return { kind: "structlit", typeName, typeArgs, fields, pos };
  }

  // tasklit ::= "task" "{" taskclause* "}"  (§6c) — builds a TaskSpec. Clauses are contextual:
  //   "objective" expr ";" | "acceptance" expr ";" | "scope" "{" "perform" Ident ("," "perform" Ident)* "}" ";"?
  // Missing objective/acceptance is recorded here and rejected as a TypeError by the checker/runtime.
  private parseTaskLit(pos: { line: number; col: number }): A.TaskLit {
    this.eat("task");
    this.eat("{");
    let objective: A.Expr | undefined;
    let acceptance: A.Expr | undefined;
    const scope: string[] = [];
    while (!this.at("}") && !this.at("eof")) {
      if (this.atIdent("objective")) {
        this.next();
        objective = this.parseExpr();
        this.eat(";");
      } else if (this.atIdent("acceptance")) {
        this.next();
        acceptance = this.parseExpr();
        this.eat(";");
      } else if (this.atIdent("scope")) {
        this.next();
        this.eat("{");
        while (!this.at("}") && !this.at("eof")) {
          this.eat("perform");
          scope.push(this.eat("ident").value);
          if (this.at(",")) this.next();
        }
        this.eat("}");
        if (this.at(";")) this.next();
      } else {
        this.err("expected a task clause (`objective`, `acceptance`, or `scope { perform … }`)");
      }
    }
    this.eat("}");
    return { kind: "tasklit", objective, acceptance, scope, pos };
  }

  // arraylit ::= "[" (expr ("," expr)*)? "]"  (§15.2 primary) — consumed by |>/all/any/quorum.
  private parseArrayLit(pos: { line: number; col: number }): A.ArrayLit {
    this.eat("[");
    const items: A.Expr[] = [];
    while (!this.at("]") && !this.at("eof")) {
      items.push(this.parseExpr());
      if (this.at(",")) this.next();
    }
    this.eat("]");
    return { kind: "arraylit", items, pos };
  }

  private buildFString(fparts: FStringPart[], pos: { line: number; col: number }): A.FStringExpr {
    const parts = fparts.map((p) =>
      p.kind === "text"
        ? ({ kind: "text", text: p.text } as const)
        : ({ kind: "expr", expr: parseExprFragment(p.src) } as const)
    );
    return { kind: "fstring", parts, pos };
  }
}

function parseExprFragment(src: string): A.Expr {
  const p = new Parser(lex(src));
  // @ts-expect-error access private for a self-contained fragment parse
  return p.parseExpr();
}
