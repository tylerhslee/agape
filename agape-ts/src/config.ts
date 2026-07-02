// Configuration — binds the declared `provider` dependency to a concrete backend (SPEC.md §17).
//
// Source declares WHAT it depends on (a provider, reached through `self <- …`); the manifest binds
// it to a model API. Swapping the backend changes no Agape source. `exposes_logprobs` is DERIVED
// from the backend (anthropic=false, openai/gemini=true); a backend without logprobs is served by
// the sampling fallback (§16.8). Secrets come from the environment, never the manifest.

import { existsSync, readFileSync } from "node:fs";
import { MockProvider, type Provider, type Variant } from "./runtime.js";

export interface ProviderConfig {
  backend: "mock" | "anthropic" | "openai" | "gemini" | string;
  model?: string;
  temperature?: number;
  exposes_logprobs?: boolean; // derived from backend unless explicitly overridden
  sampling_fallback?: boolean; // default true
  fallback_samples?: number; // min 10
  fallback_temperature?: number;
}
export interface Manifest {
  provider: ProviderConfig;
  // §17.1 dependency BINDINGS — the manifest binds each declared `principal`/`prompt`/`tool` dependency
  // to a configured world capability (identity for a principal, a prompt source, a tool implementation).
  // A declared dependency with no binding is a ConfigError (checked statically, §17.1). Keyed by the
  // dependency's simple name (`identity.alice=local` → identity.alice).
  identity?: Record<string, string>;
  prompts?: Record<string, string>;
  tools?: Record<string, string>;
  // §17.2 — decision policy lives in SOURCE, never the manifest; any `policy.*` key here is a ConfigError.
  policy?: Record<string, string>;
}

export function loadManifest(path?: string, backendOverride?: string): Manifest {
  const resolved = path ?? (existsSync("agape.toml") ? "agape.toml" : undefined);
  const raw: ProviderConfig = resolved ? readProviderTable(readFileSync(resolved, "utf8")) : { backend: "mock" };
  const fileBackend = raw.backend;
  if (backendOverride) {
    raw.backend = backendOverride;
    // the manifest's `model`/`exposes_logprobs` were written for the file's backend; switching the
    // backend on the command line drops them so the new backend's defaults / derivation take over.
    if (backendOverride !== fileBackend) {
      raw.model = undefined;
      raw.exposes_logprobs = undefined;
    }
  }
  // derive exposes_logprobs from the backend unless the manifest set it explicitly
  if (raw.exposes_logprobs === undefined) {
    raw.exposes_logprobs = raw.backend === "openai" || raw.backend === "gemini";
  }
  raw.sampling_fallback ??= true;
  raw.fallback_samples = Math.max(10, raw.fallback_samples ?? 10);
  raw.fallback_temperature ??= 0.7;
  return { provider: raw };
}

// Parse the conformance harness `manifest:` directive — a `;`-separated list of dotted `table.key=value`
// bindings (e.g. `identity.alice=local; prompts.question=stdin; provider.exposes_logprobs=false`) — into a
// structured Manifest. Provider values are parsed but NOT defaulted here: a §17 ConfigError check must be
// able to see that e.g. `fallback_temperature` was OMITTED, which the loadManifest defaulting would mask.
export function parseManifestDirective(s: string): Manifest {
  const provider: Record<string, unknown> = { backend: "mock" };
  const identity: Record<string, string> = {}, prompts: Record<string, string> = {};
  const tools: Record<string, string> = {}, policy: Record<string, string> = {};
  for (const entry of s.split(";").map((e) => e.trim()).filter(Boolean)) {
    const eq = entry.indexOf("=");
    if (eq < 0) continue;
    const key = entry.slice(0, eq).trim();
    const val = entry.slice(eq + 1).trim();
    const dot = key.indexOf(".");
    const table = dot < 0 ? "" : key.slice(0, dot);
    const rest = dot < 0 ? key : key.slice(dot + 1);
    switch (table) {
      case "identity": identity[rest] = val; break;
      case "prompts": prompts[rest] = val; break;
      case "tools": tools[rest] = val; break;
      case "policy": policy[rest] = val; break;
      case "provider": provider[rest] = parseTomlValue(val); break;
      default: break;
    }
  }
  return { provider: provider as unknown as ProviderConfig, identity, prompts, tools, policy };
}

export function createProvider(m: Manifest): Provider {
  const p = m.provider;
  switch (p.backend) {
    case "mock": return new MockProvider();
    case "anthropic": return new AnthropicProvider(p);
    case "openai": return new OpenAIProvider(p);
    case "gemini": return new GeminiProvider(p);
    default: throw new Error(`unknown provider backend '${p.backend}' (manifest [provider] backend=…)`);
  }
}

