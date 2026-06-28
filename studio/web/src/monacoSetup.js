// monacoSetup.js — bundle one Monaco locally and point @monaco-editor/react at it.
//
// By default @monaco-editor/react fetches Monaco from a CDN. That's two problems:
// the studio editor then needs the network, and monaco-vim (which binds against
// the *bundled* monaco-editor) would be talking to a different Monaco instance
// than the editor — so vim breaks. Configuring one bundled instance fixes both:
// the editor and the vim keymap share it, and the editor works fully offline.
//
// Imported for its side effects from main.jsx, before anything mounts an editor.
import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

// We only use a custom Monarch language (Agape) + markdown; neither needs a
// language-service worker, so the base editor worker covers every request.
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

loader.config({ monaco });
