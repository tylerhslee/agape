import { describe, expect, it } from "vitest";
import type { Value } from "../src/runtime.js";
import {
  decodeExactValue,
  deriveMemoryRegionKey,
  encodeExactValue,
  hashMemoryDescriptor,
  hashPersistedSchema,
  type MemoryRegionKeyInput,
  type PersistedSchema,
  type ResolvedMemoryDescriptor,
} from "../src/named_memory.js";

const scalar = (name: "text" | "float"): PersistedSchema => ({ kind: "scalar", name });

function schema(reverse = false): PersistedSchema {
  const claimFields = [
    { name: "sources", schema: { kind: "array", items: scalar("text") } as PersistedSchema },
    { name: "confidence", schema: scalar("float") },
    { name: "verdict", schema: { kind: "enum", name: "fact.Verdict", variants: ["Supported", "Rejected"] } as PersistedSchema },
  ];
  return { kind: "struct", name: "fact.Claim", fields: reverse ? [...claimFields].reverse() : claimFields };
}

function descriptor(
  retention: "session" | "durable" = "session",
  scopes: readonly ("project" | "user")[] = ["project", "user"],
  reverse = false,
): ResolvedMemoryDescriptor {
  return { name: "claims", schema: schema(reverse), modality: "semantic", scopes, retention };
}

function bits(value: number): string {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value, false);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("pure named-memory schema, codec, and region keys", () => {
  it("canonicalizes schema fields and descriptor scopes before hashing", () => {
    expect(hashPersistedSchema(schema())).toBe(hashPersistedSchema(schema(true)));
    expect(hashPersistedSchema(schema())).toMatch(/^[a-f0-9]{64}$/);
    const left = descriptor("session", ["project", "user"]);
    const right = descriptor("session", ["user", "project"], true);
    expect(hashMemoryDescriptor(left)).toBe(hashMemoryDescriptor(right));
    expect(hashMemoryDescriptor(left)).toMatch(/^[a-f0-9]{64}$/);
    expect(() => hashMemoryDescriptor({ ...left, modality: "invalid" as ResolvedMemoryDescriptor["modality"] }))
      .toThrow("unsupported memory modality");
    expect(hashMemoryDescriptor(descriptor("durable"))).not.toBe(hashMemoryDescriptor(left));
  });

  it("round-trips nested declared data without persisting trust metadata", () => {
    const value: Value = {
      kind: "struct", typeName: "fact.Claim", trust: "raw", ingress: "external_screened", privateMemory: true,
      fields: new Map([
        ["verdict", { kind: "enumval", enumName: "fact.Verdict", variant: "Supported", trust: "raw" }],
        ["confidence", { kind: "float", v: 0.875, trust: "raw" }],
        ["sources", { kind: "array", trust: "raw", items: [
          { kind: "text", v: "primary", trust: "raw" },
          { kind: "text", v: "secondary", trust: "raw" },
        ] }],
      ]),
    };
    const envelope = encodeExactValue(value, schema());
    const wire = JSON.stringify(envelope);
    expect(wire).not.toContain("trust");
    expect(wire).not.toContain("ingress");
    expect(wire).not.toContain("privateMemory");
    expect(decodeExactValue(envelope, schema())).toEqual({
      kind: "struct", typeName: "fact.Claim", trust: "settled",
      fields: new Map([
        ["confidence", { kind: "float", v: 0.875, trust: "settled" }],
        ["sources", { kind: "array", trust: "settled", items: [
          { kind: "text", v: "primary", trust: "settled" },
          { kind: "text", v: "secondary", trust: "settled" },
        ] }],
        ["verdict", { kind: "enumval", enumName: "fact.Verdict", variant: "Supported", trust: "settled" }],
      ]),
    });
    expect(() => decodeExactValue({ ...envelope, valueHash: "0".repeat(64) }, schema()))
      .toThrow("persisted value hash mismatch");
  });

  it("preserves exact IEEE-754 float bits including negative zero and non-finite values", () => {
    const floatSchema: PersistedSchema = { kind: "scalar", name: "float" };
    const payload = new ArrayBuffer(8);
    const payloadView = new DataView(payload);
    payloadView.setBigUint64(0, 0x7ff8000000000042n, false);
    const payloadNaN = payloadView.getFloat64(0, false);
    for (const original of [-0, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, payloadNaN]) {
      const envelope = encodeExactValue({ kind: "float", v: original, trust: "raw" }, floatSchema);
      const decoded = decodeExactValue(envelope, floatSchema);
      expect(decoded.kind).toBe("float");
      if (decoded.kind !== "float") continue;
      expect(bits(decoded.v)).toBe(bits(original));
    }
    expect(JSON.stringify(encodeExactValue({ kind: "float", v: -0, trust: "raw" }, floatSchema)))
      .toContain("8000000000000000");
  });

  it("derives opaque retention-aware keys isolated by instance, scope, and descriptor", () => {
    const base: MemoryRegionKeyInput = {
      descriptor: descriptor(),
      projectSubject: "project://acme/private",
      sessionLineageId: "lineage-secret",
      sessionId: "session-one",
      stableAgentInstanceId: "agent-instance-secret",
      user: { issuer: "issuer-secret", subject: "user-secret", verified: true },
    };
    const key = deriveMemoryRegionKey(base);
    const nextSession = deriveMemoryRegionKey({ ...base, sessionId: "session-two" });
    const durableOne = deriveMemoryRegionKey({ ...base, descriptor: descriptor("durable") });
    const durableTwo = deriveMemoryRegionKey({ ...base, descriptor: descriptor("durable"), sessionId: "session-two" });
    const nextInstance = deriveMemoryRegionKey({ ...base, stableAgentInstanceId: "other-agent-secret" });
    const projectOnly = { ...base, descriptor: descriptor("session", ["project"]) };
    const projectOnlyOtherUser = { ...projectOnly, user: { ...base.user!, subject: "ignored-user-secret" } };

    for (const candidate of [key, nextSession, durableOne, nextInstance]) {
      expect(candidate).toMatch(/^memory-region-v1:[a-f0-9]{64}$/);
      for (const raw of [base.projectSubject!, base.sessionLineageId, base.sessionId,
        base.stableAgentInstanceId, base.user!.issuer, base.user!.subject, base.descriptor.name]) {
        expect(candidate).not.toContain(raw);
      }
    }
    expect(key).not.toBe(nextSession);
    expect(durableOne).toBe(durableTwo);
    expect(key).not.toBe(durableOne);
    expect(key).not.toBe(nextInstance);
    expect(deriveMemoryRegionKey(projectOnly)).not.toBe(key);
    expect(deriveMemoryRegionKey(projectOnly)).toBe(deriveMemoryRegionKey(projectOnlyOtherUser));
    expect(deriveMemoryRegionKey({ ...base, descriptor: { ...base.descriptor, name: "other" } })).not.toBe(key);
  });
});
