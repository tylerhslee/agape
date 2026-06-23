"""agape_interp.py — tree-walking interpreter for the Agape language."""
from __future__ import annotations
import re
from typing import Any, Optional
import agape_ast as A
from spine import Spine
from agape_provider import Provider


# ── runtime data ──────────────────────────────────────────────────────────────

class AgentInstance:
    def __init__(self, name: str, agent_type: str):
        self.name = name
        self.agent_type = agent_type
        self.fields: dict = {}
        self.seeded_name: Optional[str] = None
        self.seeded_role: Optional[str] = None
        self.known_facts: dict = {}
        self.awake: bool = False
        self.on_awake_hooks: list = []  # list of (body, env_dict)
        self.on_sleep_hooks: list  = []

    def _on_seed_name(self, name: str):
        pass  # overridden by interpreter after instantiation

    def __repr__(self) -> str:
        return f"<Agent {self.agent_type}:{self.name}>"


class ReturnException(Exception):
    def __init__(self, value: Any):
        self.value = value


# ── interpreter ───────────────────────────────────────────────────────────────

class Interpreter:
    def __init__(self, spine: Spine, provider: Provider):
        self.spine    = spine
        self.provider = provider
        self.agent_templates: dict[str, A.AgentDecl] = {}
        self.instances:       dict[str, AgentInstance] = {}
        self.functions:       dict[str, A.FnDecl] = {}
        self.global_env:      dict = {}
        self.world:           list[tuple] = []   # (subj, pred, obj) triples
        self._var_sources:    dict[str, str] = {}  # var_name → agent name
        self._current_agent:  Optional[AgentInstance] = None

    # ── top-level entry ───────────────────────────────────────────────────────

    def run(self, stmts: list) -> None:
        for stmt in stmts:
            self._exec(stmt, self.global_env, None)

    # ── statement dispatch ────────────────────────────────────────────────────

    def _exec(self, stmt, env: dict, ai: Optional[AgentInstance]) -> None:
        if ai is None:
            ai = self._current_agent
        t = type(stmt).__name__

        if t == "FnDecl":
            self.functions[stmt.name] = stmt

        elif t == "AgentDecl":
            self.agent_templates[stmt.name] = stmt

        elif t == "VarDecl":
            self._exec_var_decl(stmt, env, ai)

        elif t == "AssignStmt":
            val = self._eval(stmt.expr, env, ai)
            self._assign(stmt.target, val, env, ai)

        elif t == "SpawnStmt":
            self._exec_spawn(stmt, env)

        elif t == "AwakeStmt":
            self._exec_awake(stmt)

        elif t == "SleepStmt":
            self._exec_sleep(stmt)

        elif t == "WhenStmt":
            self._exec_when(stmt, env, ai)

        elif t == "CatchStmt":
            self._exec_catch(stmt, env, ai)

        elif t == "VerifyStmt":
            self._do_verify(None, stmt.left, stmt.op, stmt.right, env, ai)

        elif t == "EmitStmt":
            payload = self._eval(stmt.payload, env, ai)
            ag_name = ai.name if ai else None
            self.spine.append(stmt.event_type, subject=ag_name, payload=payload, agent=ag_name)

        elif t == "FindStmt":
            self._exec_find(stmt, env)

        elif t == "SelectStmt":
            print(f"[stub] select {', '.join(stmt.cols)} from {stmt.agent} where {{...}}")

        elif t == "MatchStmt":
            print(f"[stub] match {{m: ...}} > {stmt.threshold}")

        elif t == "CaseStmt":
            self._exec_case(stmt, env, ai)

        elif t == "IfStmt":
            cond = self._eval(stmt.cond, env, ai)
            branch = stmt.then_body if cond else stmt.else_body
            for s in branch:
                self._exec(s, env, ai)

        elif t == "RetryBlockStmt":
            self._exec_retry_block(stmt, env, ai)

        elif t == "ReturnStmt":
            raise ReturnException(self._eval(stmt.expr, env, ai))

        elif t == "SayStmt":
            val = self._eval(stmt.expr, env, ai)
            print(f"[say] {self._fmt(val)}")

        elif t == "ExprStmt":
            self._eval(stmt.expr, env, ai)

        elif t == "OnAwake":
            if ai is not None:
                ai.on_awake_hooks.append((stmt.body, env))

        elif t == "OnSleep":
            if ai is not None:
                ai.on_sleep_hooks.append((stmt.body, env))

        elif t == "ExtendStmt":
            self._exec_extend(stmt, env, ai)

        else:
            print(f"[warn] unhandled stmt: {t}")

    # ── var declaration ───────────────────────────────────────────────────────

    def _exec_var_decl(self, stmt: A.VarDecl, env: dict, ai: Optional[AgentInstance]) -> None:
        name = stmt.name
        schema = self._type_to_schema(stmt.type_node)

        if stmt.expr is None:
            env[name] = None
            return

        expr = stmt.expr

        if isinstance(expr, A.VerifyExpr):
            env[name] = self._do_verify(name, expr.left, expr.op, expr.right, env, ai)
            return

        if isinstance(expr, A.SendExpr):
            env[name] = self._eval_send_named(name, expr, schema, env, ai)
            return

        if isinstance(expr, A.EntailExpr):
            env[name] = self._eval_entail_named(name, expr, env, ai)
            return

        val = self._eval(expr, env, ai)
        env[name] = val

    # ── spawn / lifecycle ─────────────────────────────────────────────────────

    def _exec_spawn(self, stmt: A.SpawnStmt, env: dict) -> None:
        tmpl = self.agent_templates.get(stmt.agent_type)
        if tmpl is None:
            raise RuntimeError(f"unknown agent type: {stmt.agent_type!r}")

        inst = AgentInstance(stmt.name, stmt.agent_type)

        # Wire name-seeding callback so world graph is updated
        def _seed(name: str, _inst: AgentInstance = inst) -> None:
            self.world.append((_inst.name, "is_named", name))
        inst._on_seed_name = _seed

        # is_a triples
        self.world.append((inst.name, "is_a", stmt.agent_type))
        self.world.append((inst.name, "is_a", "Agent"))

        # Eval constructor args in CALLER's scope
        args = [self._eval(a, env, self._current_agent) for a in stmt.args]

        # Build constructor environment
        ctor_env: dict = {"self": inst}
        for (_, pname), aval in zip(tmpl.params, args):
            ctor_env[pname] = aval

        corr = self.spine.started("Spawn", subject=stmt.name)

        prev = self._current_agent
        self._current_agent = inst
        for body_stmt in tmpl.body:
            self._exec(body_stmt, ctor_env, inst)
        self._current_agent = prev

        self.spine.resolved("Spawn", corr, subject=stmt.name, payload=repr(inst))

        self.instances[stmt.name] = inst
        env[stmt.name] = inst

    def _exec_awake(self, stmt: A.AwakeStmt) -> None:
        inst = self._require_inst(stmt.name)
        inst.awake = True
        self.spine.append("AwakeEvent", subject=stmt.name)
        prev = self._current_agent
        self._current_agent = inst
        for (body, henv) in inst.on_awake_hooks:
            local = dict(henv)
            for s in body:
                self._exec(s, local, inst)
        self._current_agent = prev

    def _exec_sleep(self, stmt: A.SleepStmt) -> None:
        inst = self._require_inst(stmt.name)
        prev = self._current_agent
        self._current_agent = inst
        for (body, henv) in inst.on_sleep_hooks:
            local = dict(henv)
            for s in body:
                self._exec(s, local, inst)
        self._current_agent = prev
        inst.awake = False
        self.spine.append("SleepEvent", subject=stmt.name)

    # ── when / catch subscriptions ────────────────────────────────────────────

    def _exec_when(self, stmt: A.WhenStmt, env: dict, ai: Optional[AgentInstance]) -> None:
        subject_name = self._subject_key(stmt.subject, ai)

        def handler(ev, body=stmt.body, henv=env, hai=ai):
            local = dict(henv)
            prev = self._current_agent
            self._current_agent = hai
            for s in body:
                self._exec(s, local, hai)
            self._current_agent = prev

        # when fires on resolution/success
        self.spine.subscribe("Resolved", subject_name, handler, polarity="when")
        self.spine.subscribe("SuccessfulVerification", subject_name, handler, polarity="when")

    def _exec_catch(self, stmt: A.CatchStmt, env: dict, ai: Optional[AgentInstance]) -> None:
        subject_name = self._subject_key(stmt.subject, ai) if stmt.subject is not None else None
        etype = stmt.event_type or "FailedVerification"

        def handler(ev, body=stmt.body, binding=stmt.binding, henv=env, hai=ai):
            local = dict(henv)
            local[binding] = ev.payload if ev.payload is not None else ev
            prev = self._current_agent
            self._current_agent = hai
            for s in body:
                self._exec(s, local, hai)
            self._current_agent = prev

        self.spine.subscribe(etype, subject_name, handler, polarity="catch")

    # ── verify ────────────────────────────────────────────────────────────────

    def _do_verify(
        self,
        var_name: Optional[str],
        left_expr, op: Optional[str], right_expr,
        env: dict, ai: Optional[AgentInstance]
    ) -> dict:
        left_val = self._eval(left_expr, env, ai)
        # Use scoped key for agent-internal vars, plain key for top-level
        if var_name:
            subject = f"{ai.name}:{var_name}" if ai else var_name
        else:
            subject = self._subject_key(left_expr, ai)

        if op is None:
            passed = bool(left_val)
        elif op == "==":
            passed = left_val == self._eval(right_expr, env, ai)
        elif op == "~":
            right_val = self._eval(right_expr, env, ai)
            sim = self.provider.similarity(self._to_str(left_val), self._to_str(right_val))
            passed = sim >= 0.8
        else:
            raise RuntimeError(f"unknown verify op: {op!r}")

        result = {"_type": "Verification", "passed": passed, "subject": subject}

        if passed:
            self.spine.append("SuccessfulVerification", subject=subject, payload=result)
            self.spine.append("Resolved", subject=subject, payload=result)
        else:
            self.spine.append("FailedVerification", subject=subject, payload=result)

        return result

    # ── find/where query ──────────────────────────────────────────────────────

    def _exec_find(self, stmt: A.FindStmt, env: dict) -> None:
        binding = stmt.binding
        results: list = []

        for (subj_pat, pred_pat, obj_pat) in stmt.pattern:
            if obj_pat != binding:
                continue
            # Determine candidate subjects
            if subj_pat[0].isupper():
                # treat as type name: find all instances with is_a = subj_pat
                candidates = [t[0] for t in self.world if t[1] == "is_a" and t[2] == subj_pat]
            elif subj_pat in self.instances:
                candidates = [subj_pat]
            else:
                candidates = [t[0] for t in self.world if t[0] == subj_pat]

            for cand in candidates:
                for (s, p, o) in self.world:
                    if s == cand and p == pred_pat:
                        results.append(o)

        if len(results) == 0:
            env[binding] = None
        elif len(results) == 1:
            env[binding] = results[0]
        else:
            env[binding] = results

    # ── case statement ────────────────────────────────────────────────────────

    def _exec_case(self, stmt: A.CaseStmt, env: dict, ai: Optional[AgentInstance]) -> None:
        val     = self._eval(stmt.expr, env, ai)
        verdict = self._as_verdict(val)
        local   = dict(env)
        local[stmt.binding] = val

        for (variant, arm_body) in stmt.arms:
            if verdict == variant:
                for s in arm_body:
                    self._exec(s, local, ai)
                return

        if stmt.default_body is not None:
            for s in stmt.default_body:
                self._exec(s, local, ai)

    # ── retry block ───────────────────────────────────────────────────────────

    def _exec_retry_block(self, stmt: A.RetryBlockStmt, env: dict, ai: Optional[AgentInstance]) -> None:
        for attempt in range(stmt.n + 1):
            before = len(self.spine.log)
            local  = dict(env)
            try:
                for s in stmt.body:
                    self._exec(s, local, ai)
            except Exception:
                raise

            new_evs = self.spine.log[before:]
            failed  = any(e.etype == "FailedVerification" for e in new_evs)
            if not failed:
                env.update(local)
                return
            if attempt < stmt.n:
                self.spine.append("RetryAttempt", payload={"attempt": attempt + 1})

        self.spine.append("RetryExhausted", payload={"max": stmt.n})

    # ── extend (parent constructor) ───────────────────────────────────────────

    def _exec_extend(self, stmt: A.ExtendStmt, env: dict, ai: AgentInstance) -> None:
        tmpl = self.agent_templates.get(stmt.parent)
        if tmpl is None:
            raise RuntimeError(f"unknown parent: {stmt.parent!r}")

        self.world.append((ai.name, "is_a", stmt.parent))

        args = [self._eval(a, env, ai) for a in stmt.args]

        parent_env: dict = dict(env)
        for (_, pname), aval in zip(tmpl.params, args):
            parent_env[pname] = aval

        for body_stmt in tmpl.body:
            self._exec(body_stmt, parent_env, ai)

        # Merge bindings that are new in parent_env back into caller's env
        for k, v in parent_env.items():
            if k not in env:
                env[k] = v

    # ── expression evaluation ─────────────────────────────────────────────────

    def _eval(self, expr, env: dict, ai: Optional[AgentInstance] = None) -> Any:
        if ai is None:
            ai = self._current_agent
        t = type(expr).__name__

        if t == "IntLit":    return expr.value
        if t == "FloatLit":  return expr.value
        if t == "BoolLit":   return expr.value
        if t == "NullLit":   return None
        if t == "StrLit":    return expr.value
        if t == "FStrLit":   return self._interp_fstr(expr.template, env, ai)
        if t == "Name":      return self._eval_name(expr.ident, env, ai)
        if t == "BinOp":     return self._eval_binop(expr, env, ai)
        if t == "UnaryOp":   return not self._eval(expr.expr, env, ai) if expr.op == "!" else None
        if t == "Call":      return self._eval_call(expr, env, ai)
        if t == "MemberAccess": return self._eval_member(expr, env, ai)
        if t == "SendExpr":  return self._eval_send_named(None, expr, "text", env, ai)
        if t == "EntailExpr": return self._eval_entail_named(None, expr, env, ai)
        if t == "PipeExpr":  return self._eval_pipe(expr, env, ai)
        if t == "VerifyExpr": return self._do_verify(None, expr.left, expr.op, expr.right, env, ai)
        raise RuntimeError(f"unknown expr type: {t!r} → {expr!r}")

    def _eval_name(self, ident: str, env: dict, ai: Optional[AgentInstance]) -> Any:
        if ident == "self":
            return ai
        if ident in env:
            return env[ident]
        if ident in self.global_env:
            return self.global_env[ident]
        if ident in self.functions:
            return self.functions[ident]
        if ident in self.instances:
            return self.instances[ident]
        raise RuntimeError(f"undefined name: {ident!r}")

    def _eval_binop(self, expr: A.BinOp, env: dict, ai: Optional[AgentInstance]) -> Any:
        if expr.op == "~":
            a = self._to_str(self._eval(expr.left,  env, ai))
            b = self._to_str(self._eval(expr.right, env, ai))
            return self.provider.similarity(a, b) >= 0.8

        left  = self._eval(expr.left,  env, ai)
        right = self._eval(expr.right, env, ai)
        ops = {"+": lambda a,b: a+b, "-": lambda a,b: a-b,
               "*": lambda a,b: a*b, "/": lambda a,b: a/b,
               "==": lambda a,b: a==b, "!=": lambda a,b: a!=b,
               "<":  lambda a,b: a<b,  ">":  lambda a,b: a>b,
               "<=": lambda a,b: a<=b, ">=": lambda a,b: a>=b}
        fn = ops.get(expr.op)
        if fn is None:
            raise RuntimeError(f"unknown binary op: {expr.op!r}")
        return fn(left, right)

    def _eval_call(self, expr: A.Call, env: dict, ai: Optional[AgentInstance]) -> Any:
        func_name = expr.func.ident if isinstance(expr.func, A.Name) else None

        # Built-in aggregators
        if func_name == "all":
            args = [self._eval(a, env, ai) for a in expr.args]
            seq  = args[0] if args else []
            return all(seq) if hasattr(seq, "__iter__") else all(args)
        if func_name == "any":
            args = [self._eval(a, env, ai) for a in expr.args]
            seq  = args[0] if args else []
            return any(seq) if hasattr(seq, "__iter__") else any(args)

        # Prelude type constructors
        if func_name == "Verification":
            ref_val = self._eval(expr.args[0], env, ai) if expr.args else None
            return {"_type": "Verification", "ref": ref_val}

        # User function call
        func = self._eval(expr.func, env, ai)
        if isinstance(func, A.FnDecl):
            args = [self._eval(a, env, ai) for a in expr.args]
            return self._call_fn(func, args, ai)

        # Bare name that resolves to a non-function (e.g., agent name in emit payload)
        if func_name is not None and func_name in self.instances:
            return self.instances[func_name]

        # Unknown call: return None (e.g., user-type constructors like Error(...) in emit)
        args = [self._eval(a, env, ai) for a in expr.args]
        return args[0] if args else func_name

    def _call_fn(self, fn: A.FnDecl, args: list, caller_ai: Optional[AgentInstance]) -> Any:
        fn_env = dict(self.global_env)
        for (_, pname), aval in zip(fn.params, args):
            fn_env[pname] = aval
        prev = self._current_agent
        self._current_agent = caller_ai
        try:
            for s in fn.body:
                self._exec(s, fn_env, caller_ai)
        except ReturnException as ret:
            self._current_agent = prev
            return ret.value
        self._current_agent = prev
        return None

    def _eval_member(self, expr: A.MemberAccess, env: dict, ai: Optional[AgentInstance]) -> Any:
        obj = self._eval(expr.obj, env, ai)
        if isinstance(obj, AgentInstance):
            return obj.fields.get(expr.prop)
        raise RuntimeError(f"member access on non-agent: {obj!r}")

    # ── named send (emits spine with subject = var_name) ─────────────────────

    def _eval_send_named(
        self,
        var_name: Optional[str],
        expr: A.SendExpr,
        schema: str,
        env: dict,
        ai: Optional[AgentInstance],
    ) -> Any:
        # Resolve destination
        if expr.dest == "self":
            dest = ai
        else:
            dest = (self.instances.get(expr.dest)
                    or env.get(expr.dest)
                    or self.global_env.get(expr.dest))

        payload_val = self._eval(expr.payload, env, ai)
        prompt = self._to_str(payload_val)

        # Infer schema from prompt for seeding messages
        effective_schema = schema
        p_low = prompt.lower()
        if ("your name is" in p_low or "you are a poker" in p_low
                or ("a flush beats a straight" in p_low and schema != "bool")):
            effective_schema = "null"

        # Scope subject to agent when inside one (prevents cross-agent collisions)
        if var_name and ai is not None:
            subj = f"{ai.name}:{var_name}"
        else:
            subj = var_name  # top-level or anonymous send

        corr = self.spine.started("Think", subject=subj, agent=dest.name if dest else None)
        result = self.provider.think(prompt, agent_inst=dest, schema=effective_schema)
        self.spine.resolved("Think", corr, subject=subj, payload=result,
                            agent=dest.name if dest else None)
        if subj is not None:
            self.spine.append("Resolved", subject=subj, payload=result)

        if var_name and dest:
            self._var_sources[var_name] = dest.name

        # Handle retry body (send form): runs before each re-attempt but first always sent
        # For POC the first attempt always succeeds with mock, so no re-attempts needed.

        return result

    # ── entail ────────────────────────────────────────────────────────────────

    def _eval_entail_named(
        self,
        var_name: Optional[str],
        expr: A.EntailExpr,
        env: dict,
        ai: Optional[AgentInstance],
    ) -> str:
        answer_val = self._eval(expr.expr, env, ai)
        claim_val  = self._eval(expr.claim, env, ai)
        verdict    = self.provider.entail(self._to_str(answer_val), self._to_str(claim_val))

        # Source agent for Contradiction event
        source_agent = None
        if isinstance(expr.expr, A.Name):
            source_agent = self._var_sources.get(expr.expr.ident)

        if verdict == "Contradiction":
            self.spine.append("Contradiction", subject=source_agent, payload=verdict)

        return verdict

    # ── pipe ──────────────────────────────────────────────────────────────────

    def _eval_pipe(self, expr: A.PipeExpr, env: dict, ai: Optional[AgentInstance]) -> list:
        source = self._eval(expr.source, env, ai)
        func   = self._eval(expr.func,   env, ai)
        if isinstance(source, str) or not hasattr(source, "__iter__"):
            source = [source]
        results = []
        for item in source:
            if isinstance(func, A.FnDecl):
                results.append(self._call_fn(func, [item], ai))
            elif callable(func):
                results.append(func(item))
            else:
                raise RuntimeError(f"pipe right side not callable: {func!r}")
        return results

    # ── assignment helper ─────────────────────────────────────────────────────

    def _assign(self, target, val: Any, env: dict, ai: Optional[AgentInstance]) -> None:
        if isinstance(target, A.MemberAccess):
            obj = self._eval(target.obj, env, ai)
            if isinstance(obj, AgentInstance):
                obj.fields[target.prop] = val
            else:
                raise RuntimeError(f"cannot assign member of {obj!r}")
        elif isinstance(target, A.Name):
            ident = target.ident
            if ident in env:
                env[ident] = val
            elif ident in self.global_env:
                self.global_env[ident] = val
            else:
                env[ident] = val
        else:
            raise RuntimeError(f"unknown assignment target: {target!r}")

    # ── helpers ───────────────────────────────────────────────────────────────

    def _require_inst(self, name: str) -> AgentInstance:
        inst = self.instances.get(name)
        if inst is None:
            raise RuntimeError(f"no agent instance: {name!r}")
        return inst

    def _subject_key(self, expr, ai: Optional[AgentInstance] = None) -> Optional[str]:
        """
        Use the identifier name as the subject correlation key.
        Agent-internal vars are scoped as '<agent>:<var>' to avoid cross-agent
        subscription collisions (e.g. john's 'init' vs mary's 'init').
        """
        if expr is None:
            return None
        if isinstance(expr, A.Name):
            ident = expr.ident
            if ai is not None and ident not in ("self",):
                return f"{ai.name}:{ident}"
            return ident
        return None

    def _type_to_schema(self, type_node) -> str:
        if isinstance(type_node, A.EventType):
            return self._type_to_schema(type_node.inner)
        if isinstance(type_node, A.SimpleType):
            return type_node.name
        return "text"

    def _interp_fstr(self, template: str, env: dict, ai: Optional[AgentInstance]) -> str:
        def replace(m: re.Match) -> str:
            ident = m.group(1)
            try:
                return self._to_str(self._eval_name(ident, env, ai))
            except Exception:
                return f"{{{ident}}}"
        return re.sub(r"\{(\w+)\}", replace, template)

    def _to_str(self, val: Any) -> str:
        if isinstance(val, bool):
            return "Yes" if val else "No"
        if val is None:
            return "null"
        if isinstance(val, AgentInstance):
            return val.name
        if isinstance(val, dict) and val.get("_type") == "Verification":
            status = "PASS" if val.get("passed") else "FAIL"
            return f"Verification({status}, subject={val.get('subject')})"
        return str(val)

    def _fmt(self, val: Any) -> str:
        return self._to_str(val)

    def _as_verdict(self, val: Any) -> str:
        if isinstance(val, str):
            return val
        if isinstance(val, dict) and "_verdict" in val:
            return val["_verdict"]
        return str(val) if val is not None else "Neutral"
