"""
The evaluator walks the AST and runs the Agape program under the new execution model.

THE SPINE (thesis #10): executing a line EMITS an EVENT that is either a success
or an error, into a single append-only LOG keyed by the event's source. Errors
are not a separate throwing mechanism; they are events of an error TYPE. `catch`
is a standing SUBSCRIPTION over that log — it fires for matching events whether
they were emitted before it ran (retroactive) or after (prospective).

find/where queries run over a program-level WORLD graph (a flat triple list) the
evaluator accumulates: type facts (X is_a Agent), event lineage (Name emitted_by
Coach), and agent facts (mirrored from private memory via learn()).
"""

import ast_nodes as A
from provider import Provider, cosine_similarity
from memory import Memory
from query import solve


# ---- runtime values ----

class AgentValue:
    def __init__(self, name):
        self.name = name
        self.memory = Memory()      # PRIVATE per agent
        self.last_event = None

    def __repr__(self):
        return f"<agent {self.name}>"


# ---- events: the Success|Error spine ----

class Event:
    def __init__(self, source, payload=None):
        self.source = source
        self.payload = payload

    def __repr__(self):
        return f"<{type(self).__name__} from {self.source}: {self.payload!r}>"

class ResponseEvent(Event):
    """An agent's emitted thought — the value a send produces."""

class Success(Event):
    """A line completed without error."""

class ErrorEvent(Event):
    """Base type for all errors. `catch Error(x)` matches this AND its subtypes."""

class FailedVerificationEvent(ErrorEvent):
    """Emitted by a failed `verify`."""

# `catch <Type>(...)` matches by this name -> class mapping, so catching a
# supertype (Error) also catches subtypes (FailedVerificationEvent) via isinstance.
EVENT_TYPES = {
    "Event": Event,
    "ResponseEvent": ResponseEvent,
    "Success": Success,
    "Error": ErrorEvent,
    "ErrorEvent": ErrorEvent,
    "FailedVerificationEvent": FailedVerificationEvent,
}


