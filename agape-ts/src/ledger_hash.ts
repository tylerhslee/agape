import { createHash } from "node:crypto";

export const CANONICAL_LEDGER_VERSION = "sha256-agape-v1-six-field-v2";

const GENESIS_BYTES = createHash("sha256").update("agape/v1", "utf8").digest();
export const CANONICAL_LEDGER_GENESIS = GENESIS_BYTES.toString("hex");

export interface CanonicalLedgerEvent {
  tick: number;
  etype: string;
  subject: string;
  payload?: unknown;
  corr?: string | number | null;
  agent?: string;
}

/** Clone and freeze a JSON payload before it enters the committed journal. */
export function snapshotCanonicalPayload(payload: unknown): unknown {
  if (payload === undefined) return undefined;
  return snapshotJson(payload, "$payload", new Set<object>());
}

/** Serialize exactly the six root fields specified by SPEC 16.2. */
export function canonicalLedgerEventJson(event: CanonicalLedgerEvent): string {
  assertSafeInteger(event.tick, "$event.tick");
  if (event.tick < 0) throw new TypeError("$event.tick must be non-negative");
  if (typeof event.etype !== "string") throw new TypeError("$event.etype must be a string");
  if (typeof event.subject !== "string") throw new TypeError("$event.subject must be a string");
  if (event.agent !== undefined && typeof event.agent !== "string") {
    throw new TypeError("$event.agent must be a string when present");
  }
  if (
    event.corr !== undefined &&
    event.corr !== null &&
    typeof event.corr !== "string" &&
    typeof event.corr !== "number"
  ) {
    throw new TypeError("$event.corr must be a string, finite number, or null");
  }
  if (typeof event.corr === "number") assertFinite(event.corr, "$event.corr");

  return (
    '{"tick":' + jsonNumber(event.tick) +
    ',"etype":' + JSON.stringify(event.etype) +
    ',"subject":' + JSON.stringify(event.subject) +
    ',"payload":' + canonicalJson(event.payload ?? null, "$event.payload", new Set<object>()) +
    ',"corr":' + canonicalJson(event.corr ?? null, "$event.corr", new Set<object>()) +
    ',"agent":' + JSON.stringify(event.agent ?? "") + "}"
  );
}

/** SHA-256(previous digest bytes || exact canonical event UTF-8). */
export function canonicalLedgerHead(events: readonly CanonicalLedgerEvent[]): string {
  let previous = Buffer.from(GENESIS_BYTES);
  for (const event of events) {
    previous = createHash("sha256")
      .update(previous)
      .update(canonicalLedgerEventJson(event), "utf8")
      .digest();
  }
  return previous.toString("hex");
}

function canonicalJson(value: unknown, path: string, ancestors: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      assertFinite(value, path);
      return jsonNumber(value);
    case "object":
      break;
    default:
      throw new TypeError(path + " is not a JSON value");
  }

  if (ancestors.has(value)) throw new TypeError(path + " contains a cycle");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      assertOrdinaryDenseArray(value, path);
      const parts: string[] = [];
      for (let i = 0; i < value.length; i++) {
        parts.push(canonicalJson(value[i], path + "[" + i + "]", ancestors));
      }
      return "[" + parts.join(",") + "]";
    }

    assertPlainRecord(value, path);
    const keys = Object.keys(value).sort(compareCodeUnits);
    return "{" + keys.map((key) =>
      JSON.stringify(key) + ":" +
      canonicalJson((value as Record<string, unknown>)[key], path + "." + key, ancestors)
    ).join(",") + "}";
  } finally {
    ancestors.delete(value);
  }
}

