// Conformance runner — drives every ../../agape-conformance test through this implementation's
// own front end (lex → parse) + runtime (run), and scores each against the test's `//!` header
// expectation. Black-box: the tests are the source of truth (SPEC.md-derived); we only read their
// headers for the expected outcome and feed the whole file (the `//!` lines are ordinary `//`
// comments, so the lexer skips them).
//
//   npx tsx conformance/run.mts            # summary + writes conformance/results.json
//   npx tsx conformance/run.mts --section 22_gate   # one section
//   npx tsx conformance/run.mts --verbose  # list every failure reason

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { LexError } from "../src/lexer.js";
import { parse, ParseError } from "../src/parser.js";
import { run } from "../src/interp.js";
import { AgapeError } from "../src/errors.js";
import type { ModuleInput } from "../src/check.js";
import { parseManifestDirective } from "../src/config.js";
import { MockProvider, type Provider } from "../src/runtime.js";

import { LocalMemoryDriver } from "../src/memory.js";
const HERE = dirname(fileURLToPath(import.meta.url));
const SUITE = join(HERE, "..", "..", "agape-conformance", "tests");

// ---- header parsing ----
const LIST_KEYS = new Set(["ledger", "contains", "absent", "order"]);
interface Header {
  id: string;
  section: string;
  expect: "accept" | "reject";
  error?: string;
  ledger?: string[];
  contains?: string[];
  absent?: string[];
  order?: string[];
  provider?: string;
  principal?: string;
  attester?: string;
  manifest?: string;
  replay?: string;
  modules?: string;
  packages?: string;
  spec?: string;
  note?: string;
}

