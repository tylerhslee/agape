#!/usr/bin/env python3
"""
Agape v1.0.0-alpha.2026.7.3.0 conformance suite — manifest builder.

The `.ag` test files under tests/<section>/ are the single source of truth: edit
them directly. Each carries a `//!` header (id/section/expect/error/matchers/spec/
note) terminated by `//! ---`, followed by the program under test. This script
PARSES those headers and derives the two indexes — MANIFEST.toml (machine-readable)
and MANIFEST.md (human table) — so the indexes can never drift from the tests.

It does NOT write or modify any `.ag` file; it only reads them and writes the two
MANIFEST.* files. It also validates the headers (see check()).

Header keys: id, section, expect (accept|reject|blocked), error (iff reject),
spine|contains|absent|order (ledger matchers; `; `-separated),
warning|absent_warning (runtime warning matchers; `; `-separated), schema (compiler schema assertions;
`; `-separated), question (iff blocked), spec, note.
Run directives (the §17.5 harness contract): provider (empty|schema_violation|credence(...)),
principal (grant|deny — the identity-dependency ruling for `decide c by p`), manifest
(key=value; `; `-separated; e.g. `tools.search.driver=mcp`), replay (chain_head_equal),
modules (companion module filenames; `; `-separated; live in a sibling <id>.d/ dir — v1.1.0),
packages (name=path/to/lib.ag package roots under <id>.d/).
Error classes: LexError ParseError TypeError ColorViolation TaintViolation
AuthorityViolation ExhaustivenessError ConfigError ModuleError VisibilityError InterfaceError GateError.

Run:  python3 build_manifests.py            # rebuild MANIFEST.toml + MANIFEST.md
      python3 build_manifests.py --check    # validate + verify manifests are up to date (CI)
"""
import glob
import os
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
TESTS_DIR = os.path.join(ROOT, "tests")

MATCHER_KEYS = ("ledger", "spine", "contains", "absent", "order")
WARNING_KEYS = ("warning", "absent_warning")
SCHEMA_KEYS = ("schema",)
DIRECTIVE_LIST_KEYS = ("manifest", "modules", "packages")   # `;`-separated; configure the run / list companion modules/packages
EXPECTS = {"accept", "reject", "blocked"}
ERROR_CLASSES = {"LexError", "ParseError", "TypeError", "ColorViolation",
                 "TaintViolation", "AuthorityViolation", "ExhaustivenessError",
                 "ConfigError",
                 # v1.1.0 library layer + gate:
                 "ModuleError", "VisibilityError", "InterfaceError", "GateError"}
# Harness directives — the §17.5 test-mode contract a conformant runtime must honor.
PROVIDER_MODES = {"empty", "schema_violation"}   # plus a scripted `credence(...)` form
PRINCIPAL_MODES = {"grant", "deny"}   # the identity-dependency ruling for `decide c by p`
REPLAY_MODES = {"chain_head_equal"}


def parse_ag(path):
    """Read one .ag file's `//!` header into a dict; lists for matcher keys."""
    fields = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            if not line.startswith("//!"):
                break                       # body started; header is contiguous at top
            content = line[3:].strip()
            if content == "---":
                break                       # header terminator
            if ":" not in content:
                continue
            key, _, val = content.partition(":")
            key, val = key.strip(), val.strip()
            if key in MATCHER_KEYS or key in WARNING_KEYS or key in SCHEMA_KEYS or key in DIRECTIVE_LIST_KEYS:
                fields[key] = [x.strip() for x in val.split(";") if x.strip()]
            else:
                fields[key] = val
    return fields


def load_tests():
    """Parse every test in directory order (section sorted, then file sorted)."""
    tests = []
    for path in sorted(glob.glob(os.path.join(TESTS_DIR, "*", "*.ag"))):
        section = os.path.basename(os.path.dirname(path))
        stem = os.path.splitext(os.path.basename(path))[0]
        t = parse_ag(path)
        t["_path"] = f"tests/{section}/{stem}.ag"
        t.setdefault("id", stem)
        t.setdefault("section", section)
        # validation — fail loud on a malformed or drifted header
        assert t["id"] == stem, f"{path}: header id {t['id']!r} != filename {stem!r}"
        assert t["section"] == section, f"{path}: header section {t['section']!r} != dir {section!r}"
        assert t.get("expect") in EXPECTS, f"{path}: bad/missing expect {t.get('expect')!r}"
        assert t.get("spec"), f"{path}: missing spec clause"
        # version gating (the suite "Versions" contract): `since`/`until` are
        # `major.minor`; a build of version V runs a test iff since <= V <= until.
        for vk in ("since", "until"):
            if t.get(vk):
                parts = t[vk].split(".")
                assert len(parts) == 2 and all(p.isdigit() for p in parts), \
                    f"{path}: bad {vk} {t[vk]!r} (want major.minor, e.g. 1.1)"
        if t["expect"] == "reject":
            assert t.get("error") in ERROR_CLASSES, f"{path}: reject needs a known error class, got {t.get('error')!r}"
        if t["expect"] == "blocked":
            assert t.get("question"), f"{path}: blocked test needs a question"
        # harness-directive validation (the §16.5 contract)
        if t.get("provider"):
            p = t["provider"]
            assert p in PROVIDER_MODES or p.startswith("credence("), f"{path}: bad provider mode {p!r}"
        if t.get("principal"):
            assert t["principal"] in PRINCIPAL_MODES, f"{path}: bad principal mode {t['principal']!r}"
        if t.get("replay"):
            assert t["replay"] in REPLAY_MODES, f"{path}: bad replay mode {t['replay']!r}"
        for m in t.get("manifest", []):
            assert "=" in m, f"{path}: manifest fixture needs key=value, got {m!r}"
        for p in t.get("packages", []):
            assert "=" in p, f"{path}: package fixture needs name=path, got {p!r}"
        tests.append(t)
    ids = [t["id"] for t in tests]
    dupes = {i for i in ids if ids.count(i) > 1}
    assert not dupes, f"duplicate ids: {sorted(dupes)}"
    return tests


