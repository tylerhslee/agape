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
| `ask`       | self-send (`self <- …`) — a testimony step | `ask Credence<E>`        | `reply`, `binding` |
| `gate`      | `decide` site — a STANDALONE decision diamond named by the enum (not a cluster member: the chain drops out of the agent box into it) | `decide Credence<E>` | `enum`, `rule`, `principal`, `quorum`, `endorses`, `agent` |
| `sink`      | each `perform` SITE (one box per site)     | `perform Action`         | `action`, `variant`, `reversible`, `agent` |
| `emit`      | each `emit` SITE (one box per site; dashed when no subscriber) | `emit Event` | `event`, `variant`, `consumed`, `agent` |
| `tool`      | tool that some call targets                | tool name                | `effect`, `reversible` |
| `principal` | declared `principal`                       | name                     | — |
| `prompt`    | declared `prompt T NAME` sensor            | `prompt T NAME`          | `type` |
| `mem`       | `mem` handle (per instance)                | handle name              | — |
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
| `event`    | gate/context → its `emit` site (branch-guarded), and `emit` site → each subscribing `handler` (labelled by the event type) |  |
| `prompt`   | `prompt` sensor → `when (Prompt p about NAME)` handler | `Prompt` |
| `send`     | sending context → destination `agent`                  | expected reply type (when bound `T x = dest <- …`) |
| `flow`     | the ask/gate dataflow chain: hook/handler → `ask` → … → `gate` (unlabelled — the target node names the type). An ask's in-edges come from the asks whose bindings its prompt references; a gate's from the asks that produced its credence **and** its endorsed subject. |
| `escalate` | `gate` → `principal` (a principal-prefixed decide)     | `escalate` |
| `sink`     | gate (or context) → the `perform` site                 | `variant` = the committed branch guarding it |
| `tool`     | context → `tool`                                       | tool name |
| `store`    | context → `mem`                                        | `store` |
| `recall`   | `mem` → context                                        | `recall` (always-tainted; rendered dashed) |
| `query`    | `ledger` → context                                     | queried event type |
| `spawn`    | spawning context → `agent`                             | `spawn` |

**Variant-guarded edges**: while walking a body, an `if (d.committed == V)` whose scrutinee binds a
`decide` in the same context pushes that gate+variant; a `perform`/`emit`/send inside the branch is
attributed to the *gate node* with `variant: V` — and the residual `else` of the chain carries
`variant: "abstain"`. In the UI a gate's out-edges are labelled by BRANCH only (`Publish`,
`Revise`, `abstain`), flowchart-style, at the fork: the target box already names the consequence
(`perform Announce`, `emit Revised`). This is the §13 story made visible: the sink edge exists
only out of a committed branch, and the graph shows which variant arms it.

Self-sends (`self <- …`, the agent's own cognition) are `ask` nodes — each one is a model call
producing a typed reply, i.e. a TESTIMONY step in the §13 chain, so it is part of the topology.

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
  clusters as subgraphs. The graph is **syntactic**: a program that parses always has one. A
  static-check rejection is reported alongside it (stderr note / `check` field / a UI badge) —
  a deliberately-rejected demo still shows the topology the checker refused to run.
- **Studio**: `GET /api/graph?name=<program>` returns `{ ok, graph, check? }` (or the parse error).
  The Graph panel renders a **vertical** flow (the kernel chain reads top → bottom): sources at the
  top, agent clusters ranked by message depth, effects (sinks/principals/tools) at the bottom.
  Connectors are **orthogonal** (LucidChart-style): down-edges leave spread ports on a node's bottom
  edge, run along a dedicated per-edge horizontal channel in the inter-rank gap — where their labels
  live, guaranteed box-free — and drop into spread ports on the target's top; up-edges route around
  the right margin. A post-render pass measures real label boxes and nudges any residual contact.
  The SVG scales to the column width (sized for 100% browser zoom). Clicking a node jumps the
  source view to its line. **The static graph renders grey; executing the program lights the
  witnessed path in color** (green testimony/gate chain, gold sinks, amber escalation — red on a
  fail-closed decline), driven by the run's ledger events.
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
