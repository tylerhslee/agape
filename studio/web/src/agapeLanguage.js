// agapeLanguage.js — register Agape (v1.0) as a first-class Monaco language.
//
// This mirrors the shared TextMate grammar (editors/vscode-agape/syntaxes/
// agape.tmLanguage.json) so highlighting is consistent across VS Code, Cursor,
// and Agape Studio. The editor knows Agape's actual v1.0 grammar: the agentic
// keywords (agent/when/catch/emit/verify/decide/grants/spawn/awake), user
// nominal types (struct/enum/event), quorum/aggregation (§12), the somatic
// kernel (while/break/if/import), the send arrow `<-` and pipe `|>`, and the
// event<T> wrapper. Retired v0.x syntax (`~`, `calibrate`, `entail`, `->`) is
// flagged invalid. Token classes map onto the Dark+ palette of the shell.

export const AGAPE_LANG_ID = "agape";

export function registerAgape(monaco) {
  if (monaco.languages.getLanguages().some((l) => l.id === AGAPE_LANG_ID)) return;

  monaco.languages.register({ id: AGAPE_LANG_ID, extensions: [".ag"] });

  monaco.languages.setMonarchTokensProvider(AGAPE_LANG_ID, {
    defaultToken: "",
    // v1.0 keyword set (SPEC §2). Contextual words (as/by/reach/use/origin/
    // expires/of/margin) are deliberately NOT keywords — they lex as identifiers.
    keywords: [
      "agent", "extend", "sync", "struct", "enum", "event", "tool", "principal",
      "grants", "authority", "spawn", "awake", "sleep", "on", "prompt",
      "when", "catch", "case", "if", "else", "return", "retry", "default",
      "verify", "decide", "emit", "find", "where", "select", "from", "match",
      "all", "any", "quorum", "independent", "dependent",
      "while", "break", "import",
    ],
    typeKeywords: [
      "int", "float", "bool", "text", "null", "event", "array",
      // prelude types (§9)
      "Credence", "Principal", "Rule", "Verification", "Entailment",
      "Contradiction", "Neutral", "Event", "Error", "Attestation",
      "QueryResult", "ToolStarted", "ToolResolved", "Delivered", "Resolved",
      "Expired", "DeliveryRefused", "SuccessfulVerification", "FailedVerification",
    ],
    literals: ["true", "false", "null"],
    retired: ["calibrate", "entail"],
    operators: ["<-", "|>", "==", "!=", "<=", ">=", "<", ">", "=", "+", "-", "*", "/", "!"],
    symbols: /[=><!|+\-*/]+/,
    tokenizer: {
      root: [
        // comments — v1.0 has line comments only.
        [/\/\/.*$/, "comment"],
        // f-strings with {interpolation}, then plain strings.
        [/f"/, { token: "string.quote", next: "@fstring" }],
        [/"/, { token: "string.quote", next: "@string" }],
        [/\b\d+\.\d+\b/, "number.float"],
        [/\b\d+\b/, "number"],
        // retired operators (§2): `~` and `->` are removed → invalid.
        [/~|->/, "invalid"],
        [/\bself\b/, "variable.language"],
        // capitalized → type (built-in/prelude or user nominal type).
        [/[A-Z][\w]*/, { cases: { "@typeKeywords": "type", "@default": "type.identifier" } }],
        [/[a-z_]\w*/, {
          cases: {
            "@retired": "invalid",
            "@keywords": "keyword",
            "@typeKeywords": "type",
            "@literals": "keyword.literal",
            "@default": "identifier",
          },
        }],
        [/@symbols/, { cases: { "@operators": "operator", "@default": "" } }],
        [/[{}()\[\]]/, "@brackets"],
        [/[;,.]/, "delimiter"],
      ],
      string: [
        [/[^"]+/, "string"],
        [/"/, { token: "string.quote", next: "@pop" }],
      ],
      fstring: [
        [/\{[^}]*\}/, "variable"],
        [/[^"{]+/, "string"],
        [/"/, { token: "string.quote", next: "@pop" }],
      ],
    },
  });

  monaco.editor.defineTheme("agape-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "keyword", foreground: "c586c0" },
      { token: "keyword.literal", foreground: "569cd6" },
      { token: "type", foreground: "4ec9b0" },
      { token: "type.identifier", foreground: "4ec9b0" },
      { token: "variable.language", foreground: "569cd6" },
      { token: "string", foreground: "ce9178" },
      { token: "string.quote", foreground: "ce9178" },
      { token: "variable", foreground: "9cdcfe" },
      { token: "comment", foreground: "6a9955", fontStyle: "italic" },
      { token: "number", foreground: "b5cea8" },
      { token: "operator", foreground: "d4d4d4" },
      { token: "invalid", foreground: "f48771", fontStyle: "underline" },
    ],
    colors: { "editor.background": "#1e1e1e" },
  });
}
