// Pure, side-effect-free helpers shared by the agent-server — split out of
// server.ts so they can be unit-tested without starting the HTTP server.

import path from "node:path";

// Which declared variant a model's forced-choice answer picked (or null). Used by
// the sampling fallback (/provider/judge).
export function pickVariant(text: string, variants: string[]): string | null {
  const t = text.toLowerCase().trim();
  for (const v of variants) if (t === v.toLowerCase()) return v;
  for (const v of variants) if (t.includes(v.toLowerCase())) return v;
  return null;
}

// A shallow parse of an .ag source: the agents and the `prompt` sensors it
// declares — enough for the studio's agent inventory.
export function agentsAndPrompts(src: string): { agents: string[]; prompts: string[] } {
  const agents = [...src.matchAll(/^\s*agent\s+([A-Za-z_]\w*)/gm)].map((m) => m[1]);
  const prompts = [...src.matchAll(/^\s*prompt\s+\S+\s+([A-Za-z_]\w*)\s*;/gm)].map((m) => m[1]);
  return { agents, prompts };
}

// Resolve a project-relative path under `root`, refusing anything that escapes the
// root or isn't an .ag file. SECURITY-CRITICAL: the result is handed to the agape
// binary, so a traversal here would run arbitrary files.
export function safeProjectPath(root: string, rel: string): string | null {
  const full = path.resolve(root, rel);
  const base = path.resolve(root);
  // Compare against `base + sep` so a sibling dir sharing a prefix can't slip past.
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  if (!full.endsWith(".ag")) return null;
  return full;
}