function snapshotJson(value: unknown, path: string, ancestors: Set<object>): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      assertFinite(value, path);
      return value;
    case "object":
      break;
    default:
      throw new TypeError(path + " is not a JSON value");
  }

  if (ancestors.has(value)) throw new TypeError(path + " contains a cycle");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      assertOrdinaryDenseArray(value, path);
      const copy: unknown[] = [];
      for (let i = 0; i < value.length; i++) {
        copy.push(snapshotJson(value[i], path + "[" + i + "]", ancestors));
      }
      return Object.freeze(copy);
    }

    assertPlainRecord(value, path);
    const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value)) {
      const member = (value as Record<string, unknown>)[key];
      if (member === undefined) continue;
      Object.defineProperty(copy, key, {
        value: snapshotJson(member, path + "." + key, ancestors),
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
    return Object.freeze(copy);
  } finally {
    ancestors.delete(value);
  }
}

function assertPlainRecord(value: object, path: string): void {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(path + " must be a plain JSON object");
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError(path + " must not contain symbol properties");
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(path + "." + key + " must be an enumerable data property");
    }
  }
}

function assertOrdinaryDenseArray(value: unknown[], path: string): void {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(path + " must be an ordinary array");
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError(path + " must not contain symbol properties");
  }
  const names = Object.getOwnPropertyNames(value);
  for (let i = 0; i < value.length; i++) {
    if (!Object.hasOwn(value, i)) throw new TypeError(path + " must not be sparse");
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(path + "[" + i + "] must be an enumerable data property");
    }
  }
  if (names.some((name) => name !== "length" && !isArrayIndex(name, value.length))) {
    throw new TypeError(path + " must not contain non-index properties");
  }
}

function isArrayIndex(name: string, length: number): boolean {
  if (!/^(0|[1-9][0-9]*)$/.test(name)) return false;
  const index = Number(name);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === name;
}

function assertFinite(value: number, path: string): void {
  if (!Number.isFinite(value)) throw new TypeError(path + " must be a finite JSON number");
}

function assertSafeInteger(value: number, path: string): void {
  assertFinite(value, path);
  if (!Number.isSafeInteger(value)) throw new TypeError(path + " must be a safe integer");
}

function jsonNumber(value: number): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new TypeError("value must be a finite JSON number");
  }
  const engine = encoded.replace("e+", "e");
  if (value === 0) return "0"; // JSON normalizes -0, and 0 is the shortest canonical spelling.

  // JSON.stringify supplies the engine's shortest round-tripping digits. Reposition only that digit
  // sequence into fixed form and every possible scientific mantissa placement, validate each with
  // Number(), and choose the shortest. Equal-length ties retain the engine form; among shorter
  // generated ties, fixed wins first, then the leftmost decimal point from ascending k.
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e(-?\d+))?$/.exec(engine);
  if (!match) return engine;
  const sign = match[1]!;
  const whole = match[2]!;
  const fraction = match[3] ?? "";
  const exponentText = match[4];
  const digits = whole + fraction;
  const firstSignificant = digits.search(/[1-9]/);
  if (firstSignificant < 0) return "0";
  const significant = digits.slice(firstSignificant).replace(/0+$/, "");
  const exponent = Number(exponentText ?? "0") + whole.length - 1 - firstSignificant;
  const decimalAt = exponent + 1;
  const fixed =
    decimalAt <= 0
      ? sign + "0." + "0".repeat(-decimalAt) + significant
      : decimalAt >= significant.length
        ? sign + significant + "0".repeat(decimalAt - significant.length)
        : sign + significant.slice(0, decimalAt) + "." + significant.slice(decimalAt);
  let best = engine;
  const candidates = [fixed];
  for (let k = 1; k <= significant.length; k++) {
    const mantissa = k === significant.length
      ? significant
      : significant.slice(0, k) + "." + significant.slice(k);
    const adjustedExponent = exponent - (k - 1);
    candidates.push(sign + mantissa + (adjustedExponent === 0 ? "" : "e" + adjustedExponent));
  }
  for (const candidate of candidates) {
    if (Number(candidate) === value && candidate.length < best.length) best = candidate;
  }
  return best;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
