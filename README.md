# Agape

**A programming language for agent systems you can inspect, gate, and replay.**

Agape is built around one idea: a model response is testimony, not authority. A
program can ask a model for help, but the result has to be typed, graded,
decided, endorsed, and recorded before it can reach a consequential action.

```text
testimony -> Credence<E> -> Decision<E> -> Endorsement<T> -> granted action -> ledger
```

The result is a small trusted kernel for agentic software: schema-constrained
cognition, compile-time authority checks, mandatory gates, tainted memory
recall, manifest-bound providers and tools, and an append-only hash-chained
ledger for every run.

Agape is alpha software. The language and runtime are moving quickly, but the
repository is usable today: the mock provider runs offline, the TypeScript
runtime powers Agape Studio, and the TypeScript CLI is the source-installable
base package target.

## Quickstart: Try Agape Studio

Use this path if you want the fastest way to run examples, edit `.ag` programs,
switch providers, and inspect the ledger.

**Prerequisites**

- Node.js 20 or newer
- npm

```sh
git clone https://github.com/tylerhslee/agape.git agape
cd agape/agape-ts
npm install
npm run studio -- --port 4317
```

Open the URL printed by the command, usually:

```text
http://localhost:4317
```

Studio serves the directory it was launched from. From `agape-ts`, it will find
the checked-in examples under `examples/`:

- `examples/hello.ag` - the smallest trusted-kernel example
- `examples/rag_recall.ag` - private memory and RAG-style recall
- `examples/fact_checker.ag` - structured extraction, tool use, verification,
  and publication gating
- `examples/attest_wire.ag` - prompt input and principal attestation flow

In Studio, pick a program, run it with the mock provider, then inspect the
ledger timeline, trusted-kernel chain, provider response data, prompt inputs,
attestations, and config. The mock provider is deterministic and requires no API
key.

You can also run the same runtime from the terminal:

```sh
cd agape/agape-ts
npx tsx src/cli.ts run examples/hello.ag --manifest agape.toml
```

## Use A Live Provider

Live providers are intentionally locked unless Studio is started with `--live`
or `--share`. Put keys in the environment or in a local `.env`; secrets are never
stored in `agape.toml`.

```sh
cd agape/agape-ts
printf 'OPENAI_API_KEY=sk-...\n' > .env
npm run studio -- --live --port 4317
```

With `--live`, Studio prints a tokenized local URL such as:

```text
http://localhost:4317/?token=...
```

If you expose Studio through a short-lived tunnel, append the same token to the
tunnel URL. For example:

```sh
cloudflared tunnel --url http://localhost:4317
```

Then open:

```text
https://<generated>.trycloudflare.com/?token=...
```

Provider selection is config-bound. A project manifest can use the deterministic
mock backend or a live backend:

```toml
[provider]
backend = "mock"       # or "openai", "anthropic", "gemini"
model = "in-box"
```

OpenAI and Gemini expose token logprobs for graded credences when available.
Anthropic uses the sampling fallback. The program source does not change when
you switch providers.

## Install The TypeScript `agape` CLI From Source

Use this path for the vanilla Agape runtime that ships from this repository.
The base installation is TypeScript-only; project memory and `.env` files live in
the Agape project, not in the installation folder.

**Prerequisites**

- Node.js 20 or newer

```sh
git clone https://github.com/tylerhslee/agape.git agape
cd agape/agape-ts
npm install
npm test
npm run typecheck
```

Run an example with the deterministic mock provider:

```sh
node node_modules/tsx/dist/cli.mjs src/cli.ts run examples/hello.ag
```

Create an Agape project by adding `agape.toml` and `.ag` files in the project
root. By default, markdown memory is written under that project root at
`.agape/memory`, and provider keys can be supplied from the project's `.env` or
the process environment.
## A Small Agape Program

This is the core shape. The model can judge a draft, but only an endorsed value
can reach the sink.

```agape
enum Verdict { Publish, Revise }

action Announce(text body);
event Revised(text note);

agent Greeter grants { perform Announce } {
  on awake {
    text draft = "hello, world";

    Credence<Verdict> v =
      self <- f"is this greeting safe to publish: {draft}";

    Decision<Verdict> d = decide v by confidence 0.8;

    if (d.committed == Publish) {
      Endorsement<text> e = endorse draft by d;
      perform Announce(e);
    } else if (d.committed == Revise) {
      emit Revised("held for revision");
    } else {
      emit Revised("uncertain; needs review");
    }
  }
}

spawn Greeter g;
awake g;
```