def toml_escape(s):
    return s.replace("\\", "\\\\").replace('"', '\\"')


def render_toml(tests):
    L = ["# Agape v1.0.0-alpha.2026.7.3.0 conformance manifest (generated by build_manifests.py from the .ag headers).",
         "# A conformant implementation must satisfy every non-blocked test.",
         "schema = 1", ""]
    for t in tests:
        L.append("[[test]]")
        L.append(f'id = "{t["id"]}"')
        L.append(f'section = "{t["section"]}"')
        L.append(f'path = "{t["_path"]}"')
        for k in ("since", "until"):
            if t.get(k):
                L.append(f'{k} = "{t[k]}"')
        L.append(f'expect = "{t["expect"]}"')
        if t["expect"] == "reject":
            L.append(f'error = "{t["error"]}"')
        for k in MATCHER_KEYS:
            if t.get(k):
                arr = ", ".join(f'"{toml_escape(x)}"' for x in t[k])
                L.append(f"{k} = [{arr}]")
        for k in WARNING_KEYS:
            if t.get(k):
                arr = ", ".join(f'"{toml_escape(x)}"' for x in t[k])
                L.append(f"{k} = [{arr}]")
        for k in SCHEMA_KEYS:
            if t.get(k):
                arr = ", ".join(f'"{toml_escape(x)}"' for x in t[k])
                L.append(f"{k} = [{arr}]")
        for k in DIRECTIVE_LIST_KEYS:
            if t.get(k):
                arr = ", ".join(f'"{toml_escape(x)}"' for x in t[k])
                L.append(f"{k} = [{arr}]")
        for k in ("provider", "principal", "replay"):
            if t.get(k):
                L.append(f'{k} = "{toml_escape(t[k])}"')
        if t["expect"] == "blocked":
            L.append(f'question = "{toml_escape(" ".join(t["question"].split()))}"')
        L.append(f'spec = "{toml_escape(t["spec"])}"')
        if t.get("note"):
            L.append(f'note = "{toml_escape(" ".join(t["note"].split()))}"')
        L.append("")
    return "\n".join(L)


def render_md(tests):
    counts = {}
    for t in tests:
        counts[t["expect"]] = counts.get(t["expect"], 0) + 1
    md = ["# Agape v1.0.0-alpha.2026.7.3.0 — Conformance Test Index\n",
          f"**{len(tests)} tests** — " + ", ".join(f"{k}: {v}" for k, v in sorted(counts.items())) + "\n",
          "A conformant implementation must satisfy every `accept`/`reject` test "
          "(rejects with the declared error class; accepts matching any asserted spine).\n"]
    by = {}
    for t in tests:
        by.setdefault(t["section"], []).append(t)
    for sec in sorted(by):
        md.append(f"\n## {sec}\n")
        md.append("| id | expect | error | spec |")
        md.append("|---|---|---|---|")
        for t in by[sec]:
            md.append(f"| `{t['id']}` | {t['expect']} | {t.get('error', '—')} | {t['spec']} |")
    return "\n".join(md) + "\n"


def main():
    check = "--check" in sys.argv[1:]
    tests = load_tests()
    toml, md = render_toml(tests), render_md(tests)
    targets = {os.path.join(ROOT, "MANIFEST.toml"): toml,
               os.path.join(ROOT, "MANIFEST.md"): md}
    if check:
        stale = []
        for path, want in targets.items():
            have = open(path, encoding="utf-8").read() if os.path.exists(path) else None
            if have != want:
                stale.append(os.path.basename(path))
        if stale:
            print(f"OUT OF DATE: {', '.join(stale)} — run `python3 build_manifests.py`")
            sys.exit(1)
        print(f"ok: {len(tests)} tests, manifests up to date")
        return
    for path, content in targets.items():
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
    counts = {}
    for t in tests:
        counts[t["expect"]] = counts.get(t["expect"], 0) + 1
    print(f"indexed {len(tests)} tests: " + ", ".join(f"{k}={v}" for k, v in sorted(counts.items())))


if __name__ == "__main__":
    main()
