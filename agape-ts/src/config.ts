// Configuration — binds the declared `provider` dependency to a concrete backend (SPEC.md §17).
//
// Source declares WHAT it depends on (a provider, reached through `self <- …`); the manifest binds
// it to a model API. Swapping the backend changes no Agape source. `exposes_logprobs` is DERIVED
// from the backend (anthropic=false, openai/gemini=true); a backend without logprobs is served by
// the sampling fallback (§16.8). Secrets come from the environment, never the manifest.

import { existsSync, readFileSync } from "node:fs";
import { MockProvider, type Provider, type StructuredSchema, type Variant } from "./runtime.js";
import { LocalMemoryDriver, type MemoryDriver } from "./memory.js";
import { MarkdownMemoryDriver } from "./memory_markdown.js";
import { MemoryRuntimeDriver } from "./memory_runtime.js";

export interface ProviderConfig {
  backend: "mock" | "anthropic" | "openai" | "gemini" | string;
  model?: string;
  temperature?: number;
  exposes_logprobs?: boolean; // derived from backend unless explicitly overridden
  sampling_fallback?: boolean; // default true
  fallback_samples?: number; // min 10
  fallback_temperature?: number;
}
export interface ProviderSecrets {
  openaiApiKey?: string;
  anthropicApiKey?: string;
  geminiApiKey?: string;
}
export interface ProviderFactoryOptions {
  secrets?: ProviderSecrets;
}
export type ManifestAtom = string | number | boolean;
export type ManifestValue = ManifestAtom | ManifestAtom[] | Record<string, ManifestAtom>;
export interface BindingConfig {
  driver?: string;
  [key: string]: ManifestValue | undefined;
}
export interface ToolBindingConfig extends BindingConfig {}
export interface MemoryConfig {
  driver?: "markdown" | "local" | "mock" | string;
  path?: string;
  root?: string;
  directory?: string;
  entrypoint?: string;
  top_k?: number;
  index_lines?: number;
  index_bytes?: number;
  archive_on_forget?: boolean;
  auto_memory?: boolean;
  classify?: boolean;
  dedupe?: boolean;
  dedupe_threshold?: number;
  recall_pool?: number;
  domain_terms?: string[];
  [key: string]: ManifestValue | undefined;
}
// §6b wiring — how a declared action/event touches the world. `tool` names a [tools.*] catalog
// entry; `result_event` names the declared event the effector's reply lands as.
export interface WiringConfig extends BindingConfig {
  tool?: string;
  result_event?: string;
}
export type TaintedIngressToProviderPolicy = "warn" | "deny" | "off";
export interface SecurityIngressConfig {
  prompts?: Record<string, BindingConfig>;
  events?: Record<string, BindingConfig>;
}
export interface SecurityConfig {
  tainted_ingress_to_provider?: TaintedIngressToProviderPolicy;
  ingress?: SecurityIngressConfig;
}
export interface Manifest {
  provider: ProviderConfig;
  project?: Record<string, ManifestValue>;
  // §17.1 dependency BINDINGS — the manifest binds each declared `principal`/`prompt` dependency
  // to a configured world capability. A declared dependency with no binding is a ConfigError
  // (checked statically, §17.1). Keyed by the dependency's simple name.
  identity?: Record<string, BindingConfig>;
  prompts?: Record<string, BindingConfig>;
  // §6b the world interface: [tools.*] is the ENDPOINT CATALOG (the only place "tool" exists);
  // [actions.NAME]/[events.NAME] wire declared actions/events to catalog entries.
  tools?: Record<string, ToolBindingConfig>;
  actions?: Record<string, WiringConfig>;
  events?: Record<string, WiringConfig>;
  memory?: MemoryConfig;
  runtime?: Record<string, ManifestValue>;
  security?: SecurityConfig;
  // §17.2 — decision policy lives in SOURCE, never the manifest; any `policy.*` key here is a ConfigError.
  policy?: Record<string, ManifestValue>;
}

export function loadManifest(path?: string, backendOverride?: string): Manifest {
  const resolved = path ?? (existsSync("agape.toml") ? "agape.toml" : undefined);
  const manifest = resolved ? readManifestToml(readFileSync(resolved, "utf8")) : { provider: { backend: "mock" } };
  const raw = manifest.provider;
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
  applyProviderDefaults(raw);
  applySecurityDefaults(manifest);
  return manifest;
}

