"""agape_ast.py — AST dataclasses for the Agape language (new spec)."""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any, Optional, List


# ── Type nodes ───────────────────────────────────────────────────────────────

@dataclass
class SimpleType:
    name: str  # "int", "float", "bool", "text", "null", or user type "Verdict"

@dataclass
class EventType:
    inner: Any  # T in event<T>; another TypeNode


# ── Expressions ──────────────────────────────────────────────────────────────

@dataclass
class IntLit:
    value: int

@dataclass
class FloatLit:
    value: float

@dataclass
class BoolLit:
    value: bool

@dataclass
class NullLit:
    pass

@dataclass
class StrLit:
    value: str

@dataclass
class FStrLit:
    template: str  # raw template with {ident} markers intact

@dataclass
class Name:
    ident: str

@dataclass
class BinOp:
    op: str   # "+", "-", "*", "/", "==", "!=", "<", ">", "<=", ">=", "~"
    left: Any
    right: Any

@dataclass
class UnaryOp:
    op: str   # "!"
    expr: Any

@dataclass
class Call:
    func: Any   # Name or MemberAccess
    args: List[Any]

@dataclass
class MemberAccess:
    obj: Any
    prop: str

@dataclass
class SendExpr:
    dest: str        # agent name (identifier)
    payload: Any
    retry_n: int = 0
    retry_body: List[Any] = field(default_factory=list)

@dataclass
class EntailExpr:
    expr: Any   # left side (an event<text>)
    claim: Any  # right side (a string expression)

@dataclass
class PipeExpr:
    source: Any
    func: Any   # Name referencing a function

@dataclass
class VerifyExpr:
    """verify used as a value (capturable into event<Verification>)."""
    left: Any
    op: Optional[str] = None   # "~" or "==" or None (bare bool check)
    right: Any = None


# ── Statements ───────────────────────────────────────────────────────────────

@dataclass
class VarDecl:
    """TYPE NAME = EXPR;  or  event<T> NAME = EXPR;  or  event<T> NAME;"""
    type_node: Any   # SimpleType or EventType
    name: str
    expr: Any        # None if uninitialized field declaration

@dataclass
class AssignStmt:
    """NAME = EXPR;  or  self.PROP = EXPR;"""
    target: Any   # Name or MemberAccess
    expr: Any

@dataclass
class FnDecl:
    is_async: bool
    ret_type: Any    # TypeNode
    name: str
    params: List[tuple]   # [(type_node, param_name), ...]
    body: List[Any]

@dataclass
class AgentDecl:
    name: str
    params: List[tuple]   # [(type_node, param_name), ...]
    body: List[Any]       # mix of VarDecl, WhenStmt, OnAwake, OnSleep, ExtendStmt, …

@dataclass
class ExtendStmt:
    parent: str
    args: List[Any]

@dataclass
class OnAwake:
    body: List[Any]

@dataclass
class OnSleep:
    body: List[Any]

@dataclass
class SpawnStmt:
    agent_type: str
    name: str
    args: List[Any]

@dataclass
class AwakeStmt:
    name: str

@dataclass
class SleepStmt:
    name: str

@dataclass
class VerifyStmt:
    left: Any
    op: Optional[str]    # "~" or "==" or None (bare bool check)
    right: Any = None

@dataclass
class EmitStmt:
    event_type: str
    payload: Any

@dataclass
class FindStmt:
    binding: str
    pattern: List[tuple]   # [(subj_str, pred_str, obj_str), ...]

@dataclass
class SelectStmt:
    cols: List[str]
    agent: str
    raw: str   # raw condition text (stub for POC)

@dataclass
class MatchStmt:
    binding: str
    query: Any
    threshold: float

@dataclass
class CaseStmt:
    expr: Any
    binding: str
    arms: List[tuple]              # [(variant_str, body_list), ...]
    default_body: Optional[List[Any]]

@dataclass
class CatchStmt:
    event_type: Optional[str]   # None = inferred from subject's type
    subject: Any                # expression (Name, Call, …)
    binding: str
    body: List[Any]

@dataclass
class WhenStmt:
    subject: Any   # expression
    body: List[Any]

@dataclass
class IfStmt:
    cond: Any
    then_body: List[Any]
    else_body: List[Any]

@dataclass
class RetryBlockStmt:
    n: int
    body: List[Any]

@dataclass
class ReturnStmt:
    expr: Any

@dataclass
class SayStmt:
    expr: Any

@dataclass
class ExprStmt:
    expr: Any
