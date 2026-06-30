// The Agape memory architecture (SPEC §10) over one SQLite database:
// a spine (§7) as the source of truth, and three modalities folded from it —
// FACTS (table, `select`), RELATIONSHIPS (SPO graph, `find … where`), and
// SEMANTICS (vectors, `match … > θ`). Every cell carries a provenance backpointer
// (`origin_tick`) to the spine event that produced it, and a taint.
//
// Pure storage + queries: the LLM (decomposition) is injected, so this module is
// tested without an API key. The embedder is a sync seam (local by default).

import Database from "better-sqlite3";
import type { Embedder, Fact, Triple } from "./provider.ts";
import { cosine } from "./provider.ts";

export type Taint = "U" | "P" | "T"; // committed · graded · tainted (§13 lattice)

export interface SpineEvent {
  tick: number;
  etype: string;
  subject: string;
  payload: string;
  corr: string | null;
  agent: string;
  ts: number;
}

export interface FactRow extends Fact {
  agent: string;
  origin_tick: number;
  taint: Taint;
}
export interface TripleRow extends Triple {
  agent: string;
  origin_tick: number;
  taint: Taint;
}
export interface MatchHit {
  text: string;
  score: number;
  origin_tick: number;
}
export interface SourceRow {
  id: number;
  agent: string;
  kind: string;
  uri: string;
  title: string;
  summary: string;
  source_hash: string;
  origin_tick: number;
  ts: number;
}
export interface SourceChunkRow {
  id: number;
  agent: string;
  source_id: number;
  source_kind: string;
  source_uri: string;
  title: string;
  chunk_hash: string;
  origin_tick: number;
  ts: number;
}

export class Memory {
  private db: Database.Database;
  private embedder: Embedder;

