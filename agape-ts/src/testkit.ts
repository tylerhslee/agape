import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "./parser.js";
import { run as runtimeRun, type RunResult } from "./interp.js";
import type { LedgerEvent } from "./runtime.js";

import { LocalMemoryDriver } from "./memory.js";
export type AgapeRunOptions = NonNullable<Parameters<typeof runtimeRun>[1]>;
export type AgapeTestRun = RunResult & {
  memoryRoot?: string;
  cleanup: () => Promise<void>;
};

export async function runAgape(source: string, opts: AgapeRunOptions = {}): Promise<AgapeTestRun> {
  let ownedMemoryRoot: string | undefined;
  const memoryRoot = opts.memoryRoot ?? await mkdtemp(join(tmpdir(), "agape-test-memory-"));
  if (!opts.memoryRoot) ownedMemoryRoot = memoryRoot;
  const useConfiguredDriver = opts.manifest?.memory !== undefined;
  const result = await runtimeRun(parse(source), {
    ...opts,
    memoryRoot,
    ...(!opts.memory && !useConfiguredDriver ? { memory: new LocalMemoryDriver() } : {}),
  });
  return {
    ...result,
    memoryRoot,
    cleanup: async () => {
      if (ownedMemoryRoot) await rm(ownedMemoryRoot, { recursive: true, force: true });
    },
  };
}

export async function withAgapeRun<T>(
  source: string,
  opts: AgapeRunOptions,
  fn: (run: AgapeTestRun) => T | Promise<T>,
): Promise<T>;
export async function withAgapeRun<T>(
  source: string,
  fn: (run: AgapeTestRun) => T | Promise<T>,
): Promise<T>;
export async function withAgapeRun<T>(
  source: string,
  optsOrFn: AgapeRunOptions | ((run: AgapeTestRun) => T | Promise<T>),
  maybeFn?: (run: AgapeTestRun) => T | Promise<T>,
): Promise<T> {
  const opts = typeof optsOrFn === "function" ? {} : optsOrFn;
  const fn = typeof optsOrFn === "function" ? optsOrFn : maybeFn;
  if (!fn) throw new Error("withAgapeRun requires a callback");
  const run = await runAgape(source, opts);
  try {
    return await fn(run);
  } finally {
    await run.cleanup();
  }
}

export function eventTypes(input: RunResult | LedgerEvent[]): string[] {
  return eventsOf(input).map((event) => event.etype);
}

export function eventsOf(input: RunResult | LedgerEvent[]): LedgerEvent[] {
  return Array.isArray(input) ? input : input.ledger.events;
}

export function findEvents(input: RunResult | LedgerEvent[], etype: string): LedgerEvent[] {
  return eventsOf(input).filter((event) => event.etype === etype);
}

export function requireEvent(
  input: RunResult | LedgerEvent[],
  etype: string,
  predicate?: (event: LedgerEvent) => boolean,
): LedgerEvent {
  const events = findEvents(input, etype);
  const event = predicate ? events.find(predicate) : events[0];
  if (!event) {
    const suffix = predicate ? " matching predicate" : "";
    throw new Error(`expected ledger event ${etype}${suffix}; saw [${eventTypes(input).join(", ")}]`);
  }
  return event;
}

export function assertNoEvent(
  input: RunResult | LedgerEvent[],
  etype: string,
  predicate?: (event: LedgerEvent) => boolean,
): void {
  const events = findEvents(input, etype);
  const event = predicate ? events.find(predicate) : events[0];
  if (event) throw new Error(`expected no ledger event ${etype}; found tick ${event.tick}`);
}

export function assertEventOrder(input: RunResult | LedgerEvent[], expected: string[]): void {
  const actual = eventTypes(input);
  let cursor = 0;
  for (const etype of actual) {
    if (etype === expected[cursor]) cursor += 1;
    if (cursor === expected.length) return;
  }
  throw new Error(`expected event order [${expected.join(", ")}] within [${actual.join(", ")}]`);
}

export function normalizedLedger(input: RunResult | LedgerEvent[]): Array<Record<string, unknown>> {
  return eventsOf(input).map((event) => ({
    tick: event.tick,
    etype: event.etype,
    subject: event.subject,
    ...(event.agent ? { agent: event.agent } : {}),
    ...(event.payload === undefined ? {} : { payload: event.payload }),
  }));
}

export function assertPayloadObject(event: LedgerEvent): Record<string, unknown> {
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
    throw new Error(`expected event ${event.etype} payload to be an object`);
  }
  return event.payload as Record<string, unknown>;
}