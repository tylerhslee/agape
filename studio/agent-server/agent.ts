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

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export type Intent = "respond" | "kickoff" | "plan" | "build" | "inspect" | "run" | "review";

export interface AgentContext {
  project?: string;
  memory?: string;
  operation?: string;
}

export function systemPrompt(item: WorkItem, context: AgentContext = {}): string {
  const parts = [
    "You are a builder agent inside Agape Studio, an IDE for agentic programming.",
    "You collaborate with a human who is directing the work. You own ONE unit of work and help move it toward its destination.",
    "",
    "Agape is the language you build in: an agent holds `grants` (the authority for what it may do), a model's answer comes back as a typed `Credence` (a graded judgment, not a trusted string), an `endorse` gate collapses a Credence into a trusted `Decision` only when it clears a confidence bar (otherwise it abstains), and every step is recorded on an append-only, replayable ledger.",
    "",
    "Conversation contract: answer the user's current turn now from the observations supplied to you. Never reply with placeholder progress such as \"I will retrieve\", \"please hold\", \"one moment\", or \"retrieving\". If the server turn did not actually edit files, run code, or call a tool, describe the next step as a proposal rather than as completed work. Do not expose hidden reasoning or chain-of-thought; give the conclusion, evidence, and next useful action.",
    "",
    "Be concise and concrete. Lead with the outcome. Use the project context you were given. Ask the human only when a decision genuinely needs them. Do not narrate routine actions.",
    "",
    `Current work item — title: "${item.title}"; destination: "${item.destination || "(not yet stated)"}"; status: ${item.status || "active"}.`,
  ];
  if (context.operation) {
    parts.push("", "Turn orchestration:", context.operation);
  }
  if (context.project) {
    parts.push("", "Project context:", context.project);
  }
  if (context.memory) {
    parts.push("", "Builder memory context:", context.memory);
  }
  return parts.join("\n");
}

const KICKOFF_INSTRUCTION =
  "You've just been delegated this work item. Start it now from the supplied context. If the work asks for inspection or summary, give the findings directly. Otherwise give the concrete first move and any evidence you already have. Avoid placeholder future-tense updates.";

const COLD_START =
  "Get started on this work item — share how you'd approach it.";

const INTENT_INSTRUCTIONS: Record<Exclude<Intent, "respond" | "kickoff">, string> = {
  plan: "Plan this work from the supplied context. Return a short sequence of concrete steps and call out the next smallest useful action.",
  build: "Build-oriented response: identify the smallest safe Agape change, any files likely involved, and the first implementation step.",
  inspect: "Inspect the supplied project context and answer with concrete findings. Include evidence from files, agents, prompts, ledger behavior, or memory when available. Do not merely promise to inspect.",
  run: "Run-oriented response: explain what should be executed, what ledger evidence matters, and what outcome would confirm the behavior.",
  review: "Review the current state for gates, authority, memory, provider behavior, and human-decision risk. Lead with any issue that could mislead the user.",
};

// Build the (system, messages) pair for a Claude Messages request. `sys` thread
// entries are UI breadcrumbs (e.g. "delegated to Builder-1") and are not sent to
// the model. The result always begins with a user turn and, for both intents, ends
// with a user turn so the model produces an assistant reply.
export function buildMessages(
  item: WorkItem,
  thread: ThreadMsg[],
  intent: Intent = "respond",
  context: AgentContext = {}
): { system: string; messages: ChatMessage[] } {
  const messages: ChatMessage[] = [];
  for (const m of thread) {
    if (m.who === "you") messages.push({ role: "user", content: m.text });
    else if (m.who === "ai") messages.push({ role: "assistant", content: m.text });
  }

  if (intent === "kickoff") {
    messages.push({ role: "user", content: KICKOFF_INSTRUCTION });
  } else if (intent !== "respond") {
    messages.push({ role: "user", content: INTENT_INSTRUCTIONS[intent] });
  }

  if (messages.length === 0 || messages[0].role !== "user") {
    messages.unshift({ role: "user", content: COLD_START });
  }

  return { system: systemPrompt(item, context), messages };
}
