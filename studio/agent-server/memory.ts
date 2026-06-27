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
      CREATE INDEX IF NOT EXISTS i_facts_agent ON facts(agent);
      CREATE INDEX IF NOT EXISTS i_triples_agent ON triples(agent, s, p, o);
      CREATE INDEX IF NOT EXISTS i_emb_agent ON embeddings(agent);
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
    return { spine: this.spineSize(), facts: one("facts"), triples: one("triples"), embeddings: one("embeddings") };
  }

  close() {
    this.db.close();
  }
}
