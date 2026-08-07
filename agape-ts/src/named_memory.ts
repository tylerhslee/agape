import { createHash } from "node:crypto";
import type { Value } from "./runtime.js";

type PersistedScalar = "text" | "int" | "float" | "bool" | "null";

export type PersistedSchema =
  | { kind: "scalar"; name: PersistedScalar }
  | { kind: "enum"; name: string; variants: readonly string[] }
  | { kind: "array"; items: PersistedSchema }
  | {
      kind: "struct";
      name: string;
      fields: readonly { name: string; schema: PersistedSchema }[];
    };

export interface ResolvedMemoryDescriptor {
  name: string;
  schema: PersistedSchema;
  modality: "opaque" | "episodic" | "semantic";
  scopes: readonly ("project" | "user")[];
  retention: "session" | "durable";
}

export interface MemoryRegionKeyInput {
  descriptor: ResolvedMemoryDescriptor;
  projectSubject?: string;
  sessionLineageId: string;
  sessionId: string;
  stableAgentInstanceId: string;
  user?: {
    issuer: string;
    subject: string;
    verified: true;
  };
}

export type PersistedValueWire =
  | { kind: "text"; value: string }
  | { kind: "int"; value: string }
  | { kind: "float"; bits: string }
  | { kind: "bool"; value: boolean }
  | { kind: "null" }
  | { kind: "enum"; name: string; variant: string }
  | { kind: "array"; items: PersistedValueWire[] }
  | { kind: "struct"; name: string; fields: [string, PersistedValueWire][] };

export interface ExactValueEnvelope {
  version: 1;
  schemaHash: string;
  valueHash: string;
  value: PersistedValueWire;
}

