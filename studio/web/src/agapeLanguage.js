// agapeLanguage.js — register Agape (v1.0.0) as a first-class Monaco language.
//
// This mirrors the shared TextMate grammar (editors/vscode-agape/syntaxes/
// agape.tmLanguage.json) so highlighting is consistent across VS Code, Cursor,
// and Agape Studio. The editor knows Agape's actual v1.0.0 grammar (SPEC §2):
// the declarations (agent/struct/enum/tool/principal/policy), the lifecycle
// (spawn/awake/sleep/on/prompt), the gate (endorse/attest/perform/emit/abstain),
// queries (find/where/select/from/match), quorum/aggregation (§12), the scalar +
// spine-wrapper types (event<T>/action), the send arrow `<-` and pipe `|>`.
// Retired v0.x syntax (`~`, `->`, `calibrate`, `entail`) is flagged invalid.
// Token classes map onto the Dark+ palette of the shell.

export const AGAPE_LANG_ID = "agape";

export function registerAgape(monaco) {
  if (monaco.languages.getLanguages().some((l) => l.id === AGAPE_LANG_ID)) return;

  monaco.languages.register({ id: AGAPE_LANG_ID, extensions: [".ag"] });

  monaco.languages.setMonarchTokensProvider(AGAPE_LANG_ID, {
    defaultToken: "",
    // v1.0.0 keyword set (SPEC §2). Contextual words (as/by/about/reach/use/
    // origin/expires/of/confidence/margin/conformal/over) are deliberately NOT
    // keywords — they lex as identifiers, meaningful only in position.
    keywords: [
      "agent", "extend", "sync", "struct", "enum", "tool", "principal", "policy",
      "grants", "read", "write", "spawn", "awake", "sleep", "on", "prompt",
      "when", "case", "if", "else", "return", "retry", "default",
      "endorse", "attest", "perform", "emit", "abstain",
      "find", "where", "select", "from", "match",
      "all", "any", "quorum", "independent", "dependent",
    ],
    typeKeywords: [
      "int", "float", "bool", "text", "event", "action", "array",
      // prelude types (§9)
      "Credence", "Decision", "Entailment", "Contradiction", "Neutral",
      "Principal", "Rule", "Event", "Error", "Attestation", "Decided",
      "Abstained", "AgentCrashed", "QueryResult", "ToolStarted", "ToolResolved",
      "Delivered", "Resolved", "Expired", "DeliveryRefused",
    ],
    literals: ["true", "false", "null"],
    retired: ["calibrate", "entail"],
    operators: ["<-", "|>", "==", "!=", "<=", ">=", "<", ">", "=", "+", "-", "*", "/", "!"],
    symbols: /[=><!|+\-*/]+/,
    tokenizer: {
      root: [
        // comments — v1.0.0 has line comments only (§2).
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
        [/[;,.:]/, "delimiter"],
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