function parseHeader(src: string): Header {
  const h: Record<string, unknown> = {};
  for (const line of src.split(/\r?\n/)) {
    const m = line.match(/^\/\/!\s?(.*)$/);
    if (!m) break; // header is a contiguous block at the top
    const content = m[1]!.trim();
    if (content === "---") break;
    const kv = content.match(/^([a-z_]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1]!;
    const val = kv[2]!.trim();
    if (LIST_KEYS.has(key)) h[key] = val.split(";").map((s) => s.trim()).filter(Boolean);
    else h[key] = val;
  }
  return h as unknown as Header;
}

// ---- provider from the §17.5 `provider:` directive ----
function providerFor(h: Header): Provider {
  const p = h.provider;
  if (!p) return new MockProvider();
  const cred = p.match(/^credence\((.*)\)$/);
  if (cred) {
    const scores: Record<string, number> = {};
    for (const part of cred[1]!.split(",")) {
      const [k, v] = part.split("=").map((s) => s.trim());
      if (k) scores[k] = Number(v);
    }
    return new MockProvider(() => ({ ...scores }));
  }
  // §5/§8/§16.6 fault injection: the runtime reads a provider's `.fault` seam once per send.
  //   `empty`                 — an unrecoverable seam failure (returns nothing → the agent crashes).
  //   `schema_violation`      — a structured reply that fails its schema on EVERY send (→ a
  //                             TypeMismatch that faults the send; with `retry N`, exhausts).
  //   `schema_violation_once` — a TRANSIENT variant: the schema fails on the first send and then the
  //                             reply conforms, so a `retry N` recovery (§11) is observable.
  // The valid replies (after the fault clears) are the ordinary MockProvider structured outputs, so a
  // recovered attempt resolves normally.
  if (p === "empty" || p === "schema_violation" || p === "schema_violation_once") {
    const prov = new MockProvider() as MockProvider & { fault?: string };
    let remaining = p === "schema_violation_once" ? 1 : Number.POSITIVE_INFINITY;
    Object.defineProperty(prov, "fault", {
      configurable: true,
      get(): string | undefined {
        if (p === "empty") return "empty";
        if (remaining > 0) { remaining--; return "schema_violation"; }
        return undefined; // the transient fault has cleared — the next send resolves normally
      },
    });
    return prov;
  }
  return new MockProvider();
}

// ---- companion module loading (§17.5 harness) ----
// A test's `modules:` / `packages:` directive names source files that live under a sibling
// `<testid>.d/` directory. We read them and hand them to the linker as `ModuleInput`s; the runtime
// resolves the main program's imports against them. This is harness plumbing only — the test bodies
// (the oracle) are never modified.
//   modules:  a.ag; b.ag            → <testid>.d/a.ag, <testid>.d/b.ag   (self-name via `module` header)
//   packages: geo=geo/src/lib.ag    → <testid>.d/geo/src/lib.ag imported as root `geo`
function loadCompanions(secDir: string, agFile: string, h: Header): ModuleInput[] {
  const dDir = join(secDir, agFile.replace(/\.ag$/, "") + ".d");
  const mods: ModuleInput[] = [];
  if (h.modules) {
    for (const rel of h.modules.split(";").map((s) => s.trim()).filter(Boolean)) {
      mods.push({ src: readFileSync(join(dDir, rel), "utf8") });
    }
  }
  if (h.packages) {
    for (const entry of h.packages.split(";").map((s) => s.trim()).filter(Boolean)) {
      const eq = entry.indexOf("=");
      if (eq < 0) continue;
      mods.push({ name: entry.slice(0, eq).trim(), src: readFileSync(join(dDir, entry.slice(eq + 1).trim()), "utf8") });
    }
  }
  return mods;
}

// ---- run one test through lex → parse → run ----
type Phase = "parse" | "run";
interface Outcome {
  threw: boolean;
  errorClass?: string;
  phase?: Phase;
  rawMessage?: string;
  events?: { type: string; subject: string }[];
  head?: string;
  head2?: string; // a second run, for weak replay
}

function classifyRuntime(e: unknown): string {
  if (e instanceof AgapeError) return e.cls; // typed: TypeError / TaintViolation / AuthorityViolation / …
  const msg = String((e as Error)?.message ?? e);
  if (/TaintViolation/.test(msg)) return "TaintViolation";
  if (/AuthorityViolation/.test(msg)) return "AuthorityViolation";
  return "RuntimeError";
}

// map this runtime's ledger event names onto the suite's token vocabulary (README §ledger matcher).
function mapEtype(etype: string): string {
  if (etype === "AgentAsleep") return "SleepEvent";
  return etype;
}

async function runTest(h: Header, src: string, companions: ModuleInput[]): Promise<Outcome> {
  let program;
  try {
    program = parse(src);
  } catch (e) {
    const cls = e instanceof LexError ? "LexError" : e instanceof ParseError ? "ParseError" : "ParseError";
    return { threw: true, errorClass: cls, phase: "parse", rawMessage: String((e as Error).message) };
  }
  // §17.1 configuration: the `manifest:` directive binds declared dependencies + tunes the provider.
  const manifest = h.manifest ? parseManifestDirective(h.manifest) : undefined;
  // §13/§17.5: the `principal:` directive supplies the mock outcome of a principal-driven decide.
  const principal = h.principal;
  // §13/§16.4/§17.7: the `attester:` directive is the mock host authenticator — the principal that the
  // ruling's verified attester identity resolves to. The kernel records PrincipalDecision only when it
  // equals the deferred principal, else FailedPrincipalDecision (attester mismatch).
  const attesterVerifier = h.attester !== undefined ? () => h.attester : undefined;
  // §17.1/§17.5: the harness runs the configuration section in configured/strict binding mode, where every
  // declared principal/prompt/tool dependency must be bound in the manifest; other sections auto-bind mocks.
  const strictConfig = h.section === "16_config";
  const memory = manifest?.memory?.driver ? {} : { memory: new LocalMemoryDriver() };
  try {
    const r = await run(program, { provider: providerFor(h), modules: companions, manifest, principal, attesterVerifier, strictConfig, ...memory });
    const events = r.ledger.events.map((e) => ({ type: mapEtype(e.etype), subject: e.subject }));
    const out: Outcome = { threw: false, phase: "run", events, head: r.ledger.head() };
    if (h.replay === "chain_head_equal") {
      const replayMemory = manifest?.memory?.driver ? {} : { memory: new LocalMemoryDriver() };
      const r2 = await run(parse(src), { provider: providerFor(h), modules: companions, manifest, principal, attesterVerifier, strictConfig, ...replayMemory });
      out.head2 = r2.ledger.head();
    }
    return out;
  } catch (e) {
    return { threw: true, errorClass: classifyRuntime(e), phase: "run", rawMessage: String((e as Error).message) };
  }
}

// ---- ledger matcher vocabulary ----
type Tok =
  | { kind: "plain"; type: string; subject?: string }
  | { kind: "pairlike"; pair: boolean; op: string; subject: string };

function parseTok(s: string): Tok {
  let m = s.match(/^(pair|single)\(([^@]+)@([^)]+)\)$/);
  if (m) return { kind: "pairlike", pair: m[1] === "pair", op: m[2]!.trim(), subject: m[3]!.trim() };
  m = s.match(/^([A-Za-z_]\w*)\(([^)]*)\)$/);
  if (m) return { kind: "plain", type: m[1]!, subject: m[2]!.trim() || undefined };
  return { kind: "plain", type: s.trim() };
}

