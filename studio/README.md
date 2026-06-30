# Agape Studio

Agape Studio is the control surface for building and operating systems written
in [Agape](https://github.com/tylerhslee/agape), a language for agentic programs
whose model-derived judgments must be typed, gated, and recorded before they can
act.

Studio is not just a code editor. It is meant for the agentic programming loop:
prompt agents, inspect their work, run Agape programs, read the ledger, configure
providers, review conformance, and decide when human judgment should take over.

## What Studio Does

- Opens the current Agape project and shows its `.ag` source files.
- Detects declared agents, prompts, and project structure.
- Runs project files through the Agape runtime and displays the event ledger.
- Provides Monaco-based Agape syntax highlighting and editor controls.
- Configures cognition providers such as Mock, Claude, and OpenAI.
- Shows how `Credence` is materialized by the selected provider: OpenAI logprobs
  or Claude sampling fallback.
- Exposes a runtime deployment panel for local runtimes today and cloud runtimes
  such as Soma later.
- Includes review and conformance surfaces for checking language behavior.
- Treats the local Studio runtime, local Rust runtime, and future Soma/cloud
  runtime as implementations of the shared [runtime spec](../RUNTIME_SPEC.md).

## How It Relates To Agape

Agape is the language. Studio is the interface for working with Agape projects.

The bundled command:

```sh
agape studio
```

starts Studio from the directory you are currently in. Studio looks for
`agape.toml` in that directory; if it does not find one, it walks upward through
parent directories until it finds the nearest Agape project root. That project is
then opened in Studio.

This is why Studio ships with the Agape release package: the CLI knows what
project you are standing in, and the Studio should follow that project instead of
opening a canned demo.

## Versioning

Studio is versioned independently from the Agape language and runtime.

- **Studio version** is the UI app release. This repository is `1.0.0`.
- **Language version** comes from the active project metadata when declared.
- **Runtime version** comes from the configured runtime deployment.

That means the same Studio can attach to:

- a local project opened with `agape studio`;
- a standalone local Agape checkout during development;
- a future hosted/cloud runtime such as Soma.

## Run From An Agape Project

Install or build the Agape CLI, then create or open a project:

```sh
agape init my-app
cd my-app
agape studio
```

You can also run `agape studio` from a subdirectory inside the project. Studio
will climb to the nearest `agape.toml` and use that as the project root.

## Run This Repository Directly

This repository contains the Studio frontend and its local agent-server shim.
For local development, keep an Agape checkout nearby and run:

```sh
cd agent-server
npm install
npm run dev
```

In a second terminal:

```sh
cd web
npm install
npm run dev
```

The Vite frontend proxies project/runtime calls to the local agent server on
`127.0.0.1:8799`.

Useful environment variables:

```text
AGAPE_PROJECT=/path/to/an/agape/project
AGAPE_BIN=/path/to/agape
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
GEMINI_API_KEY=...
```

If `AGAPE_PROJECT` points inside a project, the server resolves upward to the
nearest `agape.toml`.

## Build And Test

```sh
cd web
npm run build

cd ../agent-server
npm test
```

The current 1.0.0 release verifies the web build and the agent-server integration
suite, including project-root discovery and runtime deployment configuration.

## Repository Layout

```text
agent-server/  local Studio backend: project APIs, providers, memory, review
web/           React + Vite + Monaco frontend
programs/      small Studio/console examples
server/        legacy lightweight API prototype
STUDIO.md      product architecture notes
TESTING.md     testing notes
```

## Status

Agape Studio `1.0.0` is the first standalone Studio release. It is still designed
to ship inside the Agape package for the smoothest local experience, but the
frontend is intentionally detachable so it can later connect to any compatible
Agape runtime.