  constructor(embedder: Embedder, path = ":memory:") {
    this.embedder = embedder;
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS spine (
        tick INTEGER PRIMARY KEY AUTOINCREMENT,
        etype TEXT NOT NULL, subject TEXT NOT NULL, payload TEXT,
        corr TEXT, agent TEXT NOT NULL, ts INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT NOT NULL,
        key TEXT NOT NULL, value TEXT NOT NULL,
        origin_tick INTEGER NOT NULL, taint TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS triples (
        id INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT NOT NULL,
        s TEXT NOT NULL, p TEXT NOT NULL, o TEXT NOT NULL,
        origin_tick INTEGER NOT NULL, taint TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS embeddings (
        id INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT NOT NULL,
        text TEXT NOT NULL, vec TEXT NOT NULL, origin_tick INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT NOT NULL,
        kind TEXT NOT NULL, uri TEXT NOT NULL, title TEXT NOT NULL,
        summary TEXT NOT NULL, source_hash TEXT NOT NULL,
        origin_tick INTEGER NOT NULL, ts INTEGER NOT NULL,
        UNIQUE(agent, kind, uri, source_hash));
      CREATE TABLE IF NOT EXISTS source_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT NOT NULL,
        source_id INTEGER NOT NULL, source_kind TEXT NOT NULL, source_uri TEXT NOT NULL,
        title TEXT NOT NULL, chunk_hash TEXT NOT NULL,
        origin_tick INTEGER NOT NULL, ts INTEGER NOT NULL,
        UNIQUE(agent, source_kind, source_uri, chunk_hash));
      CREATE INDEX IF NOT EXISTS i_facts_agent ON facts(agent);
      CREATE INDEX IF NOT EXISTS i_triples_agent ON triples(agent, s, p, o);
      CREATE INDEX IF NOT EXISTS i_emb_agent ON embeddings(agent);
      CREATE INDEX IF NOT EXISTS i_sources_agent ON sources(agent, kind, uri);
      CREATE INDEX IF NOT EXISTS i_source_chunks_agent ON source_chunks(agent, source_kind, source_uri);
    `);
  }

  // ── the spine (§7): append-only, monotonic tick ──
  append(agent: string, etype: string, subject: string, payload = "", corr: string | null = null): number {
    const info = this.db
      .prepare(`INSERT INTO spine (etype, subject, payload, corr, agent, ts) VALUES (?,?,?,?,?,?)`)
      .run(etype, subject, payload, corr, agent, Date.now());
    return Number(info.lastInsertRowid);
  }

  event(tick: number): SpineEvent | undefined {
    return this.db.prepare(`SELECT * FROM spine WHERE tick = ?`).get(tick) as SpineEvent | undefined;
  }

  spineSize(): number {
    return (this.db.prepare(`SELECT count(*) c FROM spine`).get() as any).c;
  }

  // ── §10 internalization: decompose an event into facts + triples + embedding,
  // each pinned to the originating spine event (provenance), with a taint. ──
  internalize(
    agent: string,
    etype: string,
    subject: string,
    text: string,
    decomp: { facts: Fact[]; triples: Triple[] },
    taint: Taint = "P"
  ): number {
    const tick = this.append(agent, etype, subject, text);
    const insFact = this.db.prepare(`INSERT INTO facts (agent,key,value,origin_tick,taint) VALUES (?,?,?,?,?)`);
    const insTriple = this.db.prepare(`INSERT INTO triples (agent,s,p,o,origin_tick,taint) VALUES (?,?,?,?,?,?)`);
    const insEmb = this.db.prepare(`INSERT INTO embeddings (agent,text,vec,origin_tick) VALUES (?,?,?,?)`);
    const tx = this.db.transaction(() => {
      for (const f of decomp.facts) insFact.run(agent, f.key, f.value, tick, taint);
      for (const t of decomp.triples) insTriple.run(agent, t.s, t.p, t.o, tick, taint);
      insEmb.run(agent, text, JSON.stringify(this.embedder.embed(text)), tick);
    });
    tx();
    return tick;
  }

  // ── knowledge artifacts: uploaded/read documents that an agent internalizes
  // into its own private store. Physical chunks may dedupe; semantic ownership is
  // still per-agent via the `agent` column.
  source(agent: string, kind: string, uri: string, sourceHash: string): SourceRow | undefined {
    return this.db
      .prepare(`SELECT * FROM sources WHERE agent = ? AND kind = ? AND uri = ? AND source_hash = ?`)
      .get(agent, kind, uri, sourceHash) as SourceRow | undefined;
  }

  ensureSource(
    agent: string,
    kind: string,
    uri: string,
    title: string,
    summary: string,
    sourceHash: string
  ): { source: SourceRow; created: boolean } {
    const existing = this.source(agent, kind, uri, sourceHash);
    if (existing) return { source: existing, created: false };
    const tick = this.append(
      agent,
      "ArtifactObserved",
      uri,
      JSON.stringify({ kind, uri, title, source_hash: sourceHash, summary })
    );
    const info = this.db
      .prepare(`INSERT INTO sources (agent,kind,uri,title,summary,source_hash,origin_tick,ts) VALUES (?,?,?,?,?,?,?,?)`)
      .run(agent, kind, uri, title, summary, sourceHash, tick, Date.now());
    return {
      source: this.db.prepare(`SELECT * FROM sources WHERE id = ?`).get(Number(info.lastInsertRowid)) as SourceRow,
      created: true,
    };
  }

  sourceChunk(agent: string, kind: string, uri: string, chunkHash: string): SourceChunkRow | undefined {
    return this.db
      .prepare(`SELECT * FROM source_chunks WHERE agent = ? AND source_kind = ? AND source_uri = ? AND chunk_hash = ?`)
      .get(agent, kind, uri, chunkHash) as SourceChunkRow | undefined;
  }

  recordSourceChunk(
    agent: string,
    sourceId: number,
    kind: string,
    uri: string,
    title: string,
    chunkHash: string,
    originTick: number
  ): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO source_chunks
          (agent,source_id,source_kind,source_uri,title,chunk_hash,origin_tick,ts)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(agent, sourceId, kind, uri, title, chunkHash, originTick, Date.now());
  }

  sourceSummaries(agent: string, limit = 5): SourceRow[] {
    return this.db
      .prepare(`SELECT * FROM sources WHERE agent = ? ORDER BY id DESC LIMIT ?`)
      .all(agent, limit) as SourceRow[];
  }

  // ── FACTS: `select … where` ──
  select(agent: string, where: { key?: string; contains?: string } = {}): FactRow[] {
    let sql = `SELECT agent,key,value,origin_tick,taint FROM facts WHERE agent = ?`;
    const args: any[] = [agent];
    if (where.key) {
      sql += ` AND key = ?`;
      args.push(where.key);
    }
    if (where.contains) {
      sql += ` AND (key LIKE ? OR value LIKE ?)`;
      args.push(`%${where.contains}%`, `%${where.contains}%`);
    }
    return this.db.prepare(sql).all(...args) as FactRow[];
  }

  // ── RELATIONSHIPS: `find BINDING [, origin(BINDING)] where { PATTERN }` ──
  find(agent: string, pattern: { s?: string; p?: string; o?: string } = {}): TripleRow[] {
    let sql = `SELECT agent,s,p,o,origin_tick,taint FROM triples WHERE agent = ?`;
    const args: any[] = [agent];
    for (const k of ["s", "p", "o"] as const) {
      if (pattern[k]) {
        sql += ` AND ${k} = ?`;
        args.push(pattern[k]);
      }
    }
    return this.db.prepare(sql).all(...args) as TripleRow[];
  }

  // ── SEMANTICS: `match { b: q } > θ` — a gate; hits clear θ, are U but off-spine ──
  match(agent: string, query: string, theta = 0.2, limit = 6): MatchHit[] {
    const q = this.embedder.embed(query);
    const rows = this.db.prepare(`SELECT text, vec, origin_tick FROM embeddings WHERE agent = ?`).all(agent) as any[];
    return rows
      .map((r) => ({ text: r.text as string, score: cosine(q, JSON.parse(r.vec)), origin_tick: r.origin_tick as number }))
      .filter((h) => h.score >= theta)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  // ── read-only inspection (free: no cognition) ──
  spineRecent(agent: string, limit = 80): SpineEvent[] {
    return this.db.prepare(`SELECT * FROM spine WHERE agent = ? ORDER BY tick DESC LIMIT ?`).all(agent, limit) as SpineEvent[];
  }

  listEmbeddings(agent: string, limit = 80): { text: string; origin_tick: number }[] {
    return this.db
      .prepare(`SELECT text, origin_tick FROM embeddings WHERE agent = ? ORDER BY id DESC LIMIT ?`)
      .all(agent, limit) as { text: string; origin_tick: number }[];
  }

  counts(agent: string) {
    const one = (t: string) =>
      (this.db.prepare(`SELECT count(*) c FROM ${t} WHERE agent = ?`).get(agent) as any).c as number;
    return {
      spine: this.spineSize(),
      facts: one("facts"),
      triples: one("triples"),
      embeddings: one("embeddings"),
      sources: one("sources"),
      chunks: one("source_chunks"),
    };
  }

  close() {
    this.db.close();
  }
}
