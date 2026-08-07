// Markdown filesystem implementation of the generic Agape MemoryDriver.
//
// This is intentionally a substrate adapter, not a second memory semantics.
// Agape still owns per-agent isolation, taint, ledger receipts, and authority;
// this file only persists scoped memory cells as user-editable markdown.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  memoryCandidate,
  type MemoryConsultRequest,
  type MemoryConsultResult,
  type MemoryDriver,
  type MemoryForgetRequest,
  type MemoryReceipt,
  type MemoryScope,
  type MemoryStoredCell,
  type MemoryWriteRequest,
} from "./memory.js";
export interface MarkdownMemoryConfig {
  driver?: string;
  path?: string;
  root?: string;
  directory?: string;
  entrypoint?: string;
  top_k?: number;
  index_lines?: number;
  index_bytes?: number;
  archive_on_forget?: boolean;
  [key: string]: unknown;
}

interface MarkdownLocation {
  root: string;
  entrypoint: string;
  topic: string;
  topicRel: string;
}

interface MarkdownChunk {
  id: string;
  memory: string;
  score: number;
  order: number;
  metadata: Record<string, unknown>;
  typed?: Record<string, unknown>;
}

const INDEX_START = "<!-- agape:markdown-memory-index:start -->";
const INDEX_END = "<!-- agape:markdown-memory-index:end -->";
const DEFAULT_ENTRYPOINT = "MEMORY.md";
const DEFAULT_ROOT = ".agape/memory";

export class MarkdownMemoryDriver implements MemoryDriver {
  readonly capabilities = { retentions: ["session", "durable"] as const };
  constructor(
    private readonly cfg: MarkdownMemoryConfig = {},
    private readonly deps: { cwd?: string; now?: () => Date } = {},
  ) {}

  async declare(scope: MemoryScope): Promise<void> {
    const loc = this.location(scope);
    await mkdir(dirname(loc.topic), { recursive: true });
    await ensureFile(loc.entrypoint, defaultIndexMarkdown());
    await ensureFile(loc.topic, defaultTopicMarkdown(scope));
  }

  async internalize(req: MemoryWriteRequest): Promise<MemoryReceipt> {
    const loc = this.location(req.scope);
    await this.declare(req.scope);
    const id = this.memoryId(req.scope, req.memory);
    const createdAt = this.now().toISOString();
    const entry = renderEntry({ id, createdAt, req });
    const existing = await readText(loc.topic);
    await writeFile(loc.topic, appendMarkdown(existing, entry), "utf8");
    await this.updateIndex(req.scope, loc, req.memory);
    return {
      status: "APPENDED",
      ids: [id],
      refs: {
        markdown_file: loc.topicRel,
        markdown_index: this.entrypointName(),
      },
      effects: writeEffects(),
      policy: this.policy(),
    };
  }

  async consult(req: MemoryConsultRequest): Promise<MemoryConsultResult> {
    const loc = this.location(req.scope);
    await this.declare(req.scope);
    const chunks = await this.loadChunks(req.scope, loc, req.query);
    const topK = clampInt(req.topK ?? this.cfg.top_k, 1, 1000, 10);
    const hits: MemoryStoredCell[] = chunks
      .sort((a, b) => b.score - a.score || b.order - a.order)
      .slice(0, topK)
      .filter((c) => c.memory.length > 0)
      .map((c) => ({
        id: c.id,
        memory: c.memory,
        score: c.score,
        metadata: c.metadata,
        typed: c.typed,
      }));
    return {
      hits,
      recalled: hits.map((h) => h.memory).join("\n\n"),
      candidates: hits.map(memoryCandidate),
    };
  }

  async forget(req: MemoryForgetRequest): Promise<MemoryReceipt> {
    const loc = this.location(req.scope);
    await this.declare(req.scope);
    const existing = await readText(loc.topic);
    const chunks = splitMarkdownChunks(existing, loc.topicRel, 0);
    const count = chunks.length;
    const archive = boolOr(this.cfg.archive_on_forget, true);
    let archiveRel: string | undefined;
    if (archive && existing.trim()) {
      const archiveFile = join(
        loc.root,
        ".archive",
        `${scopeSlug(req.scope)}-${this.now().toISOString().replace(/[:.]/g, "-")}.md`,
      );
      await mkdir(dirname(archiveFile), { recursive: true });
      await writeFile(archiveFile, existing, "utf8");
      archiveRel = toMarkdownPath(relative(loc.root, archiveFile));
    }
    await writeFile(loc.topic, forgottenTopicMarkdown(req.scope, count, this.now()), "utf8");
    await this.updateIndex(req.scope, loc, undefined);
    return {
      status: "TOMBSTONED",
      refs: {
        markdown_file: loc.topicRel,
        markdown_index: this.entrypointName(),
        ...(archiveRel ? { markdown_archive: archiveRel } : {}),
      },
      effects: forgetEffects(count, archive),
      policy: this.policy(),
    };
  }

