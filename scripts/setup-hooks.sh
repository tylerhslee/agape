#!/usr/bin/env bash
# core.hooksPath is per-clone and NOT set by `git clone`, so every fresh clone
# must run this once to activate the tracked hooks in .githooks/. Safe to re-run.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
git config core.hooksPath .githooks
echo "core.hooksPath -> .githooks (pre-commit/commit-msg hooks are now active for this clone)"
