from dataclasses import dataclass, field


# ===== Expressions: things that produce a value =========================

@dataclass
class StringLit:
    value: str                  # "John" -> StringLit("John")


@dataclass
class Name:
    ident: str                  # X -> Name("X")


@dataclass
class Send:
    target: str                 # the agent on the receiving end
    payload: "object"           # the expression sent in
    # BOTH  Coach <- "hi"  AND  "hi" -> Coach  parse to the SAME node:
    #   Send("Coach", StringLit("hi"))
    # The two notations are erased here, so everything downstream sees one
    # concept. That's why "both arrows valid" costs nothing past the parser.


@dataclass
class Compare:
    left: "object"
    op: str                     # "exact" (==), "semantic" (~), "identity" (is)
    right: "object"
    # The comparison operators are GENERAL expression operators, not special to
    # verify. verify just asserts whatever Compare it's handed.


@dataclass
class Call:
    func: str                   # say
    args: list                  # [Expr, ...]   — I/O / derived ops are functions


# ===== Statements: things that DO something =============================

@dataclass
class AgentDecl:
    name: str
    prompt: "object" = None     # constructor string (system prompt), or None
    body: list = field(default_factory=list)   # statements inside { ... }


@dataclass
class EventBind:
    name: str
    expr: "object"              # event Name = Coach <- "..."


@dataclass
class VerifyStmt:
    check: "object"             # a Compare to assert; on failure emits
                                # a FailedVerificationEvent (not a throw)


@dataclass
class Catch:
    event_type: str             # FailedVerificationEvent, Error, ...
    source: str                 # the event whose failures we subscribe to
    binding: str                # name bound to the caught event (`as e`)
    body: list                  # handler statements
    # Parsed as a structured handler, NOT a try-wrapper — it's a subscription.


@dataclass
class TriplePattern:
    subject: str                # raw identifier text — NOT yet classified as
    predicate: str              # value / type / variable. That resolution is
    object: str                 # deferred to the evaluator (by what it denotes).


@dataclass
class Find:
    result: str                 # the variable to project out
    pattern: list               # [TriplePattern, ...], AND-joined


@dataclass
class ExprStmt:
    expr: "object"              # a bare send or call used as a statement


# ===== Legacy nodes ======================================================
# Kept only so the (about-to-be-rewritten) evaluator still imports cleanly.
# The new parser no longer produces these; they go away with Bite 2d.

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
