from dataclasses import dataclass, field


# ===== Expressions: things that produce a value =========================

@dataclass
class StringLit:
    value: str                  # "John" -> StringLit("John")


@dataclass
class FStringLit:
    """f"Your name is {n}." — template with {varname} slots.
    The evaluator resolves each {name} by looking it up in scope at runtime.
    Template is stored verbatim: "Your name is {n}."
    """
    template: str


@dataclass
class Name:
    ident: str                  # X -> Name("X")


@dataclass
class Send:
    target: str                 # the agent on the receiving end
    payload: "object"           # the expression being sent
    # BOTH  Coach <- "hi"  AND  "hi" -> Coach  parse to the SAME node.
    # Both arrows erased here so downstream sees one concept.


@dataclass
class Compare:
    left: "object"
    op: str                     # "exact" (==), "semantic" (~), "identity" (is)
    right: "object"


@dataclass
class Call:
    func: str                   # say, all, any, is_it_john, ...
    args: list                  # [Expr, ...]


@dataclass
class PropertyAccess:
    """`obj.prop` — structural field access (exact, single, intrinsic).
    Distinct from graph queries (find/where) and somatic pointers (*/&).
    """
    obj: "object"               # the object expression
    prop: str                   # the field name


@dataclass
class ArrayLit:
    """Array literal: ["John", "Mary"]."""
    elements: list              # [Expr, ...]


@dataclass
class PipeExpr:
    """`source |> func` — applies func to each element of source.
    func is a Lambda (anonymous) or a Name (function reference, point-free).
    """
    source: "object"
    func: "object"


@dataclass
class Lambda:
    """`x: expr` — anonymous function for use in pipe expressions.
    Read as "x such that expr". Colon separates parameter from body.
    """
    param: str
    body: "object"


@dataclass
class UnaryOp:
    """`!expr` — boolean negation."""
    op: str                     # "not"
    expr: "object"


# ===== Statements: things that DO something =============================

@dataclass
class AgentDecl:
    """agent Coach(string n) { ... } — define an agent template."""
    name: str
    params: list                # [(type_name, param_name), ...] e.g. [("string","n")]
    body: list                  # statements inside { ... }


@dataclass
class SpawnStmt:
    """spawn Coach john("John") — create a named agent instance.
    Constructor body runs async. External sends queue until `awake`.
    """
    agent_type: str             # "Coach"
    name: str                   # "john"
    args: list                  # [Expr, ...] passed to the agent template


@dataclass
class AwakeStmt:
    """awake john — open the agent's external mailbox; queued sends flush."""
    name: str


@dataclass
class SleepStmt:
    """sleep john — close the mailbox; new sends queue.
    When the last reference drops the runtime GC's the agent automatically.
    """
    name: str


@dataclass
class EventDecl:
    """Typed event declaration.

    Inside an agent body:
      event<Verification> name_verification;   -- uninitialized property
      event<null> init = self <- f"...";       -- initialized on declaration

    At top level:
      event<text> Name = john <- "What is your name?";
    """
    event_type: str             # "text", "bool", "null", "Verification", ...
    name: str
    expr: "object"              # None if bare declaration (no = expr)


@dataclass
class TypedDecl:
    """Typed variable declaration: bool everyone_john = all(names |> f).
    is_array is True for bool[], string[], etc.
    """
    type_name: str              # "bool", "string", "int", ...
    is_array: bool
    name: str
    expr: "object"


@dataclass
class WhenStmt:
    """when (event_expr) { body } — fires when event_expr resolves successfully.
    Complement of Catch: when = success path, catch = failure/error path.
    Special form: when (sleep self) acts as a destructor.
    """
    event_expr: "object"        # the event expression to subscribe to
    body: list


@dataclass
class EmitStmt:
    """emit EventType(msg) — programmer-controlled event emission into the spine."""
    event_type: str             # "Event", "Error", ...
    message: "object"           # the payload expression


@dataclass
class ExtendStmt:
    """extend ParentAgent(args) — run parent constructor inside agent body."""
    parent: str
    args: list                  # [Expr, ...]


@dataclass
class IfStmt:
    """if (cond) { then } else { else_ } — standard conditional."""
    cond: "object"
    then: list
    else_: list                 # empty list if no else branch


@dataclass
class FnDecl:
    """fn ReturnType name(ParamType param, ...) { body } — named function."""
    return_type: str
    name: str
    params: list                # [(type_name, param_name), ...]
    body: list


@dataclass
class ReturnStmt:
    """return expr; — explicit return from a function."""
    expr: "object"


@dataclass
class PropertyAssign:
    """self.prop = expr — assign to an agent property inside its body."""
    obj: str                    # usually "self"
    prop: str
    value: "object"


@dataclass
class VerifyStmt:
    """verify expr — assert a condition.

    If expr is a bool, sugar for `verify expr == true`.
    On failure emits FailedVerificationEvent (not a throw).
    Capturable: event<Verification> v = verify expr;
    """
    check: "object"             # a Compare, a bool Name, or any truthy expr


@dataclass
class Catch:
    """catch EventType(source) as e { body }
       catch (verification_var) as e { body }  -- inferred-type form

    Standing subscription — fires for matching events whether emitted before
    this catch (retroactive) or after (prospective).
    Fires on the failure/error path; complement of WhenStmt.
    event_type is None in the inferred form.
    """
    event_type: "object"        # str like "FailedVerification", or None if inferred
    source: "object"            # source expression (Name, PropertyAccess, ...)
    binding: str                # name bound to the caught event (`as e`)
    body: list


@dataclass
class TriplePattern:
    """A single triple in a find/where query pattern.
    Names stored as raw strings — VALUE / TYPE / VARIABLE classification
    deferred to the evaluator (by what the name denotes in scope).
    """
    subject: str
    predicate: str
    object: str


@dataclass
class Find:
    """find result where { pattern } — triple-pattern query."""
    result: str
    pattern: list               # [TriplePattern, ...], AND-joined


@dataclass
class ExprStmt:
    """A bare expression used as a statement (a send or a call)."""
    expr: "object"


# ===== Legacy nodes ======================================================
# Kept only so existing tests still import cleanly.
# No longer produced by the new parser.

@dataclass
class EventBind:
    name: str
    expr: "object"

@dataclass
class Ref:
    ident: str

@dataclass
class MemBind:
    name: str
    expr: "object"

@dataclass
class Verify:
    event: "object"
    expected: "object"
