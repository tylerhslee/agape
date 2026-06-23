"""
Deterministic test suite — proves the CODE has no bugs without needing an LLM.

It exercises only the genuinely deterministic machinery: memory, the find/where
query engine, the event spine, verify (both PASS and FAIL), and catch (retroactive,
prospective, supertype). Real cognition is NOT faked here — that's your API-key run.

Run:  python3 test_agape.py
"""

from memory import Memory
from query import solve
from ast_nodes import TriplePattern as P
from provider import StubProvider, Provider
from evaluator import Evaluator, Success, FailedVerificationEvent, ResponseEvent
from run import parse

_checks = 0
def check(name, cond):
    global _checks
    if not cond:
        raise AssertionError(f"FAIL: {name}")
    _checks += 1
    print(f"  PASS  {name}")

def run_quiet(provider, src):
    ev = Evaluator(provider)
    for stmt in parse(src):
        ev.exec_stmt(stmt)          # skip run()'s log dump
    return ev

class FixtureProvider(Provider):
    """A test double that returns a fixed answer — NOT cognition, just a fixture
    to exercise the verify-PASS path deterministically."""
    def __init__(self, answer): self.answer = answer
    def think(self, prompt): return self.answer
    def embed(self, text): return StubProvider().embed(text)


print("\n== memory ==")
m = Memory(); m.store("self", "name", "John"); m.store("self", "role", "coach")
check("recall exact single", [f.object for f in m.recall("self", "name")] == ["John"])
check("recall all about a subject", len(m.recall("self")) == 2)

print("\n== query engine ==")
triples = [("Coach", "is_a", "Agent"), ("Coach", "is_named", "John"),
           ("Student", "is_a", "Agent"), ("Student", "is_named", "Mary"),
           ("Name", "emitted_by", "Coach")]
vals, types = {"Coach", "Student", "Name"}, {"Agent"}
check("linear  (Coach is_named n)",
      [s["n"] for s in solve(triples, [P("Coach", "is_named", "n")], vals, types)] == ["John"])
chained = solve(triples, [P("Name", "emitted_by", "Agent"), P("Agent", "is_named", "who")], vals, types)
check("chained + type (Name emitted_by Agent is_named who) == John",
      [s["who"] for s in chained] == ["John"])
check("type constraint shares the node (not Mary)",
      [s["who"] for s in chained] != ["Mary"])
check("no match -> empty",
      solve(triples, [P("Coach", "plays", "x")], vals, types) == [])

print("\n== event spine: verify PASS (fixture answer) ==")
ev = run_quiet(FixtureProvider("John"), '''
agent Coach("you are John") {}
event Name = Coach <- "what is your name?";
verify Name == "John";
''')
check("PASS emits a Success for the checked source",
      any(isinstance(e, Success) and e.source == "Name" for e in ev.log))
check("PASS emits no failure", not any(isinstance(e, FailedVerificationEvent) for e in ev.log))
check("the send recorded a ResponseEvent", any(isinstance(e, ResponseEvent) for e in ev.log))

print("\n== event spine: verify FAIL (stub) ==")
ev = run_quiet(StubProvider(), '''
agent Coach("x") {}
event N = Coach <- "q";
verify N == "John";
''')
check("FAIL emits a FailedVerificationEvent", any(
    isinstance(e, FailedVerificationEvent) and e.source == "N" for e in ev.log))

print("\n== catch: retroactive + supertype ==")
ev = run_quiet(StubProvider(), '''
agent Coach("x") {}
event N = Coach <- "q";
verify N == "John";
catch Error(N) as e { say(e); }
''')
check("supertype Error caught the failure, retroactively",
      any(isinstance(evt, FailedVerificationEvent) for (_h, evt) in ev.handled))

print("\n== catch: prospective ==")
ev = run_quiet(StubProvider(), '''
agent Coach("x") {}
event N = Coach <- "q";
catch FailedVerificationEvent(N) as e { say(e); }
verify N == "John";
''')
check("catch registered before the failure still fires", len(ev.handled) == 1)

print("\n== find integrated with the evaluator (seeded facts) ==")
ev = Evaluator(StubProvider())
for stmt in parse('agent Coach("x") {}'):
    ev.exec_stmt(stmt)
ev.learn("Coach", "is_named", "John")            # 2e/cognition will do this for real
for stmt in parse('find n where { Coach is_named n }; verify n == "John";'):
    ev.exec_stmt(stmt)
check("find binds n from the world graph", ev.env["n"] == "John")
check("verify on the found value PASSES",
      any(isinstance(e, Success) and e.source == "n" for e in ev.log))

print(f"\nALL {_checks} CHECKS PASSED")