function applyProviderDefaults(raw: ProviderConfig): void {
  if (typeof raw.backend !== "string" || !raw.backend) raw.backend = "mock";
  // derive exposes_logprobs from the backend unless the manifest set it explicitly
  if (raw.exposes_logprobs === undefined) {
    raw.exposes_logprobs = raw.backend === "openai" || raw.backend === "gemini";
  }
  raw.sampling_fallback ??= true;
  raw.fallback_samples = Math.max(10, raw.fallback_samples ?? 10);
  raw.fallback_temperature ??= 0.7;
}

// Parse the conformance harness `manifest:` directive — a `;`-separated list of dotted `table.key=value`
// bindings (e.g. `identity.alice.driver=local; tools.search.driver=mock;
// provider.exposes_logprobs=false`) — into a structured Manifest. The old fixture shorthand
// `tools.search=mock` is still accepted and normalized to `{ driver: "mock" }`. Provider values are parsed
// but NOT defaulted here: a §17 ConfigError check must be able to see that e.g. `fallback_temperature` was
// OMITTED, which the loadManifest defaulting would mask.
export function parseManifestDirective(s: string): Manifest {
  const manifest: Manifest = { provider: { backend: "mock" } };
  for (const entry of s.split(";").map((e) => e.trim()).filter(Boolean)) {
    const eq = entry.indexOf("=");
    if (eq < 0) continue;
    setManifestValue(manifest, [], entry.slice(0, eq).trim().split("."), parseTomlValue(entry.slice(eq + 1).trim()));
  }
  applySecurityDefaults(manifest);
  return manifest;
}

export function hasConfiguredBinding(bindings: Record<string, BindingConfig> | undefined, name: string): boolean {
  const binding = bindings?.[name];
  return typeof binding?.driver === "string" && binding.driver.trim().length > 0;
}

export function createProvider(m: Manifest, options: ProviderFactoryOptions = {}): Provider {
  const p = m.provider;
  const secrets = options.secrets ?? {};
  switch (p.backend) {
    case "mock": return new MockProvider();
    case "anthropic": return new AnthropicProvider(p, secrets);
    case "openai": return new OpenAIProvider(p, secrets);
    case "gemini": return new GeminiProvider(p, secrets);
    default: throw new Error(`unknown provider backend '${p.backend}' (manifest [provider] backend=…)`);
  }
}

export function createMemoryDriver(m: Manifest, deps: { cwd?: string; provider?: Provider } = {}): MemoryDriver {
  const cfg = m.memory ?? {};
  const driver = typeof cfg.driver === "string" ? cfg.driver : "markdown";
  let substrate: MemoryDriver;
  switch (driver) {
    case "markdown":
      substrate = new MarkdownMemoryDriver(cfg, deps);
      break;
    case "local":
    case "mock":
      substrate = new LocalMemoryDriver();
      break;
    default:
      throw new Error(`unknown memory driver '${driver}' (manifest [memory] driver=...)`);
  }
  // The provider handle enables [memory] reflect = true; without it the
  // memory runtime is purely lexical (judgment/classify/dedupe/rerank).
  return new MemoryRuntimeDriver(substrate, cfg, deps.provider);
}

// ---- a small TOML reader for the manifest subset the runtime needs ----
function readManifestToml(toml: string): Manifest {
  const manifest: Manifest = { provider: { backend: "mock" } };
  let tablePath: string[] = [];
  for (const line of toml.split(/\r?\n/)) {
    const s = stripTomlComment(line).trim();
    if (!s) continue;
    const table = s.match(/^\[([A-Za-z0-9_.-]+)\]$/);
    if (table) {
      tablePath = table[1]!.split(".");
      continue;
    }
    const m = s.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!m) continue;
    const [, key, valRaw] = m;
    setManifestValue(manifest, tablePath, key!.split("."), parseTomlValue(valRaw!.trim()));
  }
  applySecurityDefaults(manifest);
  return manifest;
}

function stripTomlComment(line: string): string {
  let quote: "'" | "\"" | undefined;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (quote === "\"" && c === "\\" && !escaped) { escaped = true; continue; }
      if (c === quote && !escaped) quote = undefined;
      escaped = false;
      continue;
    }
    if (c === "'" || c === "\"") { quote = c; continue; }
    if (c === "#") return line.slice(0, i);
  }
  return line;
}