function matchesPlain(tok: Extract<Tok, { kind: "plain" }>, ev: { type: string; subject: string }): boolean {
  const typeOk = tok.type === "Error" ? /Error$|^Contradiction$/.test(ev.type) : ev.type === tok.type;
  if (!typeOk) return false;
  return tok.subject === undefined || ev.subject === tok.subject;
}

function tokSatisfied(tok: Tok, events: { type: string; subject: string }[]): boolean {
  if (tok.kind === "plain") return events.some((ev) => matchesPlain(tok, ev));
  // pairlike: best-effort — events on the subject whose type carries the op (case-insensitive)
  const hits = events.filter((ev) => ev.subject === tok.subject && ev.type.toLowerCase().includes(tok.op.toLowerCase()));
  return tok.pair ? hits.length >= 2 : hits.length >= 1;
}

function exactLedgerMatch(matchers: string[], events: { type: string; subject: string }[]): boolean {
  if (matchers.length !== events.length) return false;
  for (let i = 0; i < matchers.length; i++) {
    const tok = parseTok(matchers[i]!);
    if (tok.kind !== "plain") return false; // exact ledgers don't use pair/single
    if (!matchesPlain(tok, events[i]!)) return false;
  }
  return true;
}

function orderMatch(matchers: string[], events: { type: string; subject: string }[]): boolean {
  let idx = 0;
  for (const ev of events) {
    if (idx >= matchers.length) break;
    if (tokSatisfied(parseTok(matchers[idx]!), [ev])) idx++;
  }
  return idx === matchers.length;
}

// ---- evaluate outcome vs expectation ----
interface Verdict { pass: boolean; reason: string }

function evaluate(h: Header, o: Outcome): Verdict {
  if (h.expect === "reject") {
    if (!o.threw) return { pass: false, reason: `expected reject(${h.error}) but accepted` };
    if (o.errorClass === h.error) return { pass: true, reason: `rejected with ${h.error}` };
    return { pass: false, reason: `expected ${h.error}, got ${o.errorClass} (${o.phase})` };
  }
  // accept
  if (o.threw) return { pass: false, reason: `expected accept but threw ${o.errorClass} in ${o.phase}: ${o.rawMessage}` };
  const ev = o.events!;
  if (h.ledger && !exactLedgerMatch(h.ledger, ev)) {
    return { pass: false, reason: `ledger mismatch: want [${h.ledger.join(", ")}] got [${ev.map((e) => `${e.type}(${e.subject})`).join(", ")}]` };
  }
  if (h.contains) {
    const missing = h.contains.filter((t) => !tokSatisfied(parseTok(t), ev));
    if (missing.length) return { pass: false, reason: `missing required events: ${missing.join(", ")} (got [${ev.map((e) => e.type).join(", ")}])` };
  }
  if (h.absent) {
    const present = h.absent.filter((t) => tokSatisfied(parseTok(t), ev));
    if (present.length) return { pass: false, reason: `forbidden events present: ${present.join(", ")}` };
  }
  if (h.order && !orderMatch(h.order, ev)) {
    return { pass: false, reason: `order not satisfied: ${h.order.join(" < ")}` };
  }
  if (h.replay === "chain_head_equal" && o.head !== o.head2) {
    return { pass: false, reason: `replay chain-head differs: ${o.head} vs ${o.head2}` };
  }
  return { pass: true, reason: "accepted" + (h.ledger || h.contains || h.absent || h.order ? " + ledger ok" : "") };
}

