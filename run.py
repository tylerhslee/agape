import sys
from lexer import Lexer
from parser import Parser
from evaluator import Evaluator
from provider import StubProvider


def run(source, provider=None):
    provider = provider or StubProvider()
    tokens = Lexer(source).lex()
    tree = Parser(tokens).parse()
    Evaluator(provider).run(tree)


HELLO_WORLD = '''
agent HelloWorld;
mem X = *HelloWorld;
event Y = HelloWorld <- "what is your name?";
verify(Y, "John");
'''

if __name__ == "__main__":
    if len(sys.argv) > 1:
        with open(sys.argv[1]) as f:
            run(f.read())
    else:
        run(HELLO_WORLD)
