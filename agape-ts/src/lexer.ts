// Lexer — Agape source text -> tokens. Follows SPEC.md §2 (lexical structure).

export type Pos = { line: number; col: number };

// A token's `type` is the keyword/operator literal itself (e.g. "agent", "<-", "{"),
// or one of the generic literal/identifier kinds below.
export type TokenType = string;

export interface Token {
  type: TokenType;
  value: string;
  // For an f-string, the parsed segments (literal text vs. embedded expression source).
  fparts?: FStringPart[];
  pos: Pos;
}

export type FStringPart = { kind: "text"; text: string } | { kind: "expr"; src: string };

// §2 keywords (the subset the v0 compiler recognizes). Everything else alpha is an Ident;
// contextual words (by, as, confidence, margin, conformal, about, reach, use, origin, expires…)
// are left as Idents and matched positionally by the parser.
export const KEYWORDS = new Set([
  "int", "float", "bool", "text", "null", "event", "action", "array",
  "agent", "extend", "sync", "struct", "enum",
  "grants", "tool", "read", "write",
  "spawn", "awake", "sleep", "crash", "self", "on", "prompt", "instruction",
  "principal", "policy",
  "when", "if", "else", "return", "retry",
  "decide", "endorse", "perform", "emit", "abstain",
  "find", "where", "select", "from", "match",
  "mem", "forget",
  "all", "any", "quorum", "independent", "dependent",
  "true", "false", "abstained",
  "module", "import", "pub", "interface", "requires",
  "reversible", "say",
]);

// Multi-char operators first (longest match), then single-char.
const OPERATORS = [
  "<-", "->", "|>", "&&", "||", ">=", "<=", "==", "!=",
  "{", "}", "(", ")", "[", "]", ";", ",", ".", ":", "=",
  "+", "-", "*", "/", "<", ">", "!",
  // `~` lexes to an Op token but no grammar rule uses it — the PARSER rejects it (a ParseError, not a
  // LexError): there is no similarity operator; similarity is reached only through `match` (§2/§10).
  "~",
];

export class LexError extends Error {}

export function lex(source: string): Token[] {
  const toks: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;
  const n = source.length;

  const here = (): Pos => ({ line, col });
  const advance = (k = 1) => {
    for (let j = 0; j < k; j++) {
      if (source[i] === "\n") {
        line++;
        col = 1;
      } else {
        col++;
      }
      i++;
    }
  };

  while (i < n) {
    const c = source[i]!;

    // whitespace
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      advance();
      continue;
    }
    // line comment
    if (c === "/" && source[i + 1] === "/") {
      while (i < n && source[i] !== "\n") advance();
      continue;
    }
    // f-string: f"...{expr}..."
    if (c === "f" && source[i + 1] === '"') {
      const pos = here();
      advance(2); // consume f"
      const parts: FStringPart[] = [];
      let text = "";
      while (i < n && source[i] !== '"') {
        const ch = source[i]!;
        if (ch === "\\") {
          text += readEscape();
          continue;
        }
        if (ch === "{") {
          if (text) {
            parts.push({ kind: "text", text });
            text = "";
          }
          advance(); // consume {
          let depth = 1;
          let src = "";
          while (i < n && depth > 0) {
            const e = source[i]!;
            if (e === '"') break; // an interpolation must close (`}`) BEFORE the f-string does (§2)
            if (e === "{") depth++;
            else if (e === "}") {
              depth--;
              if (depth === 0) break;
            }
            src += e;
            advance();
          }
          if (depth !== 0) {
            // unterminated interpolation: emit the (ill-formed) expr part so the PARSER rejects the malformed
            // interpolation expression — a ParseError, not a LexError (§2: braces must parse as expressions).
            parts.push({ kind: "expr", src });
            continue; // the f-string closes at the `"` the outer loop is now positioned on
          }
          advance(); // consume }
          parts.push({ kind: "expr", src });
          continue;
        }
        text += ch;
        advance();
      }
      if (i >= n) throw new LexError(`unterminated f-string at ${pos.line}:${pos.col}`);
      advance(); // closing "
      if (text) parts.push({ kind: "text", text });
      toks.push({ type: "fstring", value: "", fparts: parts, pos });
      continue;
    }
    // string
    if (c === '"') {
      const pos = here();
      advance(); // opening "
      let s = "";
      while (i < n && source[i] !== '"') {
        if (source[i] === "\\") s += readEscape();
        else {
          s += source[i];
          advance();
        }
      }
      if (i >= n) throw new LexError(`unterminated string at ${pos.line}:${pos.col}`);
      advance(); // closing "
      toks.push({ type: "string", value: s, pos });
      continue;
    }
    // number
    if (isDigit(c)) {
      const pos = here();
      let num = "";
      while (i < n && isDigit(source[i]!)) {
        num += source[i];
        advance();
      }
      let isFloat = false;
      if (source[i] === "." && isDigit(source[i + 1] ?? "")) {
        isFloat = true;
        num += ".";
        advance();
        while (i < n && isDigit(source[i]!)) {
          num += source[i];
          advance();
        }
      }
      toks.push({ type: isFloat ? "float" : "int", value: num, pos });
      continue;
    }
    // identifier / keyword
    if (isIdentStart(c)) {
      const pos = here();
      let id = "";
      while (i < n && isIdentPart(source[i]!)) {
        id += source[i];
        advance();
      }
      toks.push({ type: KEYWORDS.has(id) ? id : "ident", value: id, pos });
      continue;
    }
    // operator
    const op = OPERATORS.find((o) => source.startsWith(o, i));
    if (op) {
      const pos = here();
      advance(op.length);
      toks.push({ type: op, value: op, pos });
      continue;
    }

    throw new LexError(`unexpected character ${JSON.stringify(c)} at ${line}:${col}`);
  }

  toks.push({ type: "eof", value: "", pos: here() });
  return toks;

  function readEscape(): string {
    advance(); // consume backslash
    const e = source[i];
    advance();
    switch (e) {
      case "n": return "\n";
      case "t": return "\t";
      case '"': return '"';
      case "\\": return "\\";
      default: throw new LexError(`invalid escape \\${e} at ${line}:${col}`);
    }
  }
}

const isDigit = (c: string) => c >= "0" && c <= "9";
const isIdentStart = (c: string) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
const isIdentPart = (c: string) => isIdentStart(c) || isDigit(c);
