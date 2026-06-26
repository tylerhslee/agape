// Pure prompt construction for the studio's builder agent. No I/O, no SDK — so it
// is trivially unit-testable. server.ts wraps these with the live Claude call.
//
// This stands in for an Agape *operator* (STUDIO.md §2): an agent with authority,
// working one unit of work toward its destination. When the Agape backend lands,
// the operator is a real Agape agent and this prompt logic is replaced by its program.

export interface WorkItem {
  title: string;
  destination?: string;
  status?: string;
  mode?: string;
  assignee?: string | null;
}

export interface ThreadMsg {
  who: "you" | "ai" | "sys";
  text: string;
}

export type Intent = "respond" | "kickoff";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export function systemPrompt(item: WorkItem): string {
  return [
    "You are a builder agent inside Agape Studio, an IDE for agentic programming.",
    "You collaborate with a human who is directing the work. You own ONE unit of work and help move it toward its destination.",
    "",
    "Agape is the language you build in: an agent holds `grants` (the authority for what it may do), a model's answer comes back as a typed `Credence` (a graded judgment, not a trusted string), an `endorse` gate collapses a Credence into a trusted `Decision` only when it clears a confidence bar (otherwise it abstains), and every step is recorded on an append-only, replayable spine.",
    "",
    "Be concise and concrete. Lead with the outcome. Propose the next step rather than surveying options. Ask the human only when a decision genuinely needs them. Do not narrate routine actions.",
    "",
    `Current work item — title: "${item.title}"; destination: "${item.destination || "(not yet stated)"}"; status: ${item.status || "active"}.`,
  ].join("\n");
}

const KICKOFF_INSTRUCTION =
  "You've just been delegated this work item. In a few lines: (a) restate the goal in one sentence, (b) give a short 3–5 step plan, (c) name the first concrete thing you'll do. If something genuinely blocks you from starting, ask one focused question instead.";

const COLD_START =
  "Get started on this work item — share how you'd approach it.";

// Build the (system, messages) pair for a Claude Messages request. `sys` thread
// entries are UI breadcrumbs (e.g. "delegated to Builder-1") and are not sent to
// the model. The result always begins with a user turn and, for both intents, ends
// with a user turn so the model produces an assistant reply.
export function buildMessages(
  item: WorkItem,
  thread: ThreadMsg[],
  intent: Intent = "respond"
): { system: string; messages: ChatMessage[] } {
  const messages: ChatMessage[] = [];
  for (const m of thread) {
    if (m.who === "you") messages.push({ role: "user", content: m.text });
    else if (m.who === "ai") messages.push({ role: "assistant", content: m.text });
  }

  if (intent === "kickoff") {
    messages.push({ role: "user", content: KICKOFF_INSTRUCTION });
  }

  if (messages.length === 0 || messages[0].role !== "user") {
    messages.unshift({ role: "user", content: COLD_START });
  }

  return { system: systemPrompt(item), messages };
}