// ---- driver ----
interface Row {
  id: string;
  section: string;
  expect: string;
  pass: boolean;
  reason: string;
  errorClass?: string;
  phase?: string;
  hadMatchers: boolean;
  directives: string[];
}

async function main() {
  const args = process.argv.slice(2);
  const sectionFilter = args.includes("--section") ? args[args.indexOf("--section") + 1] : undefined;
  const verbose = args.includes("--verbose");

  const rows: Row[] = [];
  for (const section of readdirSync(SUITE).sort()) {
    if (sectionFilter && section !== sectionFilter) continue;
    const secDir = join(SUITE, section);
    if (!statSync(secDir).isDirectory()) continue;
    for (const f of readdirSync(secDir).sort()) {
      if (!f.endsWith(".ag")) continue; // .d/ companion dirs don't end in .ag
      const full = join(secDir, f);
      if (!statSync(full).isFile()) continue;
      const src = readFileSync(full, "utf8");
      const h = parseHeader(src);
      if (!h.expect) continue;
      const companions = loadCompanions(secDir, f, h);
      const o = await runTest(h, src, companions);
      const v = evaluate(h, o);
      const directives = (["provider", "principal", "attester", "manifest", "replay", "modules", "packages"] as const).filter((k) => h[k]);
      rows.push({
        id: h.id, section, expect: h.expect, pass: v.pass, reason: v.reason,
        errorClass: o.errorClass, phase: o.phase,
        hadMatchers: Boolean(h.ledger || h.contains || h.absent || h.order),
        directives,
      });
    }
  }

  // ---- aggregate ----
  const bySection = new Map<string, { pass: number; total: number }>();
  for (const r of rows) {
    const s = bySection.get(r.section) ?? { pass: 0, total: 0 };
    s.total++; if (r.pass) s.pass++;
    bySection.set(r.section, s);
  }
  const passed = rows.filter((r) => r.pass).length;

  console.log(`\nAgape conformance — this TypeScript implementation vs the suite\n${"=".repeat(60)}`);
  console.log(`section                      pass / total`);
  console.log("-".repeat(60));
  for (const [sec, s] of [...bySection].sort()) {
    const bar = s.pass === s.total ? "  ✓" : "";
    console.log(`${sec.padEnd(28)} ${String(s.pass).padStart(3)} / ${String(s.total).padStart(3)}${bar}`);
  }
  console.log("-".repeat(60));
  console.log(`${"TOTAL".padEnd(28)} ${String(passed).padStart(3)} / ${String(rows.length).padStart(3)}   (${((100 * passed) / rows.length).toFixed(1)}%)`);

  if (verbose) {
    console.log(`\nFailures:\n${"-".repeat(60)}`);
    for (const r of rows.filter((r) => !r.pass)) {
      console.log(`  [${r.section}] ${r.id} (${r.expect})\n      ${r.reason}`);
    }
  }

  const outPath = join(HERE, "results.json");
  writeFileSync(outPath, JSON.stringify({ passed, total: rows.length, bySection: Object.fromEntries(bySection), rows }, null, 2));
  console.log(`\nwrote ${outPath}`);
  return rows.length - passed;
}

main().then(
  (failures) => process.exit(failures > 0 ? 1 : 0),
  (err) => { console.error(err); process.exit(1); },
);
