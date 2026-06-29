# Agape Studio — Architecture Blueprint

*The IDE for agentic programming.*

This document is the **product and architecture blueprint** for Studio: what it is,
how it is organized, and the models everything else is built on. It is the
companion to two existing documents:

- `[README.md](README.md)` — how to run Studio *today* (the Phase 1 console).
- `[../SPEC.md](../SPEC.md)` — the Agape language Studio is built to drive.

Where the README answers "how do I start it," this answers "what are we building,
and why is it shaped this way."

---

## 1. The paradigm

Every "AI IDE" today — Cursor, Copilot Workspace, Windsurf — is **AI bolted onto a
file-based text editor**. The human drives the editor keystroke by keystroke; the
model assists in the margins. The file is the object; typing is the verb.

Studio inverts the roles. **You direct; agents build; the work is the surface.**
The way Agape itself was built — a human stating a destination, an AI doing the
legwork, the human steering and reviewing — *that loop* is what Studio is designed
around from scratch, not a panel grafted onto an editor.

Three facts follow, and they shape the whole product:

1. **The center of gravity is the work, not a file or a chat.** The home screen is
   a dashboard of what is being built and what the agents are doing. Code and
   conversation are surfaces you *open from* a piece of work, not the place you
   live.
2. **Agents run 24/7.** The fleet works while you sleep. The primary human job is
   not authoring — it is **directing a standing team**: keeping it pointed at the
   destination, and handling the moments that need a person.
3. **Autonomy is fluid.** Any unit of work can be something you pair on
   turn-by-turn, or something you delegate and review. You slide it between those
   at will. Pair where judgment matters; delegate where it doesn't.

