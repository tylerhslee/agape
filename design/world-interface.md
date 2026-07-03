# Design: the world interface — wired events and actions (no `tool` in the language)

Status: **design settled, pre-implementation** (2026-07-03).
Supersedes the §6b half of [[design/delegation-and-actions.md]] (the single-door
`write tool` + `action … uses` shape committed to this branch as 59ca03c,
never released). Owner review found the tool/action duality confusing — a `write tool`
looks like a callable function but is not, and its parameters are declared twice — and
asked that `tool` be removed from the language semantics entirely. Delegation (§6c) is
unaffected.

Design stance, one line: **the program speaks only `event` (inbound) and `action`
(outbound); "tool" is a manifest concept — an endpoint in the deployment catalog that
events and actions are wired to.**

---

## 1. The model

```agape
event  SearchResult(text hits);      // inbound:  the world talks TO the program in events
action Search(text query);           // outbound: the program acts ON the world in actions
action Deploy(text artifact);
action Announce(text note);          // unwired action: a pure ledgered performative
```

```toml
[tools.web_search]                   # the endpoint catalog — the ONLY place "tool" exists
driver = "mcp"
tool   = "web.search"

[actions.Search]                     # outbound wiring: perform → effector; reply → event
tool         = "web_search"
result_event = "SearchResult"

[actions.Deploy]                     # outbound wiring, fire-and-forget (no result event)
tool = "infra_deploy"

[events.NewsArrived]                 # inbound wiring: a standing sensor appends events
tool = "news_feed"

[events.SearchRequested]             # emit-trigger wiring: the LOOSE observation channel
tool         = "web_search"
result_event = "SearchResult"
```

- **Source declares WHAT exists** — typed events and actions. No `tool`, `read`,
  `write`, `uses`, or `use` anywhere in the language.
- **The manifest declares HOW they touch the world** — `[tools.*]` is the endpoint
  catalog; `[actions.NAME]` wires a perform to an effector (optionally naming the
  `result_event` its reply lands as); `[events.NAME]` wires an event either as a
  standing sensor (arrivals append it) or as an emit-trigger (emitting it invokes the
  endpoint; the reply lands as `result_event`).
- **Unwired = pure.** An unwired action is a ledgered performative (the act is the
  record); an unwired event is a plain record. Wiring is additive and changes no
  program semantics — only what the deployment does at the seam.

## 2. Read vs write moves to WHICH VERB you wire

The old `read`/`write` effect class is replaced by the verbs' existing trust semantics:

- **Wire a read to an `emit`** (`[events.SearchRequested]`): `emit` is not a
  consequential sink, so tainted payloads flow — today's loose observation channel
  (RAG-style model-suggested queries), now an explicit, manifest-visible opt-in.
  **No laundering:** the `result_event` payload carries the JOIN of the triggering
  emit's payload trust (a raw query taints its own results), exactly the old
  read-tool rule.
- **Wire a read (or any effector) to a `perform`** (`[actions.Search]`): the uniform
  consequential-sink rule applies — **settled args only**. Since prompts and other
  external data are settled by origin, ordinary flows work unchanged; model-generated
  payloads must be gated first.
- **The anti-exfiltration property (owner-selected):** on the perform path, no
  un-endorsed cognition ever leaves the process — T3 non-interference extends to
  observation requests. A deployment that wires ALL its outbound seams to actions has
  the hard guarantee; each emit-wiring is a visible, auditable exception in the manifest.

## 3. Foreground perform binding (owner-selected)

A wired action with a `result_event` supports result binding, reusing the §6c
delegation discipline — the world is just another worker:

```agape
text hits = perform Search("prior art") expires 5;
```

- `expires` MANDATORY on the binding form (terminal-by-construction, §6c); failure or
  expiry faults the awaiting invocation via the contained-crash path (§5/§16.6).
