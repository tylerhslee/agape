import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type { RuntimeConformanceAdapter } from "./adapter.js";

export async function loadAdapter(): Promise<RuntimeConformanceAdapter | null> {
  const spec = process.env.AGAPE_RUNTIME_ADAPTER;
  if (!spec) return null;

  const moduleRef =
    spec.startsWith(".") || spec.startsWith("/")
      ? pathToFileURL(resolve(spec)).href
      : spec;
  const mod = await import(moduleRef);
  const candidate =
    mod.default ??
    mod.adapter ??
    (typeof mod.createAdapter === "function" ? await mod.createAdapter() : null);

  if (!candidate) {
    throw new Error("AGAPE_RUNTIME_ADAPTER did not export default, adapter, or createAdapter().");
  }
  return candidate as RuntimeConformanceAdapter;
}