Run the checked-in version:

```sh
cd agape/agape-ts
npx tsx src/cli.ts run examples/hello.ag
```

The run produces a ledger: every spawn, provider call, credence, decision,
endorsement, action, and chain-head is recorded.

## Configuration

Agape source declares dependencies. The manifest binds those dependencies to the
outside world.

```toml
[project]
name = "fact-checker"
entry = "examples/fact_checker.ag"

[provider]
backend = "openai"
model = "gpt-4o-mini"

[tools.search]
driver = "mock"

[memory]
# Markdown is the editable substrate; the default Agape memory runtime wraps it
# with classification, dedupe/consolidation, auto-memory judgment, and recall ranking.
driver = "markdown"
auto_memory = true
classify = true
dedupe = true
dedupe_threshold = 0.9
recall_pool = 40
path = ".agape/memory"
entrypoint = "MEMORY.md"
top_k = 10
index_lines = 200
index_bytes = 25600
archive_on_forget = true
# domain_terms = ["league", "roster", "scoring"]
```

By default, `[memory] driver = "markdown"` selects the storage substrate and
Agape wraps it with the built-in memory runtime. The runtime keeps markdown as
the canonical editable source while handling low-signal auto-memory filtering,
preference/fact/procedure classification, duplicate suppression, and recall
re-ranking. Hosts can replace the substrate without changing Agape source.

The built-in `mock` tool driver is used for demos and replay-stable tests.
Non-mock tool drivers are supplied by the embedding runtime. MCP is one possible
transport; a host can also bind tools to HTTP services, local processes,
in-process functions, or product-specific skill adapters.

Decision policy belongs in source, not config. Thresholds, confidence rules,
conformal parameters, and endorsement points are part of the program being
reviewed.

## What Agape Guarantees

- **Typed cognition.** Provider replies are parsed as schema-constrained values,
  structs, enums, credences, and events rather than unstructured strings.
- **Default-deny authority.** Agents can only use tools and perform actions they
  were granted.
- **Mandatory endorsement.** A model-derived value cannot drive a consequential
  action until a gate has committed and the subject has been endorsed.
- **Fail-closed runtime behavior.** Unknown providers, missing tool bindings,
  invalid schemas, ungranted effects, and failed gates reject rather than guess.
- **Tainted memory recall.** Private memory can store and retrieve information,
  but recalled values remain untrusted and must be re-gated before use at a sink.
- **Replayable execution.** The ledger is append-only and hash-chained, so runs
  can be inspected, replayed, and compared.

## Repository Layout

```text
SPEC.md                    language and runtime specification
agape-ts/                  TypeScript compiler/runtime and vanilla CLI
agape-ts/studio/           local runner and inspector for .ag programs
agape-ts/examples/         runnable examples for Studio
agape-conformance/         black-box conformance suite
studio/                    packaged Studio app and agent server
design/                    showcase programs and design notes
scripts/package.sh         release bundle builder
```

## Development

TypeScript runtime and Studio runner:

```sh
cd agape-ts
npm install
npm test
npm run typecheck
npm run studio
```

Packaged Studio app:

```sh
cd studio/web && npm install && npm run build
cd ../agent-server && npm install && npm test
```

## Documentation

- [`SPEC.md`](SPEC.md) - authoritative language and runtime reference
- [`KERNEL.md`](KERNEL.md) - trusted-kernel notes
- [`DISTRIBUTION.md`](DISTRIBUTION.md) - packaging and runtime distribution plan
- [`agape-ts/README.md`](agape-ts/README.md) - TypeScript implementation details
- [`studio/README.md`](studio/README.md) - packaged Studio architecture

## Status

Agape is pre-1.0 alpha software. The kernel concepts are stable enough to build
against, but syntax, manifest details, and Studio workflows may still change.

The current development loop is:

1. Use `agape-ts` and Agape Studio to try programs quickly.
2. Use the mock provider for deterministic local runs.
3. Switch providers through `agape.toml` and environment keys when you want live
   cognition.
4. Use the conformance suite to keep implementations aligned with `SPEC.md`.

If you are evaluating Agape, start with Studio and `examples/hello.ag`, then run
`examples/rag_recall.ag` to see why memory recall is useful but never trusted by
default.
