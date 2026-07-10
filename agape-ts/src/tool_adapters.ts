import type { Manifest, ManifestAtom, ManifestValue, ToolBindingConfig } from "./config.js";
import { render, type Value } from "./runtime.js";

export interface ToolCallContext {
  name: string;
  binding: ToolBindingConfig;
  args: Value[];
  payload: string;
}
export type ToolHandler = (call: ToolCallContext) => unknown | Promise<unknown>;

export function createToolHandlers(manifest?: Manifest): Record<string, ToolHandler> {
  const handlers: Record<string, ToolHandler> = {};
  for (const [name, binding] of Object.entries(manifest?.tools ?? {})) {
    const driver = normalizeDriver(binding.driver);
    if (driver === "mock" || driver === "host") continue;
    if (driver === "http" || driver === "https" || driver === "webhook") handlers[name] = httpToolHandler;
    else if (driver === "mcp") handlers[name] = mcpHttpToolHandler;
  }
  return handlers;
}

async function httpToolHandler(call: ToolCallContext): Promise<unknown> {
  const url = stringField(call.binding, "url") ?? stringField(call.binding, "endpoint");
  if (!url) throw new Error(`[tools.${call.name}] driver=http requires url or endpoint`);
  const method = (stringField(call.binding, "method") ?? "POST").toUpperCase();
  const init: RequestInit = { method, headers: requestHeaders(call.binding) };
  if (method !== "GET" && method !== "HEAD") {
    init.body = JSON.stringify({
      tool: call.name,
      args: call.args.map(valueToJson),
      rendered_args: call.args.map(render),
      payload: call.payload,
    });
  }
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`[tools.${call.name}] HTTP ${res.status}: ${text.slice(0, 500)}`);
  return unwrapToolResponse(parseMaybeJson(text, res.headers.get("content-type") ?? ""));
}

async function mcpHttpToolHandler(call: ToolCallContext): Promise<unknown> {
  const url = stringField(call.binding, "url") ?? stringField(call.binding, "endpoint");
  if (!url) throw new Error(`[tools.${call.name}] driver=mcp requires an MCP HTTP url/endpoint; stdio MCP servers should be supplied by host toolHandlers`);
  const toolName = stringField(call.binding, "tool") ?? stringField(call.binding, "name") ?? call.name;
  const body = {
    jsonrpc: "2.0",
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    method: "tools/call",
    params: {
      name: toolName,
      arguments: {
        args: call.args.map(valueToJson),
        rendered_args: call.args.map(render),
        payload: call.payload,
      },
    },
  };
  const res = await fetch(url, { method: "POST", headers: requestHeaders(call.binding), body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`[tools.${call.name}] MCP HTTP ${res.status}: ${text.slice(0, 500)}`);
  const parsed = parseMaybeJson(text, res.headers.get("content-type") ?? "");
  if (parsed && typeof parsed === "object" && "error" in parsed) throw new Error(`[tools.${call.name}] MCP error: ${JSON.stringify((parsed as any).error)}`);
  return unwrapMcpResult((parsed as any)?.result ?? parsed);
}

function requestHeaders(binding: ToolBindingConfig): Headers {
  const headers = new Headers({ "content-type": "application/json", accept: "application/json" });
  const configured = binding.headers;
  if (configured && typeof configured === "object" && !Array.isArray(configured)) {
    for (const [k, v] of Object.entries(configured as Record<string, ManifestAtom>)) headers.set(k, String(v));
  }
  const bearerEnv = stringField(binding, "bearer_env") ?? stringField(binding, "token_env");
  if (bearerEnv && process.env[bearerEnv]) headers.set("authorization", `Bearer ${process.env[bearerEnv]}`);
  return headers;
}

function parseMaybeJson(text: string, contentType: string): unknown {
  if (!text.trim()) return null;
  if (/json/i.test(contentType) || /^[\[{]/.test(text.trim())) {
    try { return JSON.parse(text); } catch { /* fall through */ }
  }
  return text;
}

function unwrapToolResponse(value: unknown): unknown {
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if ("result" in obj) return obj.result;
    if ("output" in obj) return obj.output;
    if ("text" in obj) return obj.text;
  }
  return value;
}

function unwrapMcpResult(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const obj = value as Record<string, unknown>;
  if (obj.structuredContent !== undefined) return obj.structuredContent;
  if (Array.isArray(obj.content)) {
    const texts = obj.content
      .map((part) => part && typeof part === "object" && (part as any).type === "text" ? String((part as any).text ?? "") : "")
      .filter(Boolean);
    if (texts.length) return texts.join("\n");
  }
  return obj.result ?? obj.output ?? obj;
}

function valueToJson(v: Value): unknown {
  switch (v.kind) {
    case "text": return v.v;
    case "int": case "float": return v.v;
    case "bool": return v.v;
    case "null": return null;
    case "enumval": return v.variant;
    case "struct": return Object.fromEntries([...v.fields].map(([k, val]) => [k, valueToJson(val)]));
    case "array": return v.items.map(valueToJson);
    default: return render(v);
  }
}

function normalizeDriver(driver: unknown): string {
  return typeof driver === "string" && driver.trim() ? driver.trim().toLowerCase() : "mock";
}

function stringField(binding: ToolBindingConfig, key: string): string | undefined {
  const value: ManifestValue | undefined = binding[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
