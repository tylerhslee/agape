# @agape-lang/syntax

Canonical syntax definitions for Agape language specification v1.0.0-beta.2026.7.16.0.

This package is the shared source for:

- VS Code / Cursor TextMate highlighting (`syntaxes/agape.tmLanguage.json`)
- Agape Studio's Monaco highlighting (`monaco/agape.monarch.js`)
- docs-site renderers such as Shiki, which can consume the TextMate grammar

Use the fenced language id `agape` in Markdown. Inside Agape source, `prompt { ... }` embeds Markdown and keeps `${expr}` interpolation as Agape code:

````md
```agape
text guide = md "guide.md";
text answer = self <- prompt {
# Task

${guide}
};
```
````

GitHub will render that fence as plain text until Agape is accepted by GitHub
Linguist, but docs sites and editors can use this package today.
