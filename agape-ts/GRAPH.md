# The orchestration graph — derived, not drawn

`agape graph` (and Studio's Graph view) statically derives the agent-orchestration graph of an
Agape program from its source. Where a LangGraph-style framework asks the programmer to hand-author
the graph and hopes the code matches it, Agape's kernel is constrained enough (declared agents,
hoisted `when` subscriptions, bounded fan-out, no dynamic topology) that the graph is a **verified
consequence of the code**: the produce/consume relation over declared event types, the gate
structure, and the sink-admissibility rule are all read off the checked AST.

This is tooling — it adds no language semantics. The extraction consumes the same AST the checker
validates; a program that parses and checks always has a graph.

## Node kinds

| kind        | one per…                                   | label                    | notable meta |
|-------------|--------------------------------------------|--------------------------|--------------|
| `top`       | program with top-level statements/handlers | `program`                | — |
| `agent`     | statically spawned instance                | `name: AgentType`        | `agentType`, `grants`, `spawnLine` |
| `handler`   | `when` clause (in an agent or top-level)   | `when EventType`         | `guard`, `about` |
| `hook`      | `on awake/sleep/crash` hook                | `on awake`               | — |
| `gate`      | `decide` site                              | `decide Credence<E>`     | `enum`, `rule`, `principal`, `quorum`, `endorses` |
| `sink`      | action that some `perform` targets         | action name              | `reversible`, `fields` |
| `tool`      | tool that some call targets                | tool name                | `effect`, `reversible` |
| `principal` | declared `principal`                       | name                     | — |
| `prompt`    | declared `prompt T NAME` sensor            | `prompt T NAME`          | `type` |
| `mem`       | `mem` handle (per instance)                | handle name              | — |
| `event`     | emitted event type with **no** subscriber  | `EventType (unconsumed)` | — |
| `ledger`    | program that queries the ledger            | `ledger`                 | — |

`agent`, `top` also act as **clusters**: `handler`/`hook`/`gate`/`mem` nodes carry a `parent`
pointing at the instance they live in. Every node carries a 1-based source `line` for
click-to-source.

Instances are statically known because `spawn Worker w;` names both. A send whose destination
cannot be resolved to a static instance (e.g. an agent-typed parameter) yields an *unresolved*
agent node labelled with the binding name — the edge is still drawn, marked `resolved: false`.

## Edge kinds

| kind       | drawn from → to                                        | label |
|------------|--------------------------------------------------------|-------|
| `event`    | emitting site's node → each subscribing `handler`      | event type |
| `prompt`   | `prompt` sensor → `when (Prompt p about NAME)` handler | `Prompt` |
| `send`     | sending context → destination `agent`                  | expected reply type (when bound `T x = dest <- …`) |
| `flow`     | handler/hook → its `gate` (the credence chain)         | `Credence<E>` |
| `escalate` | `gate` → `principal` (a principal-prefixed decide)     | `escalate` |
| `sink`     | gate (or context) → `sink`                             | action; `variant` = the committed branch guarding it |
| `tool`     | context → `tool`                                       | tool name |
| `store`    | context → `mem`                                        | `store` |
| `recall`   | `mem` → context                                        | `recall` (always-tainted; rendered dashed) |
| `query`    | `ledger` → context                                     | queried event type |
| `spawn`    | spawning context → `agent`                             | `spawn` |

**Variant-guarded edges**: while walking a body, an `if (d.committed == V)` whose scrutinee binds a
`decide` in the same context pushes that gate+variant; a `perform`/`emit`/send inside the branch is
attributed to the *gate node* with `variant: V`. This is exactly the §13 story made visible: the
sink edge exists only out of a committed branch, and the graph shows which variant arms it.

Self-sends (`self <- …`, the agent's own cognition) do not draw an edge; the resulting gate node's
`flow` edge carries the credence type, which is the informative part.

## JSON shape

```jsonc
{
  "program": "claims_desk/claims_desk.ag",
  "nodes": [ { "id": "agent:desk", "kind": "agent", "label": "desk: ClaimsDesk",
               "parent": null, "line": 12, "meta": { "agentType": "ClaimsDesk" } } ],
  "edges": [ { "id": "e3", "from": "gate:desk/when:0#0", "to": "sink:Reimburse",
               "kind": "sink", "label": "Reimburse", "variant": "Approve", "line": 31 } ]
}
```

Stable ids: `agent:<inst>`, `handler:<inst>/when:<i>`, `hook:<inst>/awake`,
`gate:<ctx>#<j>`, `sink:<Action>`, `tool:<name>`, `principal:<name>`, `prompt:<name>`,
`mem:<inst>/<name>`, `top`, `ledger`, `event:<E>`.

## Surfaces

- **CLI**: `agape-ts graph <file.ag> [--format json|dot]`. `dot` emits Graphviz with agent
  clusters as subgraphs. The program is parsed **and checked** first — a rejected program
  reports the rejection, not a graph of unverified code.
- **Studio**: `GET /api/graph?name=<program>` returns `{ ok, graph }` (or the parse/check error).
  The Graph panel renders it as layered SVG — sources (prompts) left, agent clusters ranked by
  message depth, effects (sinks/tools/principals/ledger) right. Clicking a node jumps the source
  view to its line.
- **Live overlay**: after (and during) a run, ledger events light up the elements they touched —
  `Decided`/`Endorsed` → the gate, `PrincipalDecision`/`FailedPrincipalDecision` → the escalate
  edge + principal, a sink etype → the sink node and its guarded edge, `Prompt` → the sensor,
  `Sent`/`Resolved` → the send edge, `Internalized`(mem)/`MemoryConsulted` → the mem edges,
  `ToolStarted`/`ToolResolved` → the tool. The static graph is the *proof shape*; the overlay is
  the *witnessed path* through it.

## What the graph deliberately does not claim

- `mem`-mediated flow is content-based: `store`/`recall` edges show the coupling to the substrate,
  not which store feeds which recall (rendered dashed for exactly this reason).
- Arbitrary `if` predicates are not modelled beyond `.committed == V` narrowing; edges from
  un-guarded regions attach to the context node without a variant.
- The overlay matches gate events to gate nodes by (agent, enum) — two gates over the same enum in
  one handler light together. Ids are not threaded through the runtime (no semantics changes for
  a viewer).
