"""
The evaluator walks the AST and runs the organism.

Runtime value types (distinct on purpose, because your type rules depend on it):
  - AgentValue : a living agent. Remembers the last event it emitted.
  - EventValue : a concrete event = a payload string + who emitted it.
  - MemValue   : a memory cell holding some value (a ref, a string, etc.)
  - str        : a bare string literal payload

The agent->event cast happens ONLY at an event-typed boundary (verify's
first argument), never at plain name lookup. That's your rule.
"""

import ast_nodes as A
from provider import Provider, cosine_similarity
from memory import Memory


# ---- runtime values ----

class AgentValue:
    def __init__(self, name):
        self.name = name
        self.last_event = None      # the most recent EventValue this agent emitted
        self.memory = Memory()      # PRIVATE memory, per agent. Nothing is shared
                                    # unless the programmer explicitly wires up a
                                    # shared workspace (actor-model: share nothing).

    def __repr__(self):
        return f"<agent {self.name}>"


class EventValue:
    def __init__(self, payload, source):
        self.payload = payload      # the string content of the event
        self.source = source        # name of the agent that emitted it (or None)

    def __repr__(self):
        return f"<event from {self.source}: {self.payload!r}>"


class MemValue:
    def __init__(self, contents):
        self.contents = contents

    def __repr__(self):
        return f"<mem {self.contents!r}>"


# ---- the evaluator ----

class Evaluator:
    def __init__(self, provider: Provider):
        self.provider = provider
        self.env = {}               # name -> runtime value

    def run(self, stmts):
        for stmt in stmts:
            self.exec_stmt(stmt)

    # ---- statements ----

    def exec_stmt(self, node):
        if isinstance(node, A.AgentDecl):
            self.env[node.name] = AgentValue(node.name)
            print(f"[declare] agent {node.name}")

        elif isinstance(node, A.MemBind):
            value = self.eval_expr(node.expr)
            self.env[node.name] = MemValue(value)
            print(f"[mem]     {node.name} = {value!r}")

        elif isinstance(node, A.EventBind):
            value = self.eval_expr(node.expr)
            # binding an event variable: we expect the expr to yield an EventValue
            self.env[node.name] = value
            print(f"[event]   {node.name} = {value!r}")

        elif isinstance(node, A.ExprStmt):
            result = self.eval_expr(node.expr)
            print(f"[expr]    -> {result!r}")

        else:
            raise RuntimeError(f"unknown statement: {node!r}")

    # ---- expressions ----

    def eval_expr(self, node):
        if isinstance(node, A.StringLit):
            return node.value

        if isinstance(node, A.Name):
            if node.ident not in self.env:
                raise RuntimeError(f"undefined name: {node.ident}")
            return self.env[node.ident]

        if isinstance(node, A.Ref):
            # *Name : a reference to the agent itself (not its event)
            if node.ident not in self.env:
                raise RuntimeError(f"undefined name: {node.ident}")
            return self.env[node.ident]

        if isinstance(node, A.Send):
            return self.eval_send(node)

        if isinstance(node, A.Verify):
            return self.eval_verify(node)

        raise RuntimeError(f"unknown expression: {node!r}")

    def eval_send(self, node):
        target = self.env.get(node.target)
        if not isinstance(target, AgentValue):
            raise RuntimeError(f"cannot send into {node.target!r}: not an agent")
        payload = self.eval_expr(node.payload)
        if not isinstance(payload, str):
            raise RuntimeError("send payload must be a string for now")

        # SEND = the agent THINKS. Cognition enters through the provider seam.
        print(f"[send]    {node.target} <- {payload!r}  (thinking...)")
        response = self.provider.think(payload)

        emitted = EventValue(response, source=node.target)
        target.last_event = emitted     # the agent remembers its latest event
        return emitted

    def eval_verify(self, node):
        # FIRST ARG is event-typed: this is where the agent->event cast fires.
        event = self.as_event(self.eval_expr(node.event))
        expected = self.eval_expr(node.expected)
        if not isinstance(expected, str):
            raise RuntimeError("verify's second argument must be a string")

        score = cosine_similarity(
            self.provider.embed(event.payload),
            self.provider.embed(expected),
        )
        passed = score >= 0.9          # threshold; tune later
        print(f"[verify]  {event.payload!r} ~ {expected!r}  "
              f"similarity={score:.3f}  {'PASS' if passed else 'FAIL'}")
        return passed

    def as_event(self, value):
        """The context-driven cast to event type."""
        if isinstance(value, EventValue):
            return value
        if isinstance(value, AgentValue):
            # casting an agent in an event slot => its latest emitted event
            if value.last_event is None:
                raise RuntimeError(
                    f"agent {value.name} has emitted no event to cast to"
                )
            return value.last_event
        raise RuntimeError(f"cannot use {value!r} where an event is required")
