"""session.py — a live, long-lived Agape program the Studio console drives.

THE BIG PICTURE (Phase 1). Agape Studio is the IDLE/phpMyAdmin of Agape: a web
console for *event-driven management*. The thing it manages is the EVENT SPINE
(SPEC §7) and the population of agents projected from it.

In Phase 1 this backend is written with traditional tools (Python), wrapping the
existing reference interpreter (`poc/`). In Phase 2 it is rewritten IN AGAPE, on
top of a new `listen` HTTP sensor — the socket sensor SPEC §5b already promises
("`prompt` is the first of a general family of sensors (a socket, ...)"). At that
point "the backend is Agape" becomes literally true. The frontend is React in
both phases.

THE ONE DESIGN DECISION that makes a console possible at all: the reference
interpreter's `run()` executes a program top-to-bottom and then either quiesces
or blocks serving stdin (`_serve_prompts`). A console must instead keep the
interpreter ALIVE between commands. So we never call `run()`. We:

  - load()  : parse + statically check + execute a program to quiescence via
              `_exec_block` (NOT `run()`), leaving its agents and subscriptions
              live and skipping the blocking stdin loop.
  - eval()  : run a snippet of Agape source against that same live interpreter,
              re-checking it IN THE FULL CONTEXT of everything loaded so far, so
              the three guarantees are still enforced incrementally.

State is always a projection of the spine — exactly as the language promises.
The console reads the spine; it does not keep a separate model of the world.
"""
from __future__ import annotations

import os
import sys
from typing import Any, Optional

# The reference interpreter lives in poc/. Put it on the path so we drive the
# real thing rather than a copy.
_POC = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "..", "poc"))
if _POC not in sys.path:
    sys.path.insert(0, _POC)

from agape_parser import parse                  # noqa: E402
from checker import check, CompileError         # noqa: E402
from spine import Spine, Event                  # noqa: E402
from agape_interp import Interpreter, AgentInstance  # noqa: E402
from agape_provider import MockProvider         # noqa: E402

try:
    from agape_provider import AnthropicProvider  # noqa: E402
except Exception:  # pragma: no cover - anthropic is optional
    AnthropicProvider = None  # type: ignore


class SessionError(Exception):
    """A console command failed — a compile error or a runtime error. Carried back
    to the client as a structured error rather than crashing the server."""

    def __init__(self, message: str, kind: str = "runtime"):
        super().__init__(message)
        self.kind = kind  # "compile" | "runtime"