class Evaluator:
    def __init__(self, provider: Provider):
        self.provider = provider
        self.env = {}               # name -> runtime value
        self.log = []               # the append-only event log (the spine)
        self.handlers = []          # registered catch subscriptions
        self.handled = []           # (handler, event) pairs that fired (for tests)
        self.world = []             # program-level triple graph for find/where
        self.types = set(EVENT_TYPES) | {"Agent"}   # known type names

    def run(self, stmts):
        for stmt in stmts:
            self.exec_stmt(stmt)
        self._dump_log()

    # ---- the spine: emit + subscription dispatch ----

    def emit(self, event):
        self.log.append(event)
        for handler in self.handlers:           # PROSPECTIVE half of catch
            if self._matches(handler, event):
                self._fire(handler, event)
        return event

    def _matches(self, handler, event):
        cls = EVENT_TYPES.get(handler.event_type)
        return (cls is not None
                and isinstance(event, cls)
                and event.source == handler.source)

    def _fire(self, handler, event):
        self.handled.append((handler, event))   # observable for tests
        self.env[handler.binding] = event        # bind `as e`
        for stmt in handler.body:
            self.exec_stmt(stmt)

    # ---- facts ----

    def learn(self, agent_name, predicate, obj):
        """Record a fact in the agent's PRIVATE memory (keyed by self) AND the
        program-level world graph (keyed by the agent's name) so find/where can
        see it. In 2e cognition calls this; tests call it to seed deterministically."""
        self.env[agent_name].memory.store("self", predicate, obj)
        self.world.append((agent_name, predicate, obj))

    # ---- statements ----

    def exec_stmt(self, node):
        if isinstance(node, A.AgentDecl):  return self.exec_agent_decl(node)
        if isinstance(node, A.EventBind):  return self.exec_event_bind(node)
        if isinstance(node, A.VerifyStmt): return self.exec_verify(node)
        if isinstance(node, A.Catch):      return self.exec_catch(node)
        if isinstance(node, A.Find):       return self.exec_find(node)
        if isinstance(node, A.ExprStmt):   return self.eval_expr(node.expr)
        raise RuntimeError(f"unknown statement: {node!r}")

    def exec_agent_decl(self, node):
        self.env[node.name] = AgentValue(node.name)
        self.world.append((node.name, "is_a", "Agent"))   # type fact for queries
        # (2e: the agent will think about node.prompt and learn() facts from it.)
        print(f"[agent]  {node.name} declared")
        return self.emit(Success(source=node.name, payload="declared"))

    def exec_event_bind(self, node):
        value = self.eval_expr(node.expr)       # a ResponseEvent from a send
        self.env[node.name] = value
        if isinstance(node.expr, A.Send):       # record event lineage for queries
            self.world.append((node.name, "emitted_by", node.expr.target))
        print(f"[event]  {node.name} = {value!r}")
        return value

    def exec_verify(self, node):
        check = node.check                      # a Compare
        passed = self.eval_expr(check)          # -> bool
        source = check.left.ident if isinstance(check.left, A.Name) else None
        desc = self._describe(check)
        if passed:
            print(f"[verify] PASS   {desc}")
            return self.emit(Success(source=source, payload=f"verified: {desc}"))
        print(f"[verify] FAIL   {desc}")
        return self.emit(FailedVerificationEvent(source=source, payload=f"failed: {desc}"))

    def exec_catch(self, node):
        self.handlers.append(node)              # PROSPECTIVE: future events
        print(f"[catch]  subscribed to {node.event_type}({node.source})")
        for event in list(self.log):            # RETROACTIVE: events already logged
            if self._matches(node, event):
                self._fire(node, event)

    def exec_find(self, node):
        subs = solve(self.world, node.pattern, set(self.env), self.types)
        found = list(dict.fromkeys(s[node.result] for s in subs if node.result in s))
        # bind: a lone result is the value itself; otherwise the set (0 or many)
        self.env[node.result] = found[0] if len(found) == 1 else found
        print(f"[find]   {node.result} where {{...}} -> {found!r}")
        return self.emit(Success(source=node.result, payload=found))

    # ---- expressions (produce values) ----

    def eval_expr(self, node):
        if isinstance(node, A.StringLit): return node.value
        if isinstance(node, A.Name):
            if node.ident in self.env: return self.env[node.ident]
            raise RuntimeError(f"undefined name: {node.ident}")
        if isinstance(node, A.Send):    return self.eval_send(node)
        if isinstance(node, A.Compare): return self.eval_compare(node)
        if isinstance(node, A.Call):    return self.eval_call(node)
        raise RuntimeError(f"unknown expression: {node!r}")

    def eval_send(self, node):
        target = self.env.get(node.target)
        if not isinstance(target, AgentValue):
            raise RuntimeError(f"cannot send into {node.target!r}: not an agent")
        payload = self._as_text(self.eval_expr(node.payload))
        print(f"[send]   {node.target} <- {payload!r}  (thinking...)")
        response = self.provider.think(payload)     # cognition via the SEAM
        event = ResponseEvent(source=node.target, payload=response)
        target.last_event = event
        return self.emit(event)

    def eval_compare(self, node):
        left = self.eval_expr(node.left)
        right = self.eval_expr(node.right)
        if node.op == "identity":
            return left is right                # same ENTITY, not same content
        lt, rt = self._as_text(left), self._as_text(right)
        if node.op == "exact":
            return lt == rt
        if node.op == "semantic":
            score = cosine_similarity(self.provider.embed(lt), self.provider.embed(rt))
            return score >= 0.9
        raise RuntimeError(f"unknown comparison op: {node.op}")

    def eval_call(self, node):
        if node.func == "say":                  # I/O is a derived function
            for a in node.args:
                v = self.eval_expr(a)
                print("[say]   ", v if isinstance(v, Event) else self._as_text(v))
            return None
        raise RuntimeError(f"unknown function: {node.func}")

    # ---- helpers ----

    def _as_text(self, v):
        if isinstance(v, Event):
            return v.payload if v.payload is not None else ""
        return str(v) if v is not None else ""

    def _describe(self, check):
        op = {"exact": "==", "semantic": "~", "identity": "is"}[check.op]
        return f"{self._show(check.left)} {op} {self._show(check.right)}"

    def _show(self, node):
        if isinstance(node, A.Name): return node.ident
        if isinstance(node, A.StringLit): return repr(node.value)
        return repr(node)

    def _dump_log(self):
        print("\n=== event log (the spine: every line emitted one event) ===")
        for i, e in enumerate(self.log):
            print(f"  {i}: {e!r}")