function setManifestValue(manifest: Manifest, tablePath: string[], keyPath: string[], value: unknown): void {
  const table = tablePath[0] ?? keyPath[0] ?? "";
  const path = tablePath.length ? keyPath : keyPath.slice(1);
  const first = path[0];
  if (!first) return;
  if (table === "provider") {
    (manifest.provider as unknown as Record<string, unknown>)[first] = value;
    return;
  }
  if (table === "project" || table === "memory" || table === "runtime" || table === "policy") {
    const group = manifest[table] ?? (manifest[table] = {});
    group[first] = value as ManifestValue;
    return;
  }
  if (table === "security") {
    setSecurityManifestValue(manifest, tablePath, path, value);
    return;
  }
  if (table === "identity" || table === "prompts" || table === "tools" || table === "actions" || table === "events") {
    const group = manifest[table] ?? (manifest[table] = {});
    const name = tablePath.length > 1 ? tablePath[1]! : first;
    const rest = tablePath.length > 1 ? path : path.slice(1);
    if (rest.length === 0) {
      group[name] = bindingFromValue(value);
    } else {
      const binding = group[name] ?? (group[name] = {});
      binding[rest.join(".")] = value as ManifestValue;
    }
  }
}

function applySecurityDefaults(manifest: Manifest): void {
  manifest.security ??= {};
  manifest.security.tainted_ingress_to_provider ??= "warn";
}

function setSecurityManifestValue(manifest: Manifest, tablePath: string[], path: string[], value: unknown): void {
  const security = manifest.security ?? (manifest.security = {});
  if (path[0] === "tainted_ingress_to_provider") {
    security.tainted_ingress_to_provider = String(value) as TaintedIngressToProviderPolicy;
    return;
  }
  const full = tablePath.length ? [...tablePath.slice(1), ...path] : path;
  if (full[0] !== "ingress") return;
  const kind = full[1];
  if (kind !== "prompts" && kind !== "events") return;
  const name = full[2];
  if (!name) return;
  const rest = full.slice(3);
  const ingress = security.ingress ?? (security.ingress = {});
  const group = ingress[kind] ?? (ingress[kind] = {});
  if (rest.length === 0) {
    group[name] = bindingFromValue(value);
  } else {
    const binding = group[name] ?? (group[name] = {});
    binding[rest.join(".")] = value as ManifestValue;
  }
}

function bindingFromValue(value: unknown): BindingConfig {
  if (typeof value === "string") return { driver: value };
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return { ...(value as Record<string, ManifestValue>) };
  }
  return { driver: String(value ?? "") };
}

function parseTomlValue(v: string): unknown {
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v.startsWith("[") && v.endsWith("]")) {
    const inner = v.slice(1, -1).trim();
    return inner ? splitTopLevel(inner, ",").map((part) => parseTomlValue(part.trim())) : [];
  }
  if (v.startsWith("{") && v.endsWith("}")) {
    const out: Record<string, ManifestAtom> = {};
    const inner = v.slice(1, -1).trim();
    for (const part of inner ? splitTopLevel(inner, ",") : []) {
      const eq = part.indexOf("=");
      if (eq < 0) continue;
      const key = part.slice(0, eq).trim();
      const val = parseTomlValue(part.slice(eq + 1).trim());
      if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") out[key] = val;
    }
    return out;
  }
  if (v.startsWith("\"") && v.endsWith("\"")) {
    try { return JSON.parse(v); } catch { return v.slice(1, -1); }
  }
  if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1);
  return v;
}

function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let start = 0, depth = 0;
  let quote: "'" | "\"" | undefined;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (quote === "\"" && c === "\\" && !escaped) { escaped = true; continue; }
      if (c === quote && !escaped) quote = undefined;
      escaped = false;
      continue;
    }
    if (c === "'" || c === "\"") { quote = c; continue; }
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
    else if (c === sep && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
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

function parseJsonPayload(raw: string): unknown {
  let body = raw.trim();
  const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) body = fence[1]!.trim();
  const firstObj = body.indexOf("{");
  const firstArr = body.indexOf("[");
  const starts = [firstObj, firstArr].filter((n) => n >= 0);
  if (starts.length) {
    const start = Math.min(...starts);
    const close = body[start] === "{" ? body.lastIndexOf("}") : body.lastIndexOf("]");
    if (close > start) body = body.slice(start, close + 1);
  }
  return JSON.parse(body);
}

function safeSchemaName(name = "Reply"): string {
  return (name.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "Reply").slice(0, 64);
}