// ---- a minimal `[provider]` TOML reader (the manifest subset the runtime needs) ----
function readProviderTable(toml: string): ProviderConfig {
  const cfg: Record<string, unknown> = {};
  let inProvider = false;
  for (const line of toml.split(/\r?\n/)) {
    const s = line.replace(/#.*$/, "").trim();
    if (!s) continue;
    if (s.startsWith("[")) { inProvider = s === "[provider]"; continue; }
    if (!inProvider) continue;
    const m = s.match(/^([A-Za-z_]+)\s*=\s*(.+)$/);
    if (!m) continue;
    const [, key, valRaw] = m;
    cfg[key!] = parseTomlValue(valRaw!.trim());
  }
  if (typeof cfg.backend !== "string") cfg.backend = "mock";
  return cfg as unknown as ProviderConfig;
}
function parseTomlValue(v: string): unknown {
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v.replace(/^["']|["']$/g, "");
}

// match a model's free-text answer back onto one of the enum's variants (case-insensitive).
// returns "" (a non-vote) when nothing matches — the empirical frequency then reads as lower
// confidence, which is the honest reading of an ambiguous generation.
function matchVariant(text: string, variants: Variant[]): Variant {
  const t = text.trim().toLowerCase();
  for (const v of variants) if (v.toLowerCase() === t) return v;
  for (const v of variants) if (t.startsWith(v.toLowerCase())) return v;
  for (const v of variants) if (t.includes(v.toLowerCase())) return v;
  return "";
}

function freqOf(choices: Variant[], variants: Variant[]): Record<Variant, number> {
  const counts: Record<Variant, number> = {};
  for (const v of variants) counts[v] = 0;
  for (const c of choices) if (c in counts) counts[c] = (counts[c] ?? 0) + 1;
  const n = choices.length || 1;
  const scores: Record<Variant, number> = {};
  for (const v of variants) scores[v] = (counts[v] ?? 0) / n;
  return scores;
}

// ---- remote providers (real backends behind the same seam) ----
// `judge` implements the §16.8 split: read per-variant logprobs when the backend exposes them,
// else draw the forced choice `fallback_samples` times and use the empirical frequency.
// Cognition is asynchronous, so the whole seam is async (the interpreter awaits every judgment).
abstract class RemoteProvider implements Provider {
  constructor(protected cfg: ProviderConfig) {}

  async judge(prompt: string, enumName: string, variants: Variant[]): Promise<{ scores: Record<Variant, number> }> {
    if (this.cfg.exposes_logprobs) {
      const lp = await this.scoreLogprobs(prompt, enumName, variants);
      if (lp) return { scores: lp };
    }
    if (this.cfg.sampling_fallback === false) {
      // no distribution available and fallback disabled → a degenerate distribution (the gate will
      // typically abstain), matching §20.3's "conformal degrades to deferral".
      const flat: Record<Variant, number> = {};
      for (const v of variants) flat[v] = 1 / variants.length;
      return { scores: flat };
    }
    return { scores: await this.samplingFallback(prompt, enumName, variants) };
  }

  protected async samplingFallback(prompt: string, enumName: string, variants: Variant[]): Promise<Record<Variant, number>> {
    const n = Math.max(10, this.cfg.fallback_samples ?? 10);
    const temp = this.cfg.fallback_temperature ?? 0.7;
    // draw the forced choice n times (concurrently) and take the empirical frequency (§16.8).
    const choices = await Promise.all(
      Array.from({ length: n }, () => this.pickOnce(prompt, enumName, variants, temp)),
    );
    return freqOf(choices, variants);
  }

  // one forced categorical choice over the enum's variants (constrained decoding / structured output).
  protected abstract pickOnce(prompt: string, enumName: string, variants: Variant[], temperature: number): Promise<Variant>;
  // optional per-variant logprob scores (logprob backends only); undefined → fall to the sampling fallback.
  protected async scoreLogprobs(_p: string, _e: string, _v: Variant[]): Promise<Record<Variant, number> | undefined> {
    return undefined;
  }
  abstract reply(prompt: string): Promise<string>;
}

// ---- Anthropic: no token logprobs → always the sampling fallback (§17.1). ----
// Defaults to claude-haiku-4-5: cheap, and (unlike Opus 4.8 / 4.7 / Fable 5) it still accepts
// `temperature`, which the sampling fallback needs to get variance across its n draws.
class AnthropicProvider extends RemoteProvider {
  private readonly model = this.cfg.model || "claude-haiku-4-5";
  private clientP?: Promise<any>;
  private client(): Promise<any> {
    return (this.clientP ??= import("@anthropic-ai/sdk").then((m) => new m.default()));
  }

  protected async pickOnce(prompt: string, enumName: string, variants: Variant[], temperature: number): Promise<Variant> {
    const client = await this.client();
    const resp = await client.messages.create({
      model: this.model,
      max_tokens: 8,
      temperature,
      system:
        `You are a strict classifier. Reply with EXACTLY one of these ${enumName} labels and nothing else: ` +
        variants.join(", ") + ".",
      messages: [{ role: "user", content: prompt }],
    });
    return matchVariant(textOf(resp.content), variants);
  }

  async reply(prompt: string): Promise<string> {
    const client = await this.client();
    const resp = await client.messages.create({
      model: this.model,
      max_tokens: 256,
      messages: [{ role: "user", content: prompt }],
    });
    return textOf(resp.content);
  }
}

// ---- OpenAI: token top_logprobs → graded per-variant scores directly (§16.8 logprob path). ----
class OpenAIProvider extends RemoteProvider {
  private readonly model = this.cfg.model || "gpt-4o-mini";
  private clientP?: Promise<any>;
  private client(): Promise<any> {
    return (this.clientP ??= import("openai").then((m) => new m.default()));
  }

  // read the first-token distribution and fold its mass onto the enum's variants.
  protected override async scoreLogprobs(prompt: string, enumName: string, variants: Variant[]): Promise<Record<Variant, number> | undefined> {
    const client = await this.client();
    const resp = await client.chat.completions.create({
      model: this.model,
      max_tokens: 1,
      temperature: 0,
      logprobs: true,
      top_logprobs: 20,
      messages: [
        { role: "system", content: `Classify into exactly one ${enumName} label: ${variants.join(", ")}. Reply with only the single label word.` },
        { role: "user", content: prompt },
      ],
    });
    const top = resp.choices?.[0]?.logprobs?.content?.[0]?.top_logprobs as { token: string; logprob: number }[] | undefined;
    if (!top || top.length === 0) return undefined; // no logprobs → caller falls to sampling fallback
    const mass: Record<Variant, number> = {};
    for (const v of variants) mass[v] = 0;
    for (const cand of top) {
      const tok = cand.token.trim().toLowerCase();
      if (!tok) continue;
      const p = Math.exp(cand.logprob);
      for (const v of variants) {
        const lv = v.toLowerCase();
        if (lv.startsWith(tok) || tok.startsWith(lv)) { mass[v] = (mass[v] ?? 0) + p; break; }
      }
    }
    const sum = variants.reduce((a, v) => a + (mass[v] ?? 0), 0);
    if (sum <= 0) return undefined; // nothing landed on a variant → sampling fallback
    const scores: Record<Variant, number> = {};
    for (const v of variants) scores[v] = (mass[v] ?? 0) / sum;
    return scores;
  }

  protected async pickOnce(prompt: string, enumName: string, variants: Variant[], temperature: number): Promise<Variant> {
    const client = await this.client();
    const resp = await client.chat.completions.create({
      model: this.model,
      max_tokens: 4,
      temperature,
      messages: [
        { role: "system", content: `Reply with exactly one ${enumName} label and nothing else: ${variants.join(", ")}.` },
        { role: "user", content: prompt },
      ],
    });
    return matchVariant(resp.choices?.[0]?.message?.content ?? "", variants);
  }

  async reply(prompt: string): Promise<string> {
    const client = await this.client();
    const resp = await client.chat.completions.create({
      model: this.model,
      max_tokens: 256,
      messages: [{ role: "user", content: prompt }],
    });
    return resp.choices?.[0]?.message?.content ?? "";
  }
}

// ---- Gemini: enum-mode responseLogprobs (logprob backend). Wired through @google/genai if present. ----
// scoreLogprobs returns undefined here, so judge serves graded scores via the sampling fallback; the
// responseLogprobs path is a future refinement. The point per §17 is that the backend is CONFIGURABLE.
class GeminiProvider extends RemoteProvider {
  private readonly model = this.cfg.model || "gemini-1.5-flash";
  private clientP?: Promise<any>;
  private client(): Promise<any> {
    return (this.clientP ??= (async () => {
      let mod: any;
      try {
        mod = await import("@google/genai");
      } catch {
        throw new Error("gemini backend selected but @google/genai is not installed (npm i @google/genai)");
      }
      return new mod.GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY });
    })());
  }

  protected async pickOnce(prompt: string, _enumName: string, variants: Variant[], temperature: number): Promise<Variant> {
    const client = await this.client();
    const resp = await client.models.generateContent({
      model: this.model,
      contents: `Reply with exactly one label and nothing else (${variants.join(", ")}): ${prompt}`,
      config: { temperature, maxOutputTokens: 8 },
    });
    return matchVariant(resp.text ?? "", variants);
  }

  async reply(prompt: string): Promise<string> {
    const client = await this.client();
    const resp = await client.models.generateContent({ model: this.model, contents: prompt });
    return resp.text ?? "";
  }
}

// Anthropic Messages content is a block list; concatenate the text blocks.
function textOf(content: { type: string; text?: string }[]): string {
  return content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
}
