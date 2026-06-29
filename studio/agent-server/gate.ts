// The GATE seam — produces a `Credence` (§3): a calibrated distribution over a FIXED
// variant set. This is NOT the Cognition (orchestration) seam; it exists only to feed the
// decision gate (`endorse` / `decide`, §13/§20). Two calibration paths (§3, §16.8):
//
//   • token logprobs  — the provider exposes per-token probability mass on the forced
//                       categorical choice (OpenAI, Gemini). Read it directly → `Credence`.
//   • sampling fallback — a provider with no logprobs (Anthropic) is drawn N times at
//                       temperature; the empirical frequency is the estimate (§16.8).
//
// `exposesLogprobs` is a CAPABILITY of the backend, not a knob (the manifest selects the
// backend; the path follows). See design/v1.0.0-changelog.md §12.

import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";

export interface Grader {
  readonly model: string;
  readonly exposesLogprobs: boolean;
  /** A distribution over `variants` — probabilities that sum to ~1. */
  judge(prompt: string, variants: string[], opts?: JudgeOpts): Promise<Array<[string, number]>>;
}

export interface JudgeOpts {
  samples?: number; // sampling fallback only
  temperature?: number; // sampling fallback only
}

export interface OpenAIGraderOpts {
  topLogprobs?: number;
}

// ── OpenAI — token logprobs (Chat Completions; configurable top_logprobs) ─────
export class OpenAIGrader implements Grader {
  readonly exposesLogprobs = true;
  readonly model: string;
  private client: OpenAI;
  private topLogprobs: number;
  constructor(model = process.env.OPENAI_JUDGE_MODEL || "gpt-4o-mini", opts: OpenAIGraderOpts = {}) {
    this.model = model;
    this.topLogprobs = clampTopLogprobs(opts.topLogprobs ?? (Number(process.env.OPENAI_TOP_LOGPROBS) || 5));
    this.client = new OpenAI(); // reads OPENAI_API_KEY
  }

  async judge(prompt: string, variants: string[]): Promise<Array<[string, number]>> {
    // Force a single-token answer so the decision token sits at position 0, where its
    // mass is readable from `top_logprobs`. (A reasoning model would reject logprobs — use
    // a standard model like gpt-4o-mini.)
    const system =
      `Answer with EXACTLY ONE word — one of: ${variants.join(", ")}. ` +
      `Output only that single word, lowercase, no punctuation or explanation.`;
    const res = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: 1,
      temperature: 0,
      logprobs: true,
      top_logprobs: Math.min(20, Math.max(this.topLogprobs, variants.length)),
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    });
    const top = res.choices[0]?.logprobs?.content?.[0]?.top_logprobs ?? [];
    return massFromTopLogprobs(
      top.map((t) => ({ token: t.token, logprob: t.logprob })),
      variants,
    );
  }
}

// ── Anthropic — no logprobs → sampling fallback (§16.8) ───────────────────────
export class AnthropicGrader implements Grader {
  readonly exposesLogprobs = false;
  readonly model: string;
  private client: Anthropic;
  constructor(model = process.env.ANTHROPIC_JUDGE_MODEL || "claude-haiku-4-5") {
    this.model = model;
    this.client = new Anthropic();
  }

  async judge(prompt: string, variants: string[], opts?: JudgeOpts): Promise<Array<[string, number]>> {
    const samples = Math.max(1, Math.min(50, opts?.samples ?? 5));
    // temperature is rejected on Opus 4.7/4.8 & Fable 5; Haiku/Sonnet still accept it.
    const temperature = opts?.temperature;
    const system =
      `You are a careful judge. Respond with EXACTLY ONE word — one of: ${variants.join(", ")}. ` +
      `No explanation, no punctuation.`;
    const draws = await Promise.all(
      Array.from({ length: samples }, () =>
        this.client.messages
          .create({
            model: this.model,
            max_tokens: 8,
            system,
            messages: [{ role: "user", content: prompt }],
            ...(temperature === undefined ? {} : { temperature }),
          })
          .then((r) => pickVariant(anthropicText(r), variants))
          .catch(() => null),
      ),
    );
    const counts: Record<string, number> = {};
    for (const v of variants) counts[v] = 0;
    let valid = 0;
    for (const d of draws) if (d) { counts[d]++; valid++; }
    const denom = valid || 1;
    return variants.map((v) => [v, counts[v] / denom]);
  }
}

