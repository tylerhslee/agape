import type { ToolBindingConfig, Manifest } from "./config.js";
import { render, type Value } from "./runtime.js";
import { configError } from "./errors.js";

// §6b: the adapter for a [tools.*] catalog entry. `name` is the catalog key; the binding lives in the
// manifest, not in Agape source.
export interface ToolCallContext {
  name: string;
  binding: ToolBindingConfig;
  args: Value[];
  payload: string;
}
export type ToolHandler = (call: ToolCallContext) => unknown | Promise<unknown>;

export function createToolHandlers(manifest: Manifest): Record<string, ToolHandler> {
  const out: Record<string, ToolHandler> = {};
  for (const [name, binding] of Object.entries(manifest.tools ?? {})) {
    const driver = binding.driver ?? "mock";
    if (driver === "mock") continue;
    if (driver === "http" || driver === "webhook") out[name] = httpToolHandler;
    else if (driver === "mcp-http" || driver === "mcp_http") out[name] = mcpHttpToolHandler;
    else if (driver === "mcp" || driver === "mcp-stdio" || driver === "stdio") {
      continue; // stdio MCP needs a host process manager; callers can still supply toolHandlers.
    }
  }
  return out;
}

async function httpToolHandler(call: ToolCallContext): Promise<unknown> {
  const url = bindingString(call.binding, "url") ?? bindingString(call.binding, "endpoint");
  if (!url) throw configError(`catalog entry [tools.${call.name}] uses driver '${call.binding.driver}', but no url/endpoint was configured`);
  const response = await fetch(url, {
    method: bindingString(call.binding, "method") ?? "POST",
    headers: headers(call.binding),
    body: JSON.stringify({
      tool: call.name,
      args: call.args.map(render),
      rendered_args: call.args.map(render),
      payload: call.payload,
    }),
  });
  return decodeResponse(call.name, response);
}

async function mcpHttpToolHandler(call: ToolCallContext): Promise<unknown> {
  const url = bindingString(call.binding, "url") ?? bindingString(call.binding, "endpoint");
  if (!url) throw configError(`catalog entry [tools.${call.name}] uses driver '${call.binding.driver}', but no url/endpoint was configured`);
  const toolName = bindingString(call.binding, "tool") ?? bindingString(call.binding, "name") ?? call.name;
  const response = await fetch(url, {
    method: "POST",
    headers: headers(call.binding),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: call.payload,
      method: "tools/call",
      params: {
        name: toolName,
        arguments: {
          args: call.args.map(render),
          rendered_args: call.args.map(render),
          payload: call.payload,
        },
      },
    }),
  });
  const decoded = await decodeResponse(call.name, response);
  if (decoded && typeof decoded === "object" && "result" in decoded) return (decoded as { result: unknown }).result;
  return decoded;
}

function headers(binding: ToolBindingConfig): Record<string, string> {
  const out: Record<string, string> = { "content-type": "application/json" };
  const rawHeaders = binding.headers;
  if (rawHeaders && typeof rawHeaders === "object" && !Array.isArray(rawHeaders)) {
    for (const [k, v] of Object.entries(rawHeaders)) out[k] = String(v);
  }
  const bearerEnv = bindingString(binding, "bearer_env") ?? bindingString(binding, "token_env");
  if (bearerEnv && process.env[bearerEnv]) out.authorization = `Bearer ${process.env[bearerEnv]}`;
  const bearer = bindingString(binding, "bearer") ?? bindingString(binding, "token");
  if (bearer) out.authorization = `Bearer ${bearer}`;
  return out;
}

async function decodeResponse(tool: string, response: Response): Promise<unknown> {
  const text = await response.text();
  if (!response.ok) throw configError(`tool '${tool}' returned HTTP ${response.status}: ${text.slice(0, 240)}`);
  if (!text.trim()) return null;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object") {
      if ("result" in parsed) return (parsed as { result: unknown }).result;
      if ("output" in parsed) return (parsed as { output: unknown }).output;
      if ("text" in parsed) return (parsed as { text: unknown }).text;
    }
    return parsed;
  }
  return text;
}

function bindingString(binding: ToolBindingConfig, key: string): string | undefined {
  const value = binding[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}