The architecture that expresses this is **hub-and-spoke**: the dashboard is the hub
(the project's living state and who is working on what); each piece of work opens
into a spoke — a pairing thread to steer it, or the code and behavior it produced
to review it. You return to the hub when you're done.

### The five principles

1. **Work is the center.** Not the file, not the chat. You operate on units of
   work; everything else is a tool you open from one.
2. **Altitude of intent.** You live at the level of destinations and tasks and
   zoom down to code only to inspect or correct, then pop back up.
3. **Agents are a fleet you direct.** Multiple agents work in parallel; you review
   their output like a lead reviewing a team — with fluid autonomy, not a single
   autocomplete.
4. **Steer mid-flight.** An agent's plan and progress are legible and
   interruptible. You redirect *while* it works, not only at the end.
5. **Review is the main loop.** Your scarce resource is attention. Every change
   arrives with its rationale and its evidence, laid out for fast judgment. The
   interface is optimized for reviewing, far more than for typing.

The dashboard exists to answer exactly two questions, fast: **what needs me right
now**, and **is the fleet healthy**. Everything deeper lives one click away in its
own section.

---

## 2. Two runtimes — the control plane and the app

Studio and the systems it builds **do not share a runtime**. Each runs as its own
Agape runtime, with its own ledger, its own agent population, its own grants and
config. Studio is a **control plane**; an app you build is a **separate runtime**
that the control plane drives across an isolation boundary — not a folder it
contains.

- **The studio runtime** is where you work. Its agents are *operators* — router,
  reviewer, escalator, watcher, builders — system-level staff that run Studio
  itself (in Agape, Phase 2). They are **invisible by default**; you meet them only
  in studio settings, when configuring Studio.
- **An app runtime** is a system you build and manage. Its agents are *product
  agents* — the refund agent, the triage agent — each with authority over its own
  domain. It has its own ledger and is, to Studio, an external thing it connects to
  and drives.

Studio holds **many** app runtimes and drives each across the boundary: spawn,
awake, read its ledger, open PRs against its source, deploy it.

Two consequences shape the whole product:

1. **The ledger is per-runtime; "whose ledger?" is always answered.** Almost every
   surface is scoped to a *selected app runtime* — its ledger, its agents, its
   config. The studio runtime's own ledger is operational; you open it only to
   debug Studio itself. The UI never shows an ambiguous "the ledger." A **runtime
   selector** in the shell sets the active context.
2. **Isolation is structural, not a convention.** Two runtimes means two audit
   logs and no shared state: Studio cannot entangle its state with an app's,
   because they do not share a runtime. This is **tenant isolation as an
   architectural fact** — the property frameworks lack (see
   `[COMPETITIVE_LANDSCAPE.md](../COMPETITIVE_LANDSCAPE.md)`).

Same machinery on both sides: operators and product agents are both ordinary Agape
agents (a `principal`, `grants`, a model — §5, §13). The only difference is which
runtime they belong to and what authority they hold. That is why **the operators
are configurable exactly like the agents you build** — see the config layering in
§6.

A development simulation stands in for the agentic layer today:
`[agent-server/](agent-server/README.md)` backs the operators with the Claude API
so pairing and delegation feel agentic before the Agape runtime exists. It lives
behind the same seam the Agape + MCP backend will implement, so swapping it in does
not touch the frontend.

**Work management itself stays fully manual and agent-free.** Capturing,
organizing, statusing, editing, and assigning work is *somatic*: it needs no agents. So is editing code and querying a
ledger. Only autonomous *routing, delegation, and execution* require the agentic
backend. Everything else is the surface you can exercise today, by hand, with zero
agents running. Slotting in the Agape operators adds the autonomy on top; it does
not change the somatic surface beneath it.

> The recursion this creates: Studio is itself an Agape app runtime, and a product
> app you ship becomes another runtime Studio manages. "Build agentic systems with
> Studio, then manage them with Studio" is the same operation one level up — agents
> all the way down.

---

## 3. Information architecture

Studio is twelve sections grouped into the four jobs you are doing. The navigation
*is* the feature map: grouping by job keeps breadth navigable instead of
overwhelming.

The **Operate**, **Build**, and **Manage** groups are all scoped to the **selected
app runtime** (§2). **Configure** spans two scopes — the app, and Studio itself.

| Group | Section | What it is | Maps to |
|---|---|---|---|
| **Operate** | Mission control | The dashboard home: what needs you, fleet health, work at a glance | — |
| | Escalations | Your decision / review inbox — the 24/7 heartbeat | the prompt boundary, §5b |
| | Event log | The selected app runtime's ledger, queryable | the ledger, §7 / §15.4.2a |
| **Build** | Work streams | The full board of every unit of work | — |
| | Threads | Pairing conversations with agents | cognition, `<-` §6 |
| | Code | The app's `.ag` source, diffs, review | the program |
| **Manage** | Agents | The app runtime's product agents: identity, grants, lifecycle, health | agents §5, grants §13 |
| | Context & memory | What each product agent knows; stores, retrieval | memory §10 |
| | Tools & seams | The somatic integrations the app reaches through | tool seam §6b |
| **Configure** | Providers & models | Cognition backends + calibration (app + studio scope) | manifest §16 |
| | Authority & policy | Grants defaults and governance (app + studio scope) | authority §13, §16 |
| | Manifest | Project configuration; **studio settings** (operators) live here too | §16 |

### Operate

- **Mission control** — the front door, scoped to the active app runtime. See §4.
- **Escalations** — the queue of moments that need a human. Crucially, escalations
  arrive from **both runtimes**: *build-time* (an operator needs a decision while
  constructing the app) and *run-time* (the managed app's own agents hit something
  needing a person). One inbox, two sources. See the escalation model in §5.3.
- **Event log** — the **selected app runtime's** ledger, live and queryable. The
  studio runtime's own ledger is reachable only from studio settings.

### Build

- **Work streams** — the complete board behind the dashboard's summary: a column
  per status, **parking lot → backlog (the roadmap) → in progress → needs you →
  done**. Where you *capture* work (a quick-add drops an item into the parking lot,
  no agent and no commitment required), refine it into the backlog, move items
  between statuses by hand, edit or archive them, and pair or delegate only when
  ready. This is the **roadmap** view — what's planned and what agents will pick up
  — not just what's running now. You never have to delegate at capture time.
- **Threads** — the pairing conversations. A thread belongs to a work item; opening
  one drops you into turn-by-turn collaboration with the agent on that work.
- **Code** — the app's `.ag` source and its diffs. Reached by zooming into a work
  item, or browsed directly. The Monaco editor lives here, but it is a *spoke*, not
  the home screen.

### Manage

- **Agents** — the **product agents** of the active app runtime: identity (their
  `principal`), grants, lifecycle (spawned / awake / asleep), health, current
  assignment, and per-agent slice of the app ledger. (The studio's *operators* are
  not here; they live in studio settings — §2, §6.)
- **Context & memory** — what each product agent knows (§10): per-agent and shared
  stores, provenance backpointers, and the context assembled for a cognition call.
- **Tools & seams** — the typed boundary to deterministic code (§6b) the app uses.

### Configure

- **Providers & models** — cognition backends behind `self <- …`, with calibration.
  Settable at app scope (this app's models) and studio scope (operator models).
- **Authority & policy** — default grants and governance, for both the app's product
  agents and the studio's operators.
- **Manifest & studio settings** — the app's `agape` manifest (§16), and the
  **studio settings** surface where the operators (plane-1 system agents) are
  configured. This is the one place the control plane becomes visible.

---

## 4. Mission control (the home)

Mission control has one job: answer **what needs me** and **is the fleet healthy**,
for the **selected app runtime**, in the time it takes to glance. It contains
exactly three zones and deliberately nothing else:

1. **A metric strip** — the four numbers that summarize the system: *needs you*,
   *agents active*, *streams* (done / total), *events today*. *Needs you* is the
   only one that should ever pull the eye.
2. **The "needs you" queue** — the top of the Escalations inbox, inline. Each row
   is one human moment with a one-line summary and a single primary action
   (`decide`, `review`, `approve`). If this zone is empty, the system is running
   itself.
3. **The fleet** — ambient awareness of who is doing what, with a status dot and a
   last-activity time. Not actionable; just situational.

What is **not** here: full work cards, code, diffs, configuration, and the studio's
own operators. The earlier failure mode was a board where every card carried
status, mode, agent, and actions at once — chip soup. The rule that fixes it:
**one question per zone, and detail lives in the section you click into.**

---

## 5. The core models

Three models underpin every section.

### 5.1 The work item — the unit of work

A work item is the atom Studio is built on. It carries:

- **Destination** — the intent, in natural language. The thing it is converging on.
- **Status** — see the taxonomy below.
- **Mode** — `paired` or `delegated` (§5.2).
- **Assignment** — the agent(s) on it.
- **Artifacts** — the code, diffs, and events it has produced.
- **Thread** — its pairing conversation.
- **Evidence** — the tests and observed behavior that justify its current state.

**Status taxonomy:**

| Status | Meaning | Pulls attention? |
|---|---|---|
| `parked` | captured in the parking lot — a raw idea, not refined or scheduled | no |
| `backlog` | refined and planned — the roadmap an agent (or you) will pick up | no |
| `drafting` | being defined with you right now; not yet handed off | no |
| `active` | an agent (or you) is working it (see mode, §5.2) | no |
| `waiting` | needs you — raises an escalation (§5.3) | **yes** |
| `exploring` | forked into parallel approaches, running concurrently | no (until compare) |
| `blocked` | cannot proceed; external dependency or error | **yes** |
| `done` | delivered and verified | no |

**Work is captured first and scheduled later.** A new item lands in `parked` (the
parking lot) with no agent and no commitment; you promote it to `backlog` (the
roadmap) when it's ready, and only then start or delegate it. Nothing forces you to
delegate at capture time.

Status drives color across the whole product, consistently: muted = parked, blue =
backlog/active, amber = needs you, teal = exploring, green = done.

### 5.2 Fluid autonomy — pairing ↔ delegated

Mode is orthogonal to status. The same work item can move between two modes:

- **Paired** — a turn-by-turn thread; you are in the loop on each step. High
  collaboration, high control. Used when judgment matters.
- **Delegated** — the agent runs autonomously and reports back. Higher leverage,
  more supervision burden. Used when the path is clear.

The transitions are first-class gestures, not a settings change:

- **Hand off** (paired → delegated): you've established the approach in a thread;
  let the agent run with it.
- **Pull back** (delegated → paired): a delegated item is going sideways; bring it
  into a thread to course-correct.
- **Promote / drop** (exploring): a fork proves out; keep it and discard the rest.

A delegated item that hits a question it cannot resolve does not stall silently —
it **raises an escalation**. That is the contract that makes 24/7 delegation safe.

### 5.3 The escalation — the 24/7 contract

Agents run when no one is watching. The escalation is how an agent asks for a human
without blocking the rest of the fleet. It is the single most important model in
Studio, because it is what makes standing delegation trustworthy.

Escalations originate in **either runtime** (§2) and converge on one inbox:
*build-time* escalations from operators constructing the app, and *run-time*
escalations from the managed app's own product agents.

**Kinds:**

| Kind | Raised when | Resolution |
|---|---|---|
| `decision` | a choice the agent isn't authorized or confident to make | you choose |
| `review` | work is complete and wants sign-off before it lands | you review the diff |
| `approval` | the agent needs an authority grant it doesn't hold | you grant or deny |
| `blocked` | an external dependency or error halts progress | you unblock or reassign |

**Every escalation carries**, so it can be resolved without spelunking:

- *what* — a one-line summary of the ask.
- *why* — the reason it needs a human, in the agent's words.
- *evidence* — the relevant events, diff, or behavior, one click away on the ledger.
- *options* — the concrete choices, where applicable.
- *default-if-ignored* — what happens if you never answer (often: the stream waits;
  for some, a safe default after a window). Made explicit, never implicit.
- *origin* — which runtime (studio vs app) and which agent raised it.

**Lifecycle:** `raised` → `queued` (appears in the inbox and the dashboard's *needs
you* zone) → `resolved` (decided / reviewed / approved / unblocked) → the originating
stream **resumes** automatically. Resolution is recorded on the originating
runtime's ledger, so *why a human decided what they did* is part of that runtime's
audit trail.

This is also the natural Phase-2 binding: an escalation is an external input
arriving at a program, exactly the boundary §5b describes. When a backend is Agape,
an escalation *is* a `prompt` arrival, and the human's answer is the value.

---

## 6. How it maps onto Agape

Studio is not a generic agent dashboard with Agape underneath; it is the **native
console for Agape's primitives**. Each section is a lens onto something the language
already has:

- **Two runtimes / two ledgers** ↔ runtime isolation: each runtime is a distinct
  append-only, hash-chained ledger (§7, §15.4.2a). The studio runtime is the control
  plane; app runtimes are the managed tenants. This is the tenant isolation no
  framework has.
- **Operators vs product agents** ↔ the same agent model (§5) with different
  `grants` (§13): operators hold authority over the studio's API (assign work, open
  PRs, route escalations); product agents hold authority over their own domain
  (`perform Refund`). Plane is just program-membership + authority — not a new
  concept.
- **Event log** ↔ the ledger (§7). Append-only, queryable, replayable (§15.4.2a),
  one per runtime.
- **Context & memory** ↔ the three memory modalities and provenance (§10).
- **Tools & seams** ↔ the typed tool boundary (§6b) and the somatic/agentic split.
- **Escalations** ↔ the external-input boundary (§5b).

### Configuration layering

Config behaves "like any app," in two scopes that mirror Agape's manifest precedence
(§16.2: global → project → local):

- **App-level (studio) defaults** — the studio runtime's own manifest, including its
  operators' models, grants, calibration, and escalation policy. The baseline staff.
- **Project-level overrides** — a managed app can override what applies to it (this
  app's reviewer is stricter; this app swaps a model). Higher precedence wins.

The same precedence governs each managed **app runtime's** own manifest, applied to
its product agents. So there are two precedence chains — one for the control plane,
one per app — never entangled, matching the runtime isolation of §2.

This is the **honesty boundary**, now per-runtime: in each runtime the socket/HTTP
layer is a somatic device, while routing, lifecycle, ledger queries, and response
shaping are application logic, written in Agape (see `[README.md](README.md)`). In
Phase 2, "the backend is Agape" becomes literally true for the studio runtime, and
Studio doubles as the flagship example program.

---

## 7. Build sequencing

The blueprint is large; the path through it is not. Build in order of proof, each
step standing on the last. Per the project workflow, **document → write tests →
implement** at every step.

1. **Runtime-scoped core + hub-and-spoke MVP** — model a *selected app runtime* as
   the scope for Mission control's three zones, plus exactly **one** openable
   spoke: a work item that opens into a live pairing thread and back. This proves
   the central model — runtime scoping, work-as-center, hub-and-spoke, fluid
   autonomy — end to end, with the least surface area. (Operators remain mocked and
   invisible at this stage.)
2. **Escalations inbox** — the full queue and the escalation lifecycle (§5.3),
   including the build-time vs run-time origin. This is what makes 24/7 delegation
   real; it is the second-most-important surface after the dashboard.
3. **Agents + Event log** — both are largely *read-side* over events a runtime
   already emits, so they are closer than they look. Reuse the existing
   the legacy `SpinePanel` component → Event log and `AgentsExplorer` → Agents/fleet, now runtime-scoped.
4. **Context, Code/review spoke, Configure (incl. studio settings)** — the
   management and configuration depth, including the operators surface and the
   app/studio config layering, layered on once the operating core is solid.

The existing Phase 1 components are the raw material; this sequence reshapes them
from a VS Code skin into the runtime-scoped, work-centric console described above.

---

## 8. Open questions

Genuine decisions deferred until the core is built:

1. **Runtime connection.** How does Studio attach to an app runtime — local process,
   remote endpoint, both? How does the control plane authenticate to drive it?
2. **Studio's own ledger.** Is the studio runtime's ledger ever surfaced beyond
   debugging — e.g., an audit of what the operators did on your behalf?
3. **Work-item granularity.** Is a "stream" a feature, a task, or a freely nestable
   tree? Leaning: nestable, but the dashboard only ever shows the top level.
4. **Default-if-ignored policy.** Which escalation kinds get a safe auto-default
   after a window, and which wait forever? A safety question, decided per kind.
5. **Fleet scaling.** At what point does the flat fleet list need grouping (by app,
   by role, by health)? Defer until there are enough agents to hurt.
6. **Thread ↔ ledger relationship.** A pairing thread is itself a sequence of events;
   is it a distinct view, or a filtered lens on the app ledger? Leaning: a lens.