  private async loadChunks(scope: MemoryScope, loc: MarkdownLocation, query: string): Promise<MarkdownChunk[]> {
    const chunks: MarkdownChunk[] = [];
    chunks.push(...splitMarkdownChunks(await readText(loc.topic), loc.topicRel, chunks.length));
    const terms = queryTerms(query);
    return chunks
      .filter((c) => !isForgottenChunk(c.memory))
      .map((c) => ({
        ...c,
        score: scoreText(c.memory, terms, query),
        metadata: {
          ...c.metadata,
          project: scope.project,
          agent: scope.agentAlias,
          user: scope.user,
          mem: scope.mem,
        },
      }));
  }

  private async updateIndex(scope: MemoryScope, loc: MarkdownLocation, latest: string | undefined): Promise<void> {
    const existing = await readText(loc.entrypoint);
    const label = scopeLabel(scope);
    const bullet = latest === undefined ? undefined : `- [${label}](${loc.topicRel}): ${oneLine(latest)}`;
    const lines = existing ? existing.split(/\r?\n/) : defaultIndexMarkdown().split(/\r?\n/);
    const start = lines.indexOf(INDEX_START);
    const end = lines.indexOf(INDEX_END);
    let before: string[];
    let block: string[];
    let after: string[];
    if (start >= 0 && end > start) {
      before = lines.slice(0, start + 1);
      block = lines.slice(start + 1, end);
      after = lines.slice(end);
    } else {
      before = [...trimTrailingEmpty(lines), "", "## Scopes", INDEX_START];
      block = [];
      after = [INDEX_END, ""];
    }
    const prefix = `- [${label}](`;
    const nextBlock = [...block.filter((line) => !line.startsWith(prefix)), ...(bullet ? [bullet] : [])].sort();
    await writeFile(loc.entrypoint, [...before, ...nextBlock, ...after].join("\n"), "utf8");
  }

  private location(scope: MemoryScope): MarkdownLocation {
    const root = resolveConfiguredPath(
      stringOr(this.cfg.path ?? this.cfg.root ?? this.cfg.directory, DEFAULT_ROOT),
      scope,
      this.cwd(),
    );
    const entrypointName = sanitizeFileName(stringOr(this.cfg.entrypoint, DEFAULT_ENTRYPOINT));
    const topic = join(
      root,
      "scopes",
      sanitizeSegment(scope.project ?? "default"),
      sanitizeSegment(scope.agentInstanceId),
      ...(scope.user ? [sanitizeSegment(scope.user)] : []),
      `${sanitizeSegment(scope.mem)}.md`,
    );
    return {
      root,
      entrypoint: join(root, entrypointName),
      topic,
      topicRel: toMarkdownPath(relative(root, topic)),
    };
  }

  private memoryId(scope: MemoryScope, memory: string): string {
    const hash = createHash("sha256")
      .update(memoryScopeIdentity(scope))
      .update("\0")
      .update(memory)
      .update("\0")
      .update(this.now().toISOString())
      .digest("hex")
      .slice(0, 16);
    return `md:${hash}`;
  }

  private policy(): Record<string, unknown> {
    return {
      driver: "markdown",
      format: "markdown",
      entrypoint: this.entrypointName(),
      index_limit: { lines: this.indexLines(), bytes: this.indexBytes() },
    };
  }

