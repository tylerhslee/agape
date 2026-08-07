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
      kind: "struct", typeName: "fact.Claim", trust: "raw",
      fields: new Map([
        ["confidence", { kind: "float", v: 0.875, trust: "raw" }],
        ["sources", { kind: "array", trust: "raw", items: [
          { kind: "text", v: "primary", trust: "raw" },
          { kind: "text", v: "secondary", trust: "raw" },
        ] }],
        ["verdict", { kind: "enumval", enumName: "fact.Verdict", variant: "Supported", trust: "raw" }],
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

  it("rejects unknown own keys at every schema and descriptor record boundary", () => {
    const extra = { extension: true };
    const invalidSchemas: PersistedSchema[] = [
      { kind: "scalar", name: "text", ...extra } as unknown as PersistedSchema,
      { kind: "enum", name: "fact.Verdict", variants: ["Supported"], ...extra } as unknown as PersistedSchema,
      { kind: "array", items: scalar("text"), ...extra } as unknown as PersistedSchema,
      { kind: "struct", name: "fact.Claim", fields: [], ...extra } as unknown as PersistedSchema,
      {
        kind: "struct",
        name: "fact.Claim",
        fields: [{ name: "claim", schema: scalar("text"), ...extra }],
      } as unknown as PersistedSchema,
    ];
    for (const invalid of invalidSchemas) {
      expect(() => hashPersistedSchema(invalid)).toThrow(/unexpected fields/);
    }
    expect(() => hashMemoryDescriptor({
      ...descriptor(),
      extension: true,
    } as unknown as ResolvedMemoryDescriptor)).toThrow(/unexpected fields/);
  });

  it("rejects missing, duplicate, and unknown region dimensions", () => {
    const base: MemoryRegionKeyInput = {
      descriptor: descriptor(),
      projectSubject: "project://acme/private",
      sessionLineageId: "lineage-secret",
      sessionId: "session-one",
      stableAgentInstanceId: "agent-instance-secret",
      user: { issuer: "issuer-secret", subject: "user-secret", verified: true },
    };
    expect(() => deriveMemoryRegionKey({ ...base, projectSubject: undefined })).toThrow(/project/);
    expect(() => deriveMemoryRegionKey({ ...base, user: undefined })).toThrow(/user/);
    expect(() => deriveMemoryRegionKey({ ...base, sessionLineageId: "" })).toThrow(/lineage/);
    expect(() => deriveMemoryRegionKey({ ...base, extension: "unknown" } as unknown as MemoryRegionKeyInput))
      .toThrow(/unexpected fields/);
    expect(() => hashMemoryDescriptor(descriptor("session", ["project", "project"]))).toThrow(/duplicate/);
  });

  it("pins Unicode schema, descriptor, value, and region hashes", () => {
    const unicodeSchema: PersistedSchema = {
      kind: "struct",
      name: "m\u00e9moire.\u8a3c\u62e0",
      fields: [
        { name: "\u6839\u62e0", schema: { kind: "array", items: { kind: "scalar", name: "text" } } },
        { name: "r\u00e9ponse", schema: { kind: "enum", name: "D\u00e9cision", variants: ["Vrai", "\u507d"] } },
      ],
    };
    const unicodeDescriptor: ResolvedMemoryDescriptor = {
      name: "souvenirs.\u8a18\u61b6",
      schema: unicodeSchema,
      modality: "semantic",
      scopes: ["user", "project"],
      retention: "session",
    };
    const unicodeValue: Value = {
      kind: "struct",
      typeName: "m\u00e9moire.\u8a3c\u62e0",
      trust: "raw",
      fields: new Map([
        ["r\u00e9ponse", { kind: "enumval", enumName: "D\u00e9cision", variant: "\u507d", trust: "raw" }],
        ["\u6839\u62e0", { kind: "array", trust: "raw", items: [{ kind: "text", v: "na\u00efve \u4e16\u754c", trust: "raw" }] }],
      ]),
    };
    const envelope = encodeExactValue(unicodeValue, unicodeSchema);
    const region = deriveMemoryRegionKey({
      descriptor: unicodeDescriptor,
      projectSubject: "projet://\u00e9t\u00e9/\u6771\u4eac",
      sessionLineageId: "lign\u00e9e-\u03b1",
      sessionId: "s\u00e9ance-\u03b2",
      stableAgentInstanceId: "agent-\u03b3",
      user: { issuer: "https://\u00e9metteur.example", subject: "utilisateur-\u03b4", verified: true },
    });
    expect({
      schema: hashPersistedSchema(unicodeSchema),
      descriptor: hashMemoryDescriptor(unicodeDescriptor),
      value: envelope.valueHash,
      region,
    }).toEqual({
      schema: "c65f244450accc173597cebf3088bbebd944ac5de589354101b0f34a4522262c",
      descriptor: "64587570fdfa5e74bf2a6aca3241d40c0d4bce3de94b6b08185592a108c1a11e",
      value: "10faf22f8d255d8fb1f367b32926eb39d11aa3fd7bb15f6b57a2088e42232adc",
      region: "memory-region-v1:44e5624387297be1ddaedc7d838b74ef5d0044a60a5353e8d3935d585c143c50",
    });
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
