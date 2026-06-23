# Agape — a tiny agentic language (proving-ground prototype)

This is the Python proving-ground for an agent-first language. It is NOT the
final language — it's the fastest way to make the design real, feel it run,
and learn every part. Final destination: a self-hosting compiler, eventually
on an emulated agentic substrate. This prototype settles the *design*.

## Pipeline

    source text → lexer → tokens → parser → AST → evaluator → behavior

## Files

- `lexer.py`      — text → typed tokens (handles strings, `<-`, `*`, `;`, keywords)
- `ast_nodes.py`  — the tree shapes (expressions vs. statements)
- `parser.py`     — recursive-descent: tokens → AST
- `evaluator.py`  — walks the AST, runs the Agape program (agents, mems, events)
- `provider.py`   — THE SEAM: where cognition (LLM) and meaning (embeddings) enter
- `run.py`        — ties it together; runs the hello world by default

## Run it (here, against the stub — no key needed)

    python3 run.py                 # runs the built-in hello world
    python3 run.py myprogram.ag   # runs a file

## The hello world

    agent HelloWorld;
    mem X = *HelloWorld;
    event Y = HelloWorld <- "what is your name?";
    verify(Y, "John");

## Key design rules encoded so far

1. Statements end in `;`.
2. `agent Name;` declares a first-class, bodyless agent.
3. `<-` sends an event INTO a target; sending into an agent makes it *think*.
4. A send is an EXPRESSION producing an event, so `event Y = Agent <- "..."` binds it.
5. `*Name` is a reference to the agent itself; bare `Name` binding does NOT cast.
6. Agent→event casting fires ONLY at an event-typed slot (e.g. verify's 1st arg),
   yielding the agent's latest emitted event.
7. `verify(event, expected)` is VECTOR SIMILARITY, not string equality.

## Make the agents actually think (on your machine)

The sandbox has no network/key, so it runs the `StubProvider` (agents answer
"I don't know"; embeddings are a toy). On your own machine:

    pip install anthropic sentence-transformers
    export ANTHROPIC_API_KEY=sk-...

Then in `run.py`:

    from provider import AnthropicProvider
    run(HELLO_WORLD, provider=AnthropicProvider())

Nothing else changes. Same language, real cognition — that's the seam working.
