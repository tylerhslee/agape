# Agape for VS Code & Cursor

Syntax highlighting for the **Agape** language (v1.0) — `.ag` files. Cursor is a
VS Code fork, so this same extension works in both.

The TextMate grammar in [`syntaxes/agape.tmLanguage.json`](syntaxes/agape.tmLanguage.json)
is the **single source of truth** for Agape highlighting: VS Code and Cursor load
it directly, and Agape Studio's Monaco editor mirrors the same token model
(`studio/web/src/agapeLanguage.js`), so highlighting is consistent everywhere.

## What it highlights (v1.0, SPEC §2)

- Comments (`//`), strings, and **f-strings** with `{expr}` interpolation highlighted.
- All v1.0 keywords, grouped so themes can color them distinctly: declarations
  (`agent struct enum event tool principal`), modifiers (`sync extend`), control
  (`when catch case if else retry …`), gates (`verify decide emit`), capability
  (`grants authority`), queries (`find where select from match`), aggregation
  (`all any quorum independent dependent`), lifecycle (`spawn awake sleep on prompt`).
- Built-in types and prelude types (`Credence Principal Verdict Verification …`);
  user nominal types (capitalized identifiers) as type names.
- The send arrow `<-` and pipe `|>` as operators.
- **Retired v0.x syntax flagged as errors:** `~`, `calibrate`, `entail`, and `->`
  are removed in v1.0, so the grammar marks them `invalid.illegal` — your editor
  shows them as mistakes, not valid code.

## Install

**Quick (local, no packaging):** copy or symlink this folder into your extensions dir:

```bash
# VS Code
cp -r editors/vscode-agape ~/.vscode/extensions/agape-0.1.0
# Cursor
cp -r editors/vscode-agape ~/.cursor/extensions/agape-0.1.0
```

Then reload the editor. Open any `.ag` file.

**Packaged (.vsix):**

```bash
npm install -g @vscode/vsce
cd editors/vscode-agape
vsce package          # → agape-0.1.0.vsix
# then: Extensions ▸ … ▸ Install from VSIX…  (works in VS Code and Cursor)
```

## Roadmap

Highlighting is the first slice. Real **autocomplete, live diagnostics, hover, and
go-to-definition** come from an Agape language server built on the `agape-rs`
compiler front-end (LSP), consumed by VS Code/Cursor (extension) and Studio
(`monaco-languageclient`) over the same backend.