// ── Google Gemini — token logprobs via enum mode (logprobs ≤ 20) ──────────────
export class GeminiGrader implements Grader {
  readonly exposesLogprobs = true;
  readonly model: string;
  private ai: GoogleGenAI;
  constructor(model = process.env.GEMINI_JUDGE_MODEL || "gemini-2.5-flash") {
    this.model = model;
    this.ai = new GoogleGenAI({}); // reads GEMINI_API_KEY
  }

  async judge(prompt: string, variants: string[]): Promise<Array<[string, number]>> {
    // Enum mode (`text/x.enum`) constrains the answer to exactly one variant AND coexists
    // with logprobs — the cleanest "pick-one + read mass" path of the three backends. The
    // top-N alternatives at position 0 give the mass; nesting differs from OpenAI
    // (`logprobsResult.topCandidates[].candidates[]`, field `logProbability`).
    const res: any = await this.ai.models.generateContent({
      model: this.model,
      contents: prompt,
      config: {
        responseMimeType: "text/x.enum",
        responseSchema: { type: "STRING", enum: variants } as any,
        responseLogprobs: true,
        logprobs: Math.min(20, Math.max(variants.length, 5)),
        temperature: 0,
      },
    });
    const top = res?.candidates?.[0]?.logprobsResult?.topCandidates?.[0]?.candidates ?? [];
    return massFromTopLogprobs(
      top
        .filter((c: any) => c && typeof c.logProbability === "number")
        .map((c: any) => ({ token: String(c.token ?? ""), logprob: c.logProbability as number })),
      variants,
    );
  }
}

// ── backend selection: config picks the backend; the path follows the capability ──
export function makeGrader(provider = process.env.AGENT_JUDGE_PROVIDER, opts: { openaiTopLogprobs?: number } = {}): Grader {
  switch ((provider || "anthropic").toLowerCase()) {
    case "openai":
      return new OpenAIGrader(undefined, { topLogprobs: opts.openaiTopLogprobs });
    case "gemini":
      return new GeminiGrader();
    default:
      return new AnthropicGrader();
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

// Turn position-0 top-logprobs into mass over the variant set, renormalized.
// A variant matches a token if the token equals it, or is its distinct leading token
// (so multi-token labels like "contradicts" still register via their first token).
export function massFromTopLogprobs(
  entries: Array<{ token: string; logprob: number }>,
  variants: string[],
): Array<[string, number]> {
  const mass: Record<string, number> = {};
  for (const v of variants) mass[v] = 0;
  for (const e of entries) {
    const tok = e.token.trim().toLowerCase();
    if (!tok) continue;
    for (const v of variants) {
      const vl = v.toLowerCase();
      if (tok === vl || vl.startsWith(tok)) {
        mass[v] += Math.exp(e.logprob);
        break; // one token contributes to one variant
      }
    }
  }
  let sum = 0;
  for (const v of variants) sum += mass[v];
  if (sum <= 0) return variants.map((v) => [v, 1 / variants.length]); // no signal → uniform
  return variants.map((v) => [v, mass[v] / sum]);
}

export function pickVariant(text: string, variants: string[]): string | null {
  const t = text.toLowerCase().trim();
  for (const v of variants) if (t === v.toLowerCase()) return v;
  for (const v of variants) if (t.includes(v.toLowerCase())) return v;
  return null;
}

function anthropicText(res: Anthropic.Message): string {
  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join(" ")
    .trim();
}

function clampTopLogprobs(n: number): number {
  return Math.max(1, Math.min(20, Math.floor(Number.isFinite(n) ? n : 5)));
}