class Session:
    """One live Agape program plus the operations the console performs on it."""

    def __init__(self, provider: str = "mock", model: str = "claude-opus-4-8"):
        self.provider_name = provider
        self.model = model
        self.source = ""          # accumulated, checkable program text
        self.program_path: Optional[str] = None
        self._build_interp()

    # ── lifecycle ───────────────────────────────────────────────────────────

    def _make_provider(self):
        if self.provider_name == "anthropic":
            if AnthropicProvider is None:
                raise SessionError("anthropic provider unavailable (pip install anthropic)")
            return AnthropicProvider(model=self.model)
        return MockProvider()

    def _build_interp(self) -> None:
        """Fresh spine + interpreter. Called on construction and on every load/reset
        so a load is a clean slate, not an append to a stale world."""
        self.spine = Spine()
        self.interp = Interpreter(self.spine, self._make_provider())

    def load(self, source: str, path: Optional[str] = None) -> dict:
        """Reset, then parse + check + run a program to quiescence (NOT via run(),
        so we never enter the blocking stdin serve loop). Leaves agents and
        subscriptions live for the console to drive."""
        self._build_interp()
        self.source = ""
        self.program_path = path
        try:
            stmts = parse(source)
        except Exception as exc:
            raise SessionError(f"parse error: {exc}", kind="compile")
        try:
            check(stmts)
        except CompileError as exc:
            raise SessionError(str(exc), kind="compile")
        try:
            # The whole top-level program is one scope: hoist its when/catch, then
            # run its statements. This is exactly what run() does MINUS the trailing
            # _serve_prompts() stdin loop — which would block the HTTP server.
            self.interp._exec_block(stmts, self.interp.global_env, None)
        except Exception as exc:
            raise SessionError(f"{type(exc).__name__}: {exc}", kind="runtime")
        self.source = source
        return self.snapshot()

    def eval(self, snippet: str) -> dict:
        """Run a snippet of Agape source against the LIVE interpreter.

        Guarantee enforcement is preserved: we statically check the snippet IN THE
        FULL CONTEXT of everything loaded/eval'd so far (concatenated source), so
        authority/taint/color violations are caught here just as they would be in a
        whole-program compile. Only the new statements are then executed against the
        live world, and the snippet is folded into the accumulated source so future
        evals see it."""
        combined = (self.source + "\n" + snippet) if self.source else snippet
        try:
            check(parse(combined))
        except CompileError as exc:
            raise SessionError(str(exc), kind="compile")
        except Exception as exc:
            raise SessionError(f"parse error: {exc}", kind="compile")

        before = len(self.spine.log)
        try:
            stmts = parse(snippet)
            self.interp._exec_block(stmts, self.interp.global_env, None)
        except Exception as exc:
            raise SessionError(f"{type(exc).__name__}: {exc}", kind="runtime")

        self.source = combined
        # `new_events` is the delta this command produced; `snapshot()` carries the
        # full `events` log. Distinct keys so the spread below cannot clobber the delta.
        return {"new_events": self._events_from(before), **self.snapshot()}

    def inject_prompt(self, source_name: str, value: str) -> dict:
        """Push one external input arrival onto an open `prompt` sensor (SPEC §5b) —
        the same thing the interpreter's stdin loop does per line, but driven from
        the web. Lands Prompt + Resolved for the sensor's subject, firing any
        `when (source_name)` handlers synchronously."""
        if source_name not in self.interp._prompt_sources:
            raise SessionError(f"no open prompt sensor named {source_name!r}")
        before = len(self.spine.log)
        self.interp.global_env[source_name] = value
        self.spine.append("Prompt", subject=source_name, payload=value)
        self.spine.append("Resolved", subject=source_name, payload=value)
        return {"new_events": self._events_from(before), **self.snapshot()}

    # ── projection / serialization ────────────────────────────────────────────

    def snapshot(self) -> dict:
        """A full, JSON-safe projection of the live world: every spine event, every
        agent instance, the declared agent templates, open sensors, and what is
        still pending (a Started with no Resolved)."""
        return {
            "provider": self.provider_name,
            "program_path": self.program_path,
            "source": self.source,
            "events": [self._event_json(e) for e in self.spine.log],
            "agents": [self._agent_json(a) for a in self.interp.instances.values()],
            "templates": sorted(self.interp.agent_templates.keys()),
            "prompt_sources": list(self.interp._prompt_sources),
            "authority_events": sorted(self.interp.authority_events),
            "pending": [self._event_json(e) for e in self.spine.pending()],
        }

    def _events_from(self, start_index: int) -> list[dict]:
        return [self._event_json(e) for e in self.spine.log[start_index:]]

    def events_since(self, tick: int) -> list[dict]:
        """Events with tick >= `tick` — the live-tail primitive the UI polls."""
        return [self._event_json(e) for e in self.spine.log if e.tick >= tick]

    def _event_json(self, e: Event) -> dict:
        return {
            "tick": e.tick,
            "etype": e.etype,
            "subject": _jsonify(e.subject),
            "payload": _jsonify(e.payload),
            "corr": e.corr,
            "agent": e.agent,
            "is_error": _is_error(e.etype),
        }

    def _agent_json(self, a: AgentInstance) -> dict:
        return {
            "name": a.name,
            "type": a.agent_type,
            "awake": a.awake,
            "constructed": a.constructed,
            "fields": {k: _jsonify(v) for k, v in a.fields.items()},
            "facts": [_jsonify(f) for f in a.facts],
            "memories": list(a.memories),
            "memory_count": len(a.memories),
        }


# ── JSON safety ────────────────────────────────────────────────────────────────

def _jsonify(v: Any) -> Any:
    """Make any interpreter value JSON-serializable. Agent instances collapse to
    their name; dicts/lists recurse; everything else falls back to str()."""
    if v is None or isinstance(v, (bool, int, float, str)):
        return v
    if isinstance(v, AgentInstance):
        return v.name
    if isinstance(v, dict):
        return {str(k): _jsonify(val) for k, val in v.items()}
    if isinstance(v, (list, tuple)):
        return [_jsonify(x) for x in v]
    return str(v)


def _is_error(etype: str) -> bool:
    from spine import is_event_subtype
    return is_event_subtype(etype, "Error")