  private cwd(): string {
    return this.deps.cwd ?? process.cwd();
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private entrypointName(): string {
    return sanitizeFileName(stringOr(this.cfg.entrypoint, DEFAULT_ENTRYPOINT));
  }

  private indexLines(): number {
    return clampInt(this.cfg.index_lines, 1, 10_000, 200);
  }

  private indexBytes(): number {
    return clampInt(this.cfg.index_bytes, 1024, 10_000_000, 25 * 1024);
  }
}

function renderEntry(args: { id: string; createdAt: string; req: MemoryWriteRequest }): string {
  const { id, createdAt, req } = args;
  const metadata = {
    id,
    created_at: createdAt,
    project: req.scope.project,
    agent: req.scope.agentAlias,
    user: req.scope.user,
    mem: req.scope.mem,
    ...(req.metadata ?? {}),
  };
  return [
    `## ${createdAt}`,
    "",
    `<!-- agape-memory-id: ${id} -->`,
    "",
    req.memory.trim(),
    "",
    "```json",
    JSON.stringify({ metadata, summary: req.summary }, null, 2),
    "```",
    "",
  ].join("\n");
}

function splitMarkdownChunks(markdown: string, file: string, startOrder: number): MarkdownChunk[] {
  const sections = splitSections(markdown);
  const out: MarkdownChunk[] = [];
  for (const section of sections) {
    const id = extractMemoryId(section);
    const entryData = extractEntryData(section);
    const memory = stripJsonFences(stripHtmlComments(section)).trim();
    const body = stripFirstHeading(memory).trim();
    if (!body) continue;
    if (isBoilerplate(body)) continue;
    const stableId = id ?? `md:${createHash("sha256").update(file).update("\0").update(memory).digest("hex").slice(0, 16)}`;
    out.push({
      id: stableId,
      memory,
      score: 0,
      order: startOrder + out.length,
      metadata: { markdown_file: file, ...entryData.metadata },
      typed: entryData.summary,
    });
  }
  return out;
}

function splitSections(markdown: string): string[] {
  const sections: string[][] = [];
  let current: string[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    if (/^#{1,6}\s+/.test(line) && current.length > 0) {
      sections.push(current);
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) sections.push(current);
  return sections.map((s) => s.join("\n"));
}

function extractMemoryId(section: string): string | undefined {
  const match = section.match(/agape-memory-id:\s*([A-Za-z0-9:._-]+)/);
  return match?.[1];
}

function extractEntryData(section: string): { metadata: Record<string, unknown>; summary?: Record<string, unknown> } {
  const match = section.match(/```json\s*([\s\S]*?)```/);
  if (!match?.[1]) return { metadata: {} };
  try {
    const parsed: unknown = JSON.parse(match[1]);
    if (!isRecord(parsed)) return { metadata: {} };
    return {
      metadata: isRecord(parsed.metadata) ? { ...parsed.metadata } : {},
      ...(isRecord(parsed.summary) ? { summary: { ...parsed.summary } } : {}),
    };
  } catch {
    return { metadata: {} };
  }
}

function stripJsonFences(markdown: string): string {
  return markdown.replace(/```json[\s\S]*?```/g, "").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stripFirstHeading(section: string): string {
  return section.replace(/^#{1,6}\s+.*(?:\r?\n|$)/, "");
}

function stripHtmlComments(markdown: string): string {
  return markdown.replace(/<!--[\s\S]*?-->/g, "");
}

function isForgottenChunk(memory: string): boolean {
  return /agape-forgotten/i.test(memory) || /^#+\s+Forgotten\b/im.test(memory);
}

function isBoilerplate(body: string): boolean {
  const compact = body.replace(/\s+/g, " ").trim();
  return compact === "Active memory cells are listed below. Detailed entries live in topic files under scopes/."
    || compact === "Agape appends internalized memories here. You can edit this file directly; recall reads it as markdown.";
}

function scoreText(text: string, terms: string[], query: string): number {
  const normalized = normalize(text);
  if (terms.length === 0) return 0;
  let score = normalized.includes(normalize(query)) ? 4 : 0;
  for (const term of terms) {
    if (!term) continue;
    const re = new RegExp(escapeRegex(term), "g");
    const matches = normalized.match(re);
    score += matches?.length ?? 0;
  }
  return score;
}

function queryTerms(query: string): string[] {
  return Array.from(new Set(normalize(query).split(/\s+/).filter((t) => t.length > 1)));
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function limitIndex(markdown: string, maxLines: number, maxBytes: number): string {
  const byLines = markdown.split(/\r?\n/).slice(0, maxLines).join("\n");
  const bytes = Buffer.from(byLines, "utf8");
  if (bytes.length <= maxBytes) return byLines;
  return bytes.subarray(0, maxBytes).toString("utf8");
}

function appendMarkdown(existing: string, entry: string): string {
  const trimmed = existing.replace(/\s+$/g, "");
  return `${trimmed}${trimmed ? "\n\n" : ""}${entry}`;
}

function defaultIndexMarkdown(): string {
  return [
    "# Agape Memory",
    "",
    "Active memory cells are listed below. Detailed entries live in topic files under scopes/.",
    "",
    "## Scopes",
    INDEX_START,
    INDEX_END,
    "",
  ].join("\n");
}

function defaultTopicMarkdown(scope: MemoryScope): string {
  return [
    `# Memory: ${scopeLabel(scope)}`,
    "",
    "Agape appends internalized memories here. You can edit this file directly; recall reads it as markdown.",
    "",
  ].join("\n");
}

function forgottenTopicMarkdown(scope: MemoryScope, count: number, at: Date): string {
  return [
    `# Memory: ${scopeLabel(scope)}`,
    "",
    `<!-- agape-forgotten at="${at.toISOString()}" tombstoned="${count}" -->`,
    "",
  ].join("\n");
}

function writeEffects(): Record<string, unknown> {
  return {
    cells: { upserted: 1, tombstoned: 0, deleted: 0 },
    facts: { upserted: 0, tombstoned: 0, deleted: 0 },
    graph: {
      nodes_upserted: 0,
      edges_upserted: 0,
      nodes_tombstoned: 0,
      edges_tombstoned: 0,
      nodes_deleted: 0,
      edges_deleted: 0,
    },
    vectors: { chunks_upserted: 0, chunks_deleted: 0, embeddings_deleted: 0 },
    blobs: { archived: 0, redacted: 0, deleted: 0 },
  };
}

function forgetEffects(count: number, archive: boolean): Record<string, unknown> {
  return {
    cells: { upserted: 0, tombstoned: count, deleted: 0 },
    facts: { upserted: 0, tombstoned: 0, deleted: 0 },
    graph: {
      nodes_upserted: 0,
      edges_upserted: 0,
      nodes_tombstoned: 0,
      edges_tombstoned: 0,
      nodes_deleted: 0,
      edges_deleted: 0,
    },
    vectors: { chunks_upserted: 0, chunks_deleted: 0, embeddings_deleted: 0 },
    blobs: { archived: 0, redacted: 0, deleted: 0 },
  };
}

async function ensureFile(path: string, contents: string): Promise<void> {
  if (existsSync(path)) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, "utf8");
}

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw e;
  }
}

function resolveConfiguredPath(raw: string, scope: MemoryScope, cwd: string): string {
  const templated = template(raw, scope);
  const expanded = templated === "~" ? homedir() : templated.replace(/^~(?=$|[/\\])/, homedir());
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

function template(raw: string, scope: MemoryScope): string {
  return raw
    .replaceAll("{project}", sanitizeSegment(scope.project ?? "default"))
    .replaceAll("{agent}", sanitizeSegment(scope.agentInstanceId))
    .replaceAll("{user}", sanitizeSegment(scope.user ?? "default"))
    .replaceAll("{mem}", sanitizeSegment(scope.mem));
}
function scopeLabel(scope: MemoryScope): string {
  return [scope.project ?? "default", ...(scope.user ? [scope.user] : []), scope.agentAlias, scope.mem].join("/");
}


function scopeSlug(scope: MemoryScope): string {
  return [scope.project ?? "default", ...(scope.user ? [scope.user] : []), scope.agentInstanceId, scope.mem].map(sanitizeSegment).join("-");
}

function memoryScopeIdentity(scope: MemoryScope): string {
  return `${scope.project ?? ""}\0${scope.user ?? ""}\0${scope.agentInstanceId}\0${scope.mem}`;
}

function sanitizeSegment(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  if (!sanitized || sanitized === "." || sanitized === "..") return "default";
  return sanitized;
}

function sanitizeFileName(value: string): string {
  const sanitized = sanitizeSegment(value);
  return sanitized.endsWith(".md") ? sanitized : `${sanitized}.md`;
}

function toMarkdownPath(path: string): string {
  return path.split(sep).join("/");
}

function oneLine(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 120 ? `${compact.slice(0, 117)}...` : compact;
}

function trimTrailingEmpty(lines: string[]): string[] {
  const out = [...lines];
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
