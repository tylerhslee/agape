export function validateConfidence(value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? null
    : "Confidence threshold must be a finite JSON number between 0 and 1; strings, booleans, and null are not accepted.";
}

export function validateLiteralInterpolations(original: string, value: unknown): string | null {
  if (typeof value !== "string") return "Value must be text.";
  const expected = interpolationMultiset(original);
  const actual = interpolationMultiset(value);
  if (expected.length === actual.length && expected.every((token, index) => token === actual[index])) return null;
  return `Interpolation tokens must be preserved exactly (including duplicates). Expected ${formatSet(expected)}; received ${formatSet(actual)}.`;
}

function interpolationMultiset(value: string): string[] {
  const tokens: string[] = [];
  for (let i = 0; i < value.length - 1; i++) {
    if (value[i] === "\\") { i++; continue; }
    if (value[i] !== "$" || value[i + 1] !== "{") continue;
    const start = i;
    i += 2;
    let depth = 1;
    let quoted = false;
    for (; i < value.length && depth > 0; i++) {
      const ch = value[i];
      if (ch === "\\") { i++; continue; }
      if (ch === '"') { quoted = !quoted; continue; }
      if (quoted) continue;
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    tokens.push(depth === 0 ? value.slice(start, i) : value.slice(start));
    i--;
  }
  return tokens.sort();
}

function formatSet(values: string[]): string {
  return values.length ? JSON.stringify(values) : "no interpolation tokens";
}
