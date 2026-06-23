from dataclasses import dataclass


# ---- Expressions: things that produce a value ----

@dataclass
class StringLit:
    value: str                  # "John"  ->  StringLit("John")


@dataclass
class Name:
    ident: str                  # X       ->  Name("X")


@dataclass
class Ref:
    ident: str                  # *HelloWorld -> Ref("HelloWorld")  (reference-to)


@dataclass
class Send:
    target: str                 # the agent/mem name on the left of <-
    payload: "Expr"             # the expression being sent in
    # HelloWorld <- "hi"  ->  Send("HelloWorld", StringLit("hi"))


@dataclass
class Verify:
    event: "Expr"               # first arg: the event to check
    expected: "Expr"            # second arg: what to compare against
    # verify(Y, "John") -> Verify(Name("Y"), StringLit("John"))


# ---- Statements: things that DO something, don't produce a value ----

@dataclass
class AgentDecl:
    name: str                   # agent HelloWorld; -> AgentDecl("HelloWorld")


@dataclass
class MemBind:
    name: str                   # the variable name on the left of =
    expr: "Expr"                # mem X = *HelloWorld; -> MemBind("X", Ref("HelloWorld"))


@dataclass
class EventBind:
    name: str
    expr: "Expr"                # event Y = HelloWorld <- "..."; -> EventBind("Y", Send(...))


@dataclass
class ExprStmt:
    expr: "Expr"                # verify(Y, "John"); -> ExprStmt(Verify(...))
