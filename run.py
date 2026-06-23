import sys
from lexer import Lexer
from parser import Parser
from evaluator import Evaluator
from provider import StubProvider


def parse(source):
    """Front half of the pipeline: text -> tokens -> AST."""
    tokens = Lexer(source).lex()
    return Parser(tokens).parse()


def run(source, provider=None):
    """Full pipeline. NOTE: the evaluator has not yet been upgraded to the new
    AST (that's Bite 2d), so calling this on new-syntax programs will error in
    the evaluator. It stays here as the real entry point for later."""
    provider = provider or StubProvider()
    Evaluator(provider).run(parse(source))


def dump_ast(source):
    """Parse and print the AST, one top-level statement per line."""
    for i, stmt in enumerate(parse(source)):
        print(f"{i:2}  {stmt!r}")


if __name__ == "__main__":
    # The evaluator now runs the new AST (event spine). `find` is still a stub
    # and cognition is the StubProvider, so verifies FAIL for now — that failure
    # path is exactly what shows the catch machinery working. `python3 run.py
    # <file>` runs that file instead of the default target.
    path = sys.argv[1] if len(sys.argv) > 1 else "hello.org"
    with open(path) as f:
        run(f.read())
