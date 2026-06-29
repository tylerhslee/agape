// Register Agape as a first-class Monaco language in Studio.
//
// The token provider lives in the separate agape-language-pack repository so
// Studio, VS Code/Cursor, and future docs tooling share one v1.0.2 syntax surface.
import {
  AGAPE_LANG_ID,
  AGAPE_MONARCH_LANGUAGE,
  AGAPE_MONARCH_THEME,
} from "@agape-lang/syntax/monaco";

export { AGAPE_LANG_ID };

export function registerAgape(monaco) {
  if (monaco.languages.getLanguages().some((l) => l.id === AGAPE_LANG_ID)) return;

  monaco.languages.register({
    id: AGAPE_LANG_ID,
    aliases: ["Agape", "agape", "ag"],
    extensions: [".ag"],
  });

  monaco.languages.setLanguageConfiguration(AGAPE_LANG_ID, {
    comments: { lineComment: "//" },
    brackets: [["{", "}"], ["[", "]"], ["(", ")"], ["<", ">"]],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: "<", close: ">", notIn: ["string", "comment"] },
      { open: "\"", close: "\"", notIn: ["string", "comment"] },
    ],
    surroundingPairs: [["{", "}"], ["[", "]"], ["(", ")"], ["<", ">"], ["\"", "\""]],
  });

  monaco.languages.setMonarchTokensProvider(AGAPE_LANG_ID, AGAPE_MONARCH_LANGUAGE);
  monaco.editor.defineTheme("agape-dark", AGAPE_MONARCH_THEME);
}
