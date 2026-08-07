import { createServer, type IncomingHttpHeaders, type Server } from "node:http";

export interface OpenAIRequest {
  model?: string;
  messages?: Array<{ role?: string; content?: unknown }>;
  logprobs?: boolean;
  top_logprobs?: number;
  n?: number;
  response_format?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface RawCandidate {
  token: string;
  logprob: number;
  bytes: number[] | null;
}

export interface ContentTokenEvidence extends RawCandidate {
  top_logprobs: RawCandidate[];
}

export interface CompletionChoice {
  content: string;
  contentEvidence?: ContentTokenEvidence[];
  finishReason?: string;
}

export interface TranscriptEntry {
  index: number;
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: OpenAIRequest;
}

export interface ScriptedResponse {
  status?: number;
  body: Record<string, unknown>;
}

export type LoopbackScript = (request: TranscriptEntry) => ScriptedResponse | Promise<ScriptedResponse>;

export class OpenAILoopback {
  readonly transcript: TranscriptEntry[] = [];
  private server?: Server;
  private port?: number;

  constructor(private readonly script: LoopbackScript) {}

  async start(): Promise<void> {
    if (this.server) return;
    this.server = createServer(async (req, res) => {
      let raw = "";
      req.setEncoding("utf8");
      for await (const chunk of req) raw += chunk;
      let body: OpenAIRequest;
      try { body = JSON.parse(raw) as OpenAIRequest; }
      catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "loopback expected JSON" } }));
        return;
      }
      const entry: TranscriptEntry = {
        index: this.transcript.length,
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body,
      };
      this.transcript.push(entry);
      if (entry.method !== "POST" || entry.url !== "/v1/chat/completions") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `unexpected ${entry.method} ${entry.url}` } }));
        return;
      }
      try {
        const scripted = await this.script(entry);
        res.writeHead(scripted.status ?? 200, { "content-type": "application/json" });
        res.end(JSON.stringify(scripted.body));
      } catch (error) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: (error as Error).message } }));
      }
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("loopback did not allocate a TCP port");
    this.port = address.port;
  }

  env(): NodeJS.ProcessEnv {
    if (!this.port) throw new Error("loopback must be started before env() is read");
    return {
      OPENAI_API_KEY: "agape-production-conformance-no-secret",
      OPENAI_BASE_URL: `http://127.0.0.1:${this.port}/v1`,
    };
  }

  async close(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = undefined;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

export function messagesText(body: OpenAIRequest, role?: string): string {
  return (body.messages ?? [])
    .filter((message) => role === undefined || message.role === role)
    .map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content))
    .join("\n");
}

export function chatCompletion(args: {
  model?: string;
  content?: string;
  rawCandidates?: RawCandidate[];
  contentEvidence?: ContentTokenEvidence[];
  choices?: CompletionChoice[];
  responseId?: string;
  finishReason?: string;
}): Record<string, unknown> {
  const defaultEvidence = args.contentEvidence
    ?? (args.rawCandidates ? [{ ...(args.rawCandidates[0] as RawCandidate), top_logprobs: args.rawCandidates }] : undefined);
  const choices = args.choices ?? [{
    content: args.content ?? "",
    contentEvidence: defaultEvidence,
    finishReason: args.finishReason,
  }];
  return {
    id: args.responseId ?? "chatcmpl-agape-conformance",
    object: "chat.completion",
    created: 1_700_000_000,
    model: args.model ?? "agape-loopback-conformance",
    choices: choices.map((choice, index) => ({
      index,
      message: { role: "assistant", content: choice.content },
      logprobs: choice.contentEvidence ? { content: choice.contentEvidence } : null,
      finish_reason: choice.finishReason ?? "stop",
    })),
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

export function twoVariantCandidates(first: string, second: string, firstProbability = 0.9): RawCandidate[] {
  return [
    { token: first, logprob: Math.log(firstProbability), bytes: [...Buffer.from(first)] },
    { token: second, logprob: Math.log(1 - firstProbability), bytes: [...Buffer.from(second)] },
  ];
}
