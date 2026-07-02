import { expect } from "vitest";
import type { LedgerEvent, MemoryInspectResult, MemoryPacket } from "./adapter.js";

export function requireEvent(events: LedgerEvent[], etype: string, subject?: string): LedgerEvent {
  const event = events.find((e) => e.etype === etype && (subject === undefined || e.subject === subject));
  expect(event, `expected ledger event ${etype}${subject ? `(${subject})` : ""}`).toBeTruthy();
  return event as LedgerEvent;
}

export function payloadObject(event: LedgerEvent): Record<string, unknown> {
  if (event.payload === undefined || event.payload === null || event.payload === "") return {};
  if (typeof event.payload === "string") {
    try {
      return JSON.parse(event.payload) as Record<string, unknown>;
    } catch {
      return { text: event.payload };
    }
  }
  if (typeof event.payload === "object") return event.payload as Record<string, unknown>;
  return { value: event.payload };
}

export function packetText(packet: MemoryPacket): string {
  return JSON.stringify(packet).toLowerCase();
}

export function inspectText(inspect: MemoryInspectResult): string {
  return JSON.stringify(inspect).toLowerCase();
}

export function expectOriginTicks(inspect: MemoryInspectResult): void {
  for (const group of [inspect.summaries, inspect.chunks, inspect.facts, inspect.triples, inspect.vectors]) {
    for (const cell of group) {
      expect(Number.isInteger(cell.originTick), `cell missing originTick: ${JSON.stringify(cell)}`).toBe(true);
    }
  }
}

export function totalMemoryCells(inspect: MemoryInspectResult): number {
  return inspect.counts.summaries + inspect.counts.chunks + inspect.counts.facts + inspect.counts.triples + inspect.counts.vectors;
}

export function expectGapFreeTicks(events: LedgerEvent[]): void {
  const ticks = events.map((e) => e.tick).sort((a, b) => a - b);
  for (let i = 0; i < ticks.length; i++) {
    expect(ticks[i], `ledger tick ${i} should be gap-free`).toBe(i);
  }
}

export function expectEventOrder(events: LedgerEvent[], etypes: string[]): void {
  let cursor = -1;
  for (const etype of etypes) {
    const idx = events.findIndex((e, i) => i > cursor && e.etype === etype);
    expect(idx, `expected ${etype} after index ${cursor}`).toBeGreaterThan(cursor);
    cursor = idx;
  }
}

export function eventsOf(events: LedgerEvent[], etype: string): LedgerEvent[] {
  return events.filter((e) => e.etype === etype);
}
