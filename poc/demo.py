"""
demo.py — a one-command tour of what works today.
Run:   python3 demo.py

Reflects the real current state of the pipeline: memory + isolation run for real;
the lexer and parser handle the full target program; the evaluator is next.
"""

from lexer import Lexer
from memory import Memory
from evaluator import AgentValue
from run import parse


def section(title):
    print("\n" + "=" * 66)
    print(title)
    print("=" * 66)


# 1) The memory substrate.
section("1) MEMORY SUBSTRATE  (structured / exact recall over triples)")
m = Memory()
m.store("self", "name", "John")
m.store("self", "role", "poker coach")
print("recall self.name           ->", m.recall("self", "name"))
print("recall everything re: self ->", m.recall("self"))

# 2) Per-agent private memory.
section("2) PRIVATE MEMORY  (agents share nothing by default)")
coach = AgentValue("Coach")
scribe = AgentValue("Scribe")
coach.memory.store("self", "name", "John")
scribe.memory.store("self", "name", "Mary")
print("Coach  self.name ->", coach.memory.recall("self", "name"))
print("Scribe self.name ->", scribe.memory.recall("self", "name"))
print("isolated? ->",
      coach.memory.recall("self", "name") != scribe.memory.recall("self", "name"))

# 3) The lexer reads the whole target program.
section("3) LEXER  (hello.ag -> tokens)")
toks = Lexer(open("hello.ag").read()).lex()
print(f"lexed hello.ag -> {len(toks)} tokens, no errors")

# 4) The parser builds the AST for the whole target program.
section("4) PARSER  (hello.ag -> AST)")
ast = parse(open("hello.ag").read())
print(f"parsed hello.org -> {len(ast)} top-level statements:\n")
for i, stmt in enumerate(ast):
    print(f"  {i:2}  {stmt!r}")
print("\n(next: Bite 2d — the evaluator that makes this AST actually run.)")