function bytewiseCompare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function assertName(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must not be blank`);
}

function assertOwnKeys(value: object, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort(bytewiseCompare);
  const canonical = [...expected].sort(bytewiseCompare);
  if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) {
    throw new Error(`${label} has unexpected fields`);
  }
}

function canonicalSchema(schema: PersistedSchema, active = new Set<PersistedSchema>()): unknown {
  const kind = (schema as { kind?: unknown }).kind;
  if (!["scalar", "enum", "array", "struct"].includes(String(kind))) {
    throw new Error(`unsupported persisted schema kind ${String(kind)}`);
  }
  if (active.has(schema)) throw new Error("persisted schemas must not contain object cycles");
  active.add(schema);
  try {
    switch (schema.kind) {
      case "scalar":
        assertOwnKeys(schema, ["kind", "name"], "persisted scalar schema");
        if (!["text", "int", "float", "bool", "null"].includes(schema.name)) {
          throw new Error(`unsupported persisted scalar ${String(schema.name)}`);
        }
        return { kind: "scalar", name: schema.name };
      case "enum": {
        assertOwnKeys(schema, ["kind", "name", "variants"], "persisted enum schema");
        if (!Array.isArray(schema.variants)) throw new Error("persisted enum variants must be an array");
        assertName(schema.name, "enum name");
        const seen = new Set<string>();
        for (const variant of schema.variants) {
          assertName(variant, "enum variant");
          if (seen.has(variant)) throw new Error(`duplicate enum variant ${variant}`);
          seen.add(variant);
        }
        if (schema.variants.length === 0) throw new Error("persisted enums require at least one variant");
        return { kind: "enum", name: schema.name, variants: [...schema.variants] };
      }
      case "array":
        assertOwnKeys(schema, ["items", "kind"], "persisted array schema");
        return { kind: "array", items: canonicalSchema(schema.items, active) };
      case "struct": {
        assertOwnKeys(schema, ["fields", "kind", "name"], "persisted struct schema");
        if (!Array.isArray(schema.fields)) throw new Error("persisted struct fields must be an array");
        assertName(schema.name, "struct name");
        const sorted = [...schema.fields].sort((a, b) => bytewiseCompare(a.name, b.name));
        const seen = new Set<string>();
        const fields = sorted.map((field) => {
          assertOwnKeys(field, ["name", "schema"], "persisted struct field");
          assertName(field.name, "struct field name");
          if (seen.has(field.name)) throw new Error(`duplicate struct field ${field.name}`);
          seen.add(field.name);
          return { name: field.name, schema: canonicalSchema(field.schema, active) };
        });
        return { kind: "struct", name: schema.name, fields };
      }
    }
  } finally {
    active.delete(schema);
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON does not accept non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort(bytewiseCompare);
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new Error(`unsupported canonical value ${typeof value}`);
}

function sha256(domain: string, value: unknown): string {
  return createHash("sha256")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

export function hashPersistedSchema(schema: PersistedSchema): string {
  return sha256("agape.persisted-schema.v1", canonicalSchema(schema));
}

function canonicalDescriptor(descriptor: ResolvedMemoryDescriptor): unknown {
  assertOwnKeys(descriptor, ["modality", "name", "retention", "schema", "scopes"], "memory descriptor");
  if (!["opaque", "episodic", "semantic"].includes(descriptor.modality)) {
    throw new Error(`unsupported memory modality ${String(descriptor.modality)}`);
  }
  assertName(descriptor.name, "memory name");
  assertName(descriptor.modality, "memory modality");
  if (descriptor.retention !== "session" && descriptor.retention !== "durable") {
    throw new Error(`unsupported memory retention ${String(descriptor.retention)}`);
  }
  if (!Array.isArray(descriptor.scopes)) throw new Error("memory descriptor scopes must be an array");
  const scopes = [...descriptor.scopes].sort(bytewiseCompare);
  if (scopes.length === 0) throw new Error("memory descriptors require at least one scope");
  const seen = new Set<string>();
  for (const scope of scopes) {
    if (scope !== "project" && scope !== "user") throw new Error(`unsupported memory scope ${String(scope)}`);
    if (seen.has(scope)) throw new Error(`duplicate memory scope ${scope}`);
    seen.add(scope);
  }
  return {
    version: 1,
    name: descriptor.name,
    schemaHash: hashPersistedSchema(descriptor.schema),
    modality: descriptor.modality,
    scopes,
    retention: descriptor.retention,
  };
}

export function hashMemoryDescriptor(descriptor: ResolvedMemoryDescriptor): string {
  return sha256("agape.memory-descriptor.v1", canonicalDescriptor(descriptor));
}

function floatToBits(value: number): string {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value, false);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bitsToFloat(bits: string): number {
  if (!/^[0-9a-f]{16}$/.test(bits)) throw new Error("float payload must contain exactly 16 lowercase hex digits");
  const bytes = new Uint8Array(8);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(bits.slice(index * 2, index * 2 + 2), 16);
  }
  return new DataView(bytes.buffer).getFloat64(0, false);
}

function sortedFields(schema: Extract<PersistedSchema, { kind: "struct" }>): typeof schema.fields {
  canonicalSchema(schema);
  return [...schema.fields].sort((a, b) => bytewiseCompare(a.name, b.name));
}

function encodeValue(value: Value, schema: PersistedSchema): PersistedValueWire {
  switch (schema.kind) {
    case "scalar":
      switch (schema.name) {
        case "text":
          if (value.kind !== "text") throw new Error(`expected text, received ${value.kind}`);
          return { kind: "text", value: value.v };
        case "int":
          if (value.kind !== "int" || !Number.isSafeInteger(value.v)) {
            throw new Error(`expected a safe int, received ${value.kind}`);
          }
          return { kind: "int", value: value.v.toString(10) };
        case "float":
          if (value.kind !== "float") throw new Error(`expected float, received ${value.kind}`);
          return { kind: "float", bits: floatToBits(value.v) };
        case "bool":
          if (value.kind !== "bool") throw new Error(`expected bool, received ${value.kind}`);
          return { kind: "bool", value: value.v };
        case "null":
          if (value.kind !== "null") throw new Error(`expected null, received ${value.kind}`);
          return { kind: "null" };
      }
    case "enum":
      if (value.kind !== "enumval") throw new Error(`expected enum ${schema.name}, received ${value.kind}`);
      if (value.enumName !== schema.name) throw new Error(`expected enum ${schema.name}, received ${value.enumName}`);
      if (!schema.variants.includes(value.variant)) throw new Error(`unknown ${schema.name} variant ${value.variant}`);
      return { kind: "enum", name: schema.name, variant: value.variant };
    case "array":
      if (value.kind !== "array") throw new Error(`expected array, received ${value.kind}`);
      return { kind: "array", items: value.items.map((item) => encodeValue(item, schema.items)) };
    case "struct": {
      if (value.kind !== "struct") throw new Error(`expected struct ${schema.name}, received ${value.kind}`);
      if (value.typeName !== undefined && value.typeName !== schema.name) {
        throw new Error(`expected struct ${schema.name}, received ${value.typeName}`);
      }
      const fields = sortedFields(schema);
      if (value.fields.size !== fields.length) throw new Error(`struct ${schema.name} field set does not match schema`);
      return {
        kind: "struct",
        name: schema.name,
        fields: fields.map((field) => {
          const fieldValue = value.fields.get(field.name);
          if (fieldValue === undefined) throw new Error(`struct ${schema.name} is missing field ${field.name}`);
          return [field.name, encodeValue(fieldValue, field.schema)];
        }),
      };
    }
  }
}

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function assertKeys(record: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(record).sort(bytewiseCompare);
  const canonical = [...expected].sort(bytewiseCompare);
  if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) {
    throw new Error(`${label} has unexpected fields`);
  }
}

function decodeValue(encoded: unknown, schema: PersistedSchema): Value {
  const record = assertRecord(encoded, "encoded value");
  switch (schema.kind) {
    case "scalar":
      switch (schema.name) {
        case "text":
          assertKeys(record, ["kind", "value"], "encoded text");
          if (record.kind !== "text" || typeof record.value !== "string") throw new Error("invalid encoded text");
          return { kind: "text", v: record.value, trust: "raw" };
        case "int": {
          assertKeys(record, ["kind", "value"], "encoded int");
          if (record.kind !== "int" || typeof record.value !== "string" || !/^-?(0|[1-9][0-9]*)$/.test(record.value)) {
            throw new Error("invalid encoded int");
          }
          const value = Number(record.value);
          if (!Number.isSafeInteger(value) || value.toString(10) !== record.value) throw new Error("encoded int is not canonical");
          return { kind: "int", v: value, trust: "raw" };
        }
        case "float":
          assertKeys(record, ["bits", "kind"], "encoded float");
          if (record.kind !== "float" || typeof record.bits !== "string") throw new Error("invalid encoded float");
          return { kind: "float", v: bitsToFloat(record.bits), trust: "raw" };
        case "bool":
          assertKeys(record, ["kind", "value"], "encoded bool");
          if (record.kind !== "bool" || typeof record.value !== "boolean") throw new Error("invalid encoded bool");
          return { kind: "bool", v: record.value, trust: "raw" };
        case "null":
          assertKeys(record, ["kind"], "encoded null");
          if (record.kind !== "null") throw new Error("invalid encoded null");
          return { kind: "null", trust: "raw" };
      }
    case "enum":
      assertKeys(record, ["kind", "name", "variant"], "encoded enum");
      if (record.kind !== "enum" || record.name !== schema.name || typeof record.variant !== "string") {
        throw new Error(`invalid encoded enum ${schema.name}`);
      }
      if (!schema.variants.includes(record.variant)) throw new Error(`unknown ${schema.name} variant ${record.variant}`);
      return { kind: "enumval", enumName: schema.name, variant: record.variant, trust: "raw" };
    case "array":
      assertKeys(record, ["items", "kind"], "encoded array");
      if (record.kind !== "array" || !Array.isArray(record.items)) throw new Error("invalid encoded array");
      return { kind: "array", items: record.items.map((item) => decodeValue(item, schema.items)), trust: "raw" };
    case "struct": {
      assertKeys(record, ["fields", "kind", "name"], "encoded struct");
      if (record.kind !== "struct" || record.name !== schema.name || !Array.isArray(record.fields)) {
        throw new Error(`invalid encoded struct ${schema.name}`);
      }
      const schemaFields = sortedFields(schema);
      if (record.fields.length !== schemaFields.length) throw new Error(`encoded struct ${schema.name} field set does not match schema`);
      const fields = new Map<string, Value>();
      for (let index = 0; index < schemaFields.length; index += 1) {
        const pair = record.fields[index];
        const field = schemaFields[index]!;
        if (!Array.isArray(pair) || pair.length !== 2 || pair[0] !== field.name) {
          throw new Error(`encoded struct ${schema.name} fields are not canonical`);
        }
        fields.set(field.name, decodeValue(pair[1], field.schema));
      }
      return { kind: "struct", typeName: schema.name, fields, trust: "raw" };
    }
  }
}

export function encodeExactValue(value: Value, schema: PersistedSchema): ExactValueEnvelope {
  const encoded = encodeValue(value, schema);
  return {
    version: 1,
    schemaHash: hashPersistedSchema(schema),
    valueHash: sha256("agape.persisted-value.v1", encoded),
    value: encoded,
  };
}

export function decodeExactValue(envelope: ExactValueEnvelope, schema: PersistedSchema): Value {
  const record = assertRecord(envelope, "persisted value envelope");
  assertKeys(record, ["schemaHash", "value", "valueHash", "version"], "persisted value envelope");
  if (record.version !== 1) throw new Error("unsupported persisted value envelope version");
  const schemaHash = hashPersistedSchema(schema);
  if (record.schemaHash !== schemaHash) throw new Error("persisted value schema hash mismatch");
  const valueHash = sha256("agape.persisted-value.v1", record.value);
  if (record.valueHash !== valueHash) throw new Error("persisted value hash mismatch");
  return decodeValue(record.value, schema);
}

function opaqueIdentity(domain: string, value: string): string {
  assertName(value, domain);
  return sha256(`agape.memory-region.${domain}.v1`, value);
}

export function deriveMemoryRegionKey(input: MemoryRegionKeyInput): string {
  assertOwnKeys(input, [
    "descriptor", "projectSubject", "sessionLineageId", "sessionId",
    "stableAgentInstanceId", "user",
  ].filter((key) => Object.prototype.hasOwnProperty.call(input, key)), "memory region key input");
  const { descriptor } = input;
  const scopes = [...descriptor.scopes].sort(bytewiseCompare);
  canonicalDescriptor(descriptor);
  assertName(input.sessionLineageId, "lineage");
  assertName(input.stableAgentInstanceId, "agent instance");
  if (input.user !== undefined) {
    assertOwnKeys(input.user, ["issuer", "subject", "verified"], "verified user identity");
    if (input.user.verified !== true) throw new Error("user identity must be verified");
    assertName(input.user.issuer, "user issuer");
    assertName(input.user.subject, "user subject");
  }
  const dimensions: Record<string, string> = {
    descriptor: hashMemoryDescriptor(descriptor),
    lineage: opaqueIdentity("lineage", input.sessionLineageId),
    agent: opaqueIdentity("agent-instance", input.stableAgentInstanceId),
  };
  if (descriptor.retention === "session") {
    assertName(input.sessionId, "session");
    dimensions.session = opaqueIdentity("session", input.sessionId);
  }
  if (scopes.includes("project")) {
    if (input.projectSubject === undefined) throw new Error("project-scoped memory requires a project subject");
    assertName(input.projectSubject, "project subject");
    dimensions.project = opaqueIdentity("project", input.projectSubject);
  }
  if (scopes.includes("user")) {
    if (input.user === undefined || !input.user.verified) {
      throw new Error("user-scoped memory requires a verified user identity");
    }
    dimensions.user = sha256("agape.memory-region.user.v1", {
      issuer: opaqueIdentity("user-issuer", input.user.issuer),
      subject: opaqueIdentity("user-subject", input.user.subject),
    });
  }
  return `memory-region-v1:${sha256("agape.memory-region.key.v1", dimensions)}`;
}