// ---- remote providers (real backends behind the same seam) ----
// `judge` implements the §16.8 split: read per-variant logprobs when the backend exposes them,
// else draw the forced choice `fallback_samples` times and use the empirical frequency.
// Cognition is asynchronous, so the whole seam is async (the interpreter awaits every judgment).
abstract class RemoteProvider implements Provider {
  constructor(protected cfg: ProviderConfig, protected secrets: ProviderSecrets = {}) {}

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
  async structured(prompt: string, schema: StructuredSchema, name?: string): Promise<unknown> {
    const raw = await this.reply(
      `${prompt}\n\nReturn only JSON conforming to this schema for ${safeSchemaName(name)}:\n${JSON.stringify(schema)}`,
    );
    return parseJsonPayload(raw);
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
    return (this.clientP ??= import("@anthropic-ai/sdk").then((m) => {
      const apiKey = this.secrets.anthropicApiKey;
      return new m.default(apiKey ? { apiKey } : undefined);
    }));
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

  // §16.4/§16.6: forces the reply through a tool whose input_schema IS the declared type, so the model can only
  // return schema-conforming JSON. A thrown error here is a CONNECTOR error (request rejected, network, refusal)
  // — the interpreter surfaces it as a crash naming the provider status/message, NOT a reply-schema TypeMismatch.
  override async structured(prompt: string, schema: StructuredSchema, name?: string): Promise<unknown> {
    const client = await this.client();
    const toolName = "return_structured_reply";
    const inputSchema: StructuredSchema = schema.type === "object"
      ? schema
      : { type: "object", properties: { value: schema }, required: ["value"], additionalProperties: false };
    const resp = await client.messages.create({
      model: this.model,
      max_tokens: 1024,
      tools: [{
        name: toolName,
        description: `Return the schema-conforming ${safeSchemaName(name)} object.`,
        input_schema: inputSchema,
      }],
      tool_choice: { type: "tool", name: toolName },
      messages: [{ role: "user", content: prompt }],
    });
    const tool = (resp.content as any[]).find((b) => b.type === "tool_use" && b.name === toolName);
    const input = tool?.input ?? parseJsonPayload(textOf(resp.content));
    return schema.type === "object" ? input : (input as { value?: unknown }).value;
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
    return (this.clientP ??= import("openai").then((m) => {
      const apiKey = this.secrets.openaiApiKey;
      return new m.default(apiKey ? { apiKey } : undefined);
    }));
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

  // §16.4/§16.6: OpenAI strict `json_schema` mode — constrained decoding guarantees a schema-conforming reply
  // (the generator emits strict-conformant schemas by construction: additionalProperties:false and every
  // property required on every object, recursively; §8). A non-object root is wrapped in `{ value }` because
  // strict mode requires an object root. A thrown error here is a CONNECTOR error (the request was rejected —
  // e.g. an HTTP 4xx — the network failed, or the model refused); the interpreter surfaces it as a crash naming
  // the provider status/message (deterministic rejections say re-asking cannot succeed), NOT a reply-schema
  // TypeMismatch, so a rejected REQUEST is never misdiagnosed as a schema-violating REPLY.
  override async structured(prompt: string, schema: StructuredSchema, name?: string): Promise<unknown> {
    const client = await this.client();
    const wrapped = schema.type === "object"
      ? { schema, unwrap: (value: unknown) => value }
      : {
          schema: {
            type: "object" as const,
            properties: { value: schema },
            required: ["value"],
            additionalProperties: false as const,
          },
          unwrap: (value: unknown) => (value as { value?: unknown }).value,
        };
    const resp = await client.chat.completions.create({
      model: this.model,
      messages: [
        { role: "system", content: "Return only the requested structured output." },
        { role: "user", content: prompt },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: safeSchemaName(name),
          strict: true,
          schema: wrapped.schema,
        },
      },
    } as any);
    return wrapped.unwrap(parseJsonPayload(resp.choices?.[0]?.message?.content ?? ""));
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
      return new mod.GoogleGenAI({ apiKey: this.secrets.geminiApiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY });
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

  // §16.4/§16.6: Gemini JSON mode with a response schema. A thrown error here is a CONNECTOR error (request
  // rejected, network, refusal) — the interpreter surfaces it as a crash naming the provider status/message,
  // NOT a reply-schema TypeMismatch.
  override async structured(prompt: string, schema: StructuredSchema): Promise<unknown> {
    const client = await this.client();
    const resp = await client.models.generateContent({
      model: this.model,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: schema,
      },
    } as any);
    return parseJsonPayload(resp.text ?? "");
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