- The binding is typed from the manifest-named result event's payload (the checker
  already receives the manifest): a single-field event binds that field's value
  directly; a multi-field event binds a struct of its fields. With no manifest in
  scope the binding types conservatively (`unknown`) and the runtime enforces.
- Statement-form `perform Search(q);` stays legal (reactive consumption via
  `when (SearchResult r …)`), wired or not.
- A foreground binding on an action with NO configured `result_event` is a
  ConfigError at runtime (there is nothing to bind).

## 4. Trust, authority, color

- **Trust:** result-event payloads are external data — settled by origin — JOINED with
  the request payload's trust (perform path: settled request → settled results;
  emit path: join, so raw queries taint their results). Standing-sensor arrivals are
  settled by origin (no request payload), like `prompt`.
- **Authority:** `perform NAME` (grants) governs all outbound acts. `use` grants are
  GONE. Emitting stays grant-free (an emit-wired observation is deployment-controlled
  via the manifest, not grant-controlled — documented posture, mirrors `prompt`).
  Grants are now exactly `perform` + `reach`.
- **Color:** every `perform` is async (an act is an act; whether it reaches the world
  is a deployment fact the checker must not depend on). Expressions can never reach
  the world; `sync` = no sends, no performs, no memory seams.

## 5. Ledger shape

- The DOMAIN story is named, typed rows: the action's own row (`Search(...)`,
  `Deploy(...)`) and the result/sensor event rows (`SearchResult(...)`).
  This answers "every tool should be tied to a specific event or an action" —
  structurally, because there is nothing else for a wiring to attach to.
- `ToolStarted(name)` / `ToolResolved(name)` REMAIN, demoted to the seam's replay
  journal (§16.5 requires the verbatim external call + result recording; §15.5.1
  incidental trace). They are appended for every wired invocation (emit- or
  perform-triggered), correlated by catalog name, beneath the domain rows.
- Order for a wired perform: action row → ToolStarted → ToolResolved → result event
  row (when configured). For a wired emit: event row → ToolStarted → ToolResolved →
  result event row.

## 6. What leaves the language

- Keywords `tool`, `read`, `write` (tool grammar), contextual `uses`, grant class
  `use NAME`. The single-door rule, the illegal-`use`-on-write rule, and the
  read/write effect class all cease to exist rather than being enforced.
- §15.3.2 T-Tool-Read and the tool clause of W-Auth are removed; E-Tool becomes the
  wired-seam step of E-Perform / E-Emit. §13's dependency table row for the world
  becomes "reached at `perform A(args)` / a wired `emit` / a standing sensor".
- `prompt` stays as-is for now — it is recognizably a special case of a standing
  sensor wiring and may fold into `[events.*]` in a later rev (noted, not done).

## 7. Compat and scope

- Breaks every existing `.ag` that declares/calls tools (examples, demos, showcase,
  ~20 conformance tests). The suite REWORK is mostly deletions and simplifications;
  examples migrate `text hits = search(q)` → `text hits = perform Search(q) expires N;`
  (+ manifest wiring) or the emit/when pair.
- §17.1 strict-binding: tools are no longer source-declared dependencies, so the
  "unbound declared tool → ConfigError" rule retargets: `[actions.*]`/`[events.*]`
  wiring entries must reference existing `[tools.*]` catalog entries and declared
  action/event names; a foreground-bound perform without a `result_event` is a
  ConfigError.
- Version: v1.0.0-alpha.2026.7.3.0 (same branch as delegation; nothing released).

## 8. Decision log (owner, 2026-07-03)

1. Remove `tool` from language semantics entirely; manifest-only. — owner
2. Reads wire to EMITS typically (loose channel), to PERFORMS when the programmer
   chooses (gated channel). — owner
3. Uniform settled-only rule for ALL perform args (anti-exfiltration). — owner
4. Foreground perform binding (delegation-style) adopted. — owner
5. Result trust = join with request payload; journal pair retained; prompt untouched;
   perform always async. — design defaults, documented here.
