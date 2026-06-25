#!/usr/bin/env python3
"""
Agape v1.0 conformance suite — single source of truth.

Encodes ONLY SPEC-1.0.md (it has never seen any implementation). There is one
language version: v1.0. There is no notion of 0.3/0.4, no `since`/`until`, no
`~`/`entail`/`calibrate`/`Prob<T>` — a semantic judgment is a seam send bound to
`Credence<E>`, gated with `decide(c, rule)` / `verify` (§8, §13).

Emits one `.ag` file per test under tests/<section>/ with a `//!` header, plus
MANIFEST.toml (machine-readable) and MANIFEST.md (human index).

Header keys: id, section, expect (accept|reject|blocked), error (iff reject),
spine|contains|absent (matchers), question (iff blocked), spec, note.
Error classes: LexError ParseError TypeError ColorViolation TaintViolation
AuthorityViolation ExhaustivenessError.

Run:  python3 gen.py
"""
import os

ROOT = os.path.dirname(os.path.abspath(__file__))
TESTS_DIR = os.path.join(ROOT, "tests")

T = []
def add(**kw):
    T.append(kw)


# ============================================================================
# 00_lexical (§2)
# ============================================================================
S = "00_lexical"

add(id="lex_comment_fstring", section=S, expect="accept",
    spec="§2 (line comments; f-string interpolation; INT/FLOAT literals)",
    note="lexical basics that survive into v1.0 unchanged.",
    src='''// a line comment
int a = 2 + 3;
float r = 7.0 / 2.0;
text g = f"a={a}, r={r}";
say(g);''')

add(id="lex_reject_right_arrow", section=S, expect="reject", error="LexError",
    spec="§2 (exactly one communication arrow `<-`; `->` is a LexError)",
    note="the retired `->` does not lex.",
    src='''agent A {}
spawn A a;
awake a;
a -> "hello";''')

add(id="lex_reject_missing_semicolon", section=S, expect="reject", error="ParseError",
    spec="§2 (statement terminator `;` is explicit and required)",
    src='''int a = 5
int b = 6;''')

add(id="lex_reject_keyword_as_identifier", section=S, expect="reject", error="ParseError",
    spec="§2 (reserved keywords may not be used as identifiers)",
    note="`agent` is reserved.",
    src='''int agent = 5;''')

add(id="lex_contextual_word_as_identifier", section=S, expect="accept",
    spec="§2 (contextual words `as`/`by`/`reach`/`use`/`origin` lex as identifiers out of position)",
    note="`by` outside a gate position is an ordinary identifier.",
    src='''int by = 3;
say(f"{by}");''')


# ============================================================================
# 01_axes (§1 — the three orthogonal axes: color, taint, spine)
# ============================================================================
S = "01_axes"

add(id="axes_send_is_event_tainted", section=S, expect="accept",
    spec="§1 Axis B/C (`d <- p` : event<T>, on the spine, and its reply is tainted P)",
    note="a send is a spine op yielding a tainted reply.",
    src='''agent A {
  on awake {
    event<text> r = self <- "what is your name?";
    say(r);
  }
}
spawn A a; awake a;''')

add(id="axes_pure_call_sync_untainted", section=S, expect="accept",
    spec="§1 Axis A/B (a pure `sync` fn is cognition-free and adds no taint)",
    note="arithmetic only; provably seam-free.",
    src='''sync int dbl(int x) { return x * 2; }
int y = dbl(21);
say(f"{y}");''')

add(id="axes_credence_is_graded_judgment", section=S, expect="accept",
    spec="§1, §8 (a semantic judgment is a seam send bound to Credence<E>)",
    note="the v1.0 replacement for the retired `~`: a graded judgment.",
    src='''agent A {
  on awake {
    Credence<bool> ok = self <- "is \\"approve #42\\" an approval?";
    bool b = decide(ok, > 0.9);
    say(f"{b}");
  }
}
spawn A a; awake a;''')

add(id="axes_decide_is_bool", section=S, expect="accept",
    spec="§8, §13 (decide(Credence<bool>, rule) commits to a bool — untainted, in hand)",
    src='''sync bool over(Credence<bool> c) { return decide(c, > 0.9); }''')


# ============================================================================
# 03_types (§3)
# ============================================================================
S = "03_types"

add(id="type_scalars", section=S, expect="accept",
    spec="§3 (scalars int/float/bool/text/null)",
    src='''int i = 1;
float f = 2.5;
bool b = true;
text t = "hi";
null n = null;
say(t);''')

add(id="type_event_null_no_reply", section=S, expect="accept",
    spec="§3 (event<null> = sent, no typed reply bound)",
    src='''agent A {
  on awake {
    event<null> seeded = self <- "your name is Ada.";
  }
}
spawn A a; awake a;''')

add(id="type_struct_decl_and_literal", section=S, expect="accept",
    spec="§3 (struct declaration + struct literal supplying all fields)",
    note="a declared struct constructed with every field.",
    src='''struct Memo { amount: int, to: text }
Memo m = Memo { amount: 100, to: "bob" };
say(m.to);''')

add(id="type_struct_missing_field_reject", section=S, expect="reject", error="TypeError",
    spec="§3 (all struct fields required; no optional-by-omission)",
    src='''struct Memo { amount: int, to: text }
Memo m = Memo { amount: 100 };''')

add(id="type_enum_decl_and_case", section=S, expect="accept",
    spec="§3, §11 (enum declaration; case exhaustive over all variants)",
    note="a user enum, judged and matched exhaustively.",
    src='''enum Ticket { Billing, Bug, Feature }
agent Classifier {
  on awake {
    Credence<Ticket> k = self <- "classify: my card was charged twice";
    case (k) as v {
      Billing: { say("billing"); }
      Bug: { say("bug"); }
      Feature: { say("feature"); }
    }
  }
}
spawn Classifier c; awake c;''')

add(id="type_event_decl", section=S, expect="accept",
    spec="§3 (custom spine-event declaration with a typed payload)",
    src='''struct Memo { amount: int, to: text }
event Transfer(memo: Memo);''')

add(id="type_undeclared_emit_reject", section=S, expect="reject", error="TypeError",
    spec="§3 (events are not self-declaring; emit of an undeclared type is a TypeError)",
    src='''agent A grants { emit Transfer } {
  on awake { emit Transfer("100 to bob"); }
}
spawn A a; awake a;''')

add(id="type_no_text_to_principal_reject", section=S, expect="reject", error="TypeError",
    spec="§3, §13 (no text -> Principal coercion at a gate)",
    src='''agent Drafter {
  on awake {
    event<text> memo = self <- "draft the memo";
    verify memo by "alice";
  }
}
spawn Drafter d; awake d;''')

add(id="type_decide_requires_rule_reject", section=S, expect="reject", error="ParseError",
    spec="§3, §15.2 (decide's rule is mandatory)",
    src='''agent A {
  on awake {
    Credence<bool> c = self <- "is this an approval?";
    bool b = decide(c);
  }
}
spawn A a; awake a;''')

add(id="type_credence_only_from_seam_reject", section=S, expect="reject", error="TypeError",
    spec="§3, §8 (Credence<E> is produced ONLY by a seam judgment, never constructed literally)",
    src='''bool b = true;
Credence<bool> c = b;''')


# ============================================================================
# 04_functions (§4 — function color)
# ============================================================================
S = "04_functions"

add(id="fn_sync_pure_ok", section=S, expect="accept",
    spec="§4 (a sync fn that touches no seam is well-formed)",
    src='''sync int add1(int x) { return x + 1; }''')

add(id="fn_sync_reaches_seam_reject", section=S, expect="reject", error="ColorViolation",
    spec="§1 Axis A, §4 (a sync fn may not reach the provider seam via `<-`)",
    src='''sync text classify(text x) { return self <- f"classify {x}"; }''')

add(id="fn_sync_calls_async_reject", section=S, expect="reject", error="ColorViolation",
    spec="§4 (a sync fn may only call other sync fns)",
    src='''text ask(text q) { return self <- q; }
sync text wrap(text q) { return ask(q); }''')

add(id="fn_sync_emit_ok", section=S, expect="accept",
    spec="§4 (emit is a spine op, permitted in sync)",
    src='''event Note(text msg);
sync null log(text m) { emit Note(m); return null; }
agent Logger grants { emit Note } {
  on awake { log("hi"); }
}
spawn Logger l; awake l;''')

add(id="fn_sync_inhand_verify_ok", section=S, expect="accept",
    spec="§4, §13 (in-hand verify = decide+emit, synchronous)",
    note="a sync fn may verify a Credence value already in hand.",
    src='''sync bool over(Credence<bool> c) { verify c; return decide(c, > 0.9); }''')

add(id="fn_sync_tool_call_reject", section=S, expect="reject", error="ColorViolation",
    spec="§4, §6b (a tool call reaches the tool seam → async)",
    src='''tool search(text q) -> text;
sync text find(text q) { return search(q); }''')

add(id="fn_sync_verify_by_principal_reject", section=S, expect="reject", error="ColorViolation",
    spec="§4, §13 (verify … by Principal reaches the identity seam → async)",
    src='''principal alice;
sync null ok(text memo) { verify memo by alice; return null; }''')


# ============================================================================
# 05_agents (§5)
# ============================================================================
S = "05_agents"

add(id="agent_spawn_instantiate_only", section=S, expect="accept",
    spec="§5 (spawn instantiates only: no constructor body, no mailbox)",
    contains=["Spawned(a)"], absent=["AgentAwake(a)"],
    src='''agent A { on awake { say("constructed"); } }
spawn A a;''')

add(id="agent_first_awake_runs_constructor", section=S, expect="accept",
    spec="§5 (first awake opens the mailbox and runs the constructor)",
    contains=["Spawned(a)", "AgentAwake(a)"],
    src='''agent A { on awake { say("hello"); } }
spawn A a; awake a;''')

add(id="agent_reawake_no_reconstruct", section=S, expect="accept",
    spec="§5 (re-awake runs the subsequent path: no re-bind, no re-construct)",
    src='''agent W {}
spawn W w; awake w; sleep w; awake w;''')

add(id="agent_sleep_runs_hook", section=S, expect="accept",
    spec="§5 (sleep closes the mailbox and runs the on-sleep hook)",
    contains=["SleepEvent(a)"],
    src='''agent A { on sleep { say("released"); } }
spawn A a; awake a; sleep a;''')

add(id="agent_extend_inherits_when", section=S, expect="accept",
    spec="§5 (extend inherits fields + constructor + when blocks + hooks)",
    src='''agent Base {
  when (self) { say("base reacted"); }
}
agent Child {
  extend Base();
}
spawn Child c; awake c;''')

add(id="agent_prompt_opens_sensor", section=S, expect="accept",
    spec="§5b (a `prompt` declaration opens a standing external input sensor)",
    contains=["PromptOpened(question)"],
    src='''prompt text question;
agent A {
  when (question) { say("got input"); }
}
spawn A a; awake a;''')


# ============================================================================
# 06_communication (§6)
# ============================================================================
S = "06_communication"

add(id="comm_typed_reply", section=S, expect="accept",
    spec="§6 (a typed reply binds the seam answer into event<T>)",
    src='''agent A {
  on awake {
    event<bool> yes = self <- "is the sky blue?";
    say(f"{yes}");
  }
}
spawn A a; awake a;''')

add(id="comm_self_send_thinks", section=S, expect="accept",
    spec="§6 (sending to self is the agent's own cognition; needs no reach grant)",
    src='''agent A {
  on awake {
    event<text> r = self <- "summarize: agape is event-driven";
    say(r);
  }
}
spawn A a; awake a;''')


# ============================================================================
# 07_spine (§7)
# ============================================================================
S = "07_spine"

add(id="spine_prospective_only", section=S, expect="accept",
    spec="§7 (subscriptions are prospective; never fire for prior events)",
    note="a catch registered after an emit does NOT fire for that earlier event.",
    absent=["Event"],
    src='''event Note(text msg);
emit Note("early");
catch Note(x) as e { say("should not fire for early"); }''')

add(id="spine_query_result_event", section=S, expect="accept",
    spec="§10 (a query STATEMENT lands a QueryResult event on the spine)",
    contains=["QueryResult(spine)"],
    src='''select * from spine where { etype: "Spawned" };''')

add(id="spine_tool_pair", section=S, expect="accept",
    spec="§6b, §7 (a tool call appends a ToolStarted/ToolResolved pair)",
    contains=["pair(Tool@search)"],
    src='''tool search(text q) -> text;
agent R grants { use search } {
  text hits = search("agape");
}
spawn R r; awake r;''')


# ============================================================================
# 08_semantic (§8 — graded judgments)
# ============================================================================
S = "08_semantic"

add(id="sem_credence_over_user_enum", section=S, expect="accept",
    spec="§8 (a seam send bound to Credence<E> is a constrained classifier over E)",
    src='''enum Sentiment { Pos, Neg, Neutral }
agent A {
  on awake {
    Credence<Sentiment> s = self <- "sentiment of: I love this";
    case (s) as v {
      Pos: { say("pos"); }
      Neg: { say("neg"); }
      Neutral: { say("neu"); }
    }
  }
}
spawn A a; awake a;''')

add(id="sem_entailment_three_valued", section=S, expect="accept",
    spec="§8, §9 (Credence<Entailment> over {Entails, Contradicts, Neutral})",
    src='''agent A {
  on awake {
    Credence<Entailment> v = self <- "does \\"sky is blue\\" entail \\"it is daytime\\"?";
    case (v) as d {
      Entails: { say("e"); }
      Contradicts: { say("c"); }
      Neutral: { say("n"); }
    }
  }
}
spawn A a; awake a;''')

add(id="sem_contradiction_emits_event", section=S, expect="accept",
    spec="§8 (deciding a Credence<Entailment> to Contradicts also emits a first-class Contradiction)",
    contains=["Contradiction(j)"],
    src='''agent A {
  on awake {
    Credence<Entailment> j = self <- "does \\"the sky is green\\" entail \\"the sky is blue\\"?";
    case (j) as d {
      Entails: { say("e"); }
      Contradicts: { say("c"); }
      Neutral: { say("n"); }
    }
  }
}
spawn A a; awake a;''')


# ============================================================================
# 09_prelude (§9)
# ============================================================================
S = "09_prelude"

add(id="prelude_catch_error_catches_contradiction", section=S, expect="accept",
    spec="§9 (Contradiction extends Error; catch Error catches it by subtype)",
    src='''catch Error as e { say("caught"); }
agent J {
  on awake {
    Credence<Entailment> v = self <- "does \\"sky is blue\\" entail \\"sky is green\\"?";
    case (v) as d {
      Entails: { say("e"); }
      Contradicts: { say("c"); }
      Neutral: { say("n"); }
    }
  }
}
spawn J j; awake j;''')


# ============================================================================
# 10_memory (§10)
# ============================================================================
S = "10_memory"

add(id="mem_match_is_gate", section=S, expect="accept",
    spec="§10 (match > θ is a gate; yields an untainted result off-spine)",
    src='''agent Recall {
  on awake { match { hit: "agape language" } > 0.8; }
}
spawn Recall r; awake r;''')

add(id="mem_queried_fact_taint_reject", section=S, expect="reject", error="TaintViolation",
    spec="§10, §13 (queried facts default to P-tainted; must be re-gated before a consequential emit)",
    src='''struct Memo { amount: int, to: text }
authority Transfer;
event Transfer(memo: Memo);
agent Bank grants { emit Transfer } {
  Memo m = select amount, to from self where { kind: "pending" };
  emit Transfer(m);
}
spawn Bank b; awake b;''')


# ============================================================================
# 11_control (§11)
# ============================================================================
S = "11_control"

add(id="ctrl_if_else", section=S, expect="accept",
    spec="§11 (if/else over a bool)",
    src='''int x = 3;
if (x > 2) { say("big"); } else { say("small"); }''')

add(id="ctrl_while_break", section=S, expect="accept",
    spec="§11, §15.2 (while loop with break)",
    src='''int i = 0;
while (i < 10) {
  if (i == 3) { break; }
  i = i + 1;
}
say(f"{i}");''')

add(id="ctrl_case_all_variants_ok", section=S, expect="accept",
    spec="§11 (case covering every enum variant is exhaustive)",
    src='''enum Color { Red, Green, Blue }
agent A {
  on awake {
    Credence<Color> c = self <- "what color is grass?";
    case (c) as v {
      Red: { say("r"); }
      Green: { say("g"); }
      Blue: { say("b"); }
    }
  }
}
spawn A a; awake a;''')

add(id="ctrl_case_nonexhaustive_reject", section=S, expect="reject", error="ExhaustivenessError",
    spec="§11 (a case with no default must cover all variants)",
    src='''enum Color { Red, Green, Blue }
agent A {
  on awake {
    Credence<Color> c = self <- "what color is grass?";
    case (c) as v {
      Red: { say("r"); }
      Green: { say("g"); }
    }
  }
}
spawn A a; awake a;''')

add(id="ctrl_case_default_ok", section=S, expect="accept",
    spec="§11 (a default arm makes a partial case exhaustive)",
    src='''enum Color { Red, Green, Blue }
agent A {
  on awake {
    Credence<Color> c = self <- "what color is grass?";
    case (c) as v {
      Green: { say("g"); }
      default: { say("other"); }
    }
  }
}
spawn A a; awake a;''')

add(id="ctrl_retry_bounded", section=S, expect="accept",
    spec="§11 (bounded retry re-attempts a verify a fixed number of times)",
    src='''agent A {
  on awake {
    retry(3) {
      Credence<bool> still = self <- "are you ready?";
      verify still;
    }
  }
}
spawn A a; awake a;''')


# ============================================================================
# 12_aggregation (§12)
# ============================================================================
S = "12_aggregation"

add(id="agg_quorum_independent_ok", section=S, expect="accept",
    spec="§12 (quorum over independent Credence<bool> judges fuses to one Credence<bool>)",
    src='''agent Triage {
  on awake {
    Credence<bool> j1 = self <- "is this spam?";
    Credence<bool> j2 = self <- "does this look like spam?";
    Credence<bool> j3 = self <- "would a user mark this spam?";
    independent j1, j2, j3;
    Credence<bool> agreed = quorum(2 of j1, j2, j3);
    verify agreed;
  }
}
spawn Triage t; awake t;''')

add(id="agg_quorum_no_dep_decl_reject", section=S, expect="reject", error="TypeError",
    spec="§12 (fusion — incl. quorum — requires a total independent/dependent declaration)",
    src='''agent Triage {
  on awake {
    Credence<bool> j1 = self <- "is this spam?";
    Credence<bool> j2 = self <- "does this look like spam?";
    Credence<bool> agreed = quorum(2 of j1, j2);
  }
}
spawn Triage t; awake t;''')


# ============================================================================
# 13_governance (§13, §6b — capabilities)
# ============================================================================
S = "13_governance"

add(id="gov_emit_ungranted_reject", section=S, expect="reject", error="AuthorityViolation",
    spec="§13 (an agent may only emit event types in its grants)",
    src='''event Note(text msg);
agent A {
  on awake { emit Note("hi"); }
}
spawn A a; awake a;''')

add(id="gov_gated_emit_ok", section=S, expect="accept",
    spec="§13 (a verified Credence may cross an authority boundary)",
    src='''authority Flag;
event Flag(bool b);
agent C grants { emit Flag } {
  on awake {
    Credence<bool> c = self <- "is this fraud?";
    event<Verification> ok = verify c by > 0.9 margin 0.2;
    when Pass(ok) { emit Flag(true); }
  }
}
spawn C c; awake c;''')

add(id="gov_consequential_bare_decide_reject", section=S, expect="reject", error="TaintViolation",
    spec="§13 (a bare decide is committed but NOT authorized → reject at a consequential emit)",
    src='''authority Flag;
event Flag(bool b);
agent C grants { emit Flag } {
  on awake {
    Credence<bool> c = self <- "is this fraud?";
    bool d = decide(c, > 0.9);
    emit Flag(d);
  }
}
spawn C c; awake c;''')

add(id="gov_use_tool_granted_ok", section=S, expect="accept",
    spec="§6b, §13 (a granted `use TOOL` permits the tool call)",
    src='''tool search(text q) -> text;
agent R grants { use search } {
  text hits = search("q");
}
spawn R r; awake r;''')

add(id="gov_use_tool_ungranted_reject", section=S, expect="reject", error="AuthorityViolation",
    spec="§6b, §13 (default-deny: a tool call needs a `use` grant)",
    src='''tool search(text q) -> text;
agent R {
  text hits = search("q");
}
spawn R r; awake r;''')

add(id="gov_tool_result_tainted_emit_reject", section=S, expect="reject", error="TaintViolation",
    spec="§6b, §13 (a tool result is T-tainted; cannot drive a consequential emit without a gate)",
    src='''authority Alarm;
event Alarm(text msg);
tool fetch(text url) -> text;
agent Mon grants { use fetch, emit Alarm } {
  text body = fetch("http://status");
  emit Alarm(body);
}
spawn Mon m; awake m;''')

add(id="gov_reach_ungranted_reject", section=S, expect="reject", error="AuthorityViolation",
    spec="§13 (sending into another agent requires a `reach` grant)",
    src='''agent Worker {}
agent Boss(Worker hand) {
  on awake { event<text> s = hand <- "status?"; }
}
spawn Worker w;
spawn Boss b(w); awake b;''')

add(id="gov_extend_use_subtractive_reject", section=S, expect="reject", error="AuthorityViolation",
    spec="§5, §13 (capabilities, incl. `use`, are subtractive under extend)",
    src='''tool search(text q) -> text;
agent Base grants { } {}
agent Child grants { use search } {
  extend Base();
}
spawn Child c; awake c;''')


# ============================================================================
# 15_reproducibility (§15)
# ============================================================================
S = "15_reproducibility"

add(id="repro_decide_off_spine", section=S, expect="accept",
    spec="§15 (decide is a pure projection of a Credence already on the spine; off-spine itself)",
    src='''sync bool gate(Credence<bool> c) { return decide(c, > 0.8); }''')


# ============================================================================
# emit
# ============================================================================
def header(t):
    L = [f"//! id:        {t['id']}", f"//! section:   {t['section']}",
         f"//! expect:    {t['expect']}"]
    if t["expect"] == "reject":
        L.append(f"//! error:     {t['error']}")
    if t["expect"] == "blocked":
        L.append(f"//! question:  {t['question']}")
    for k in ("spine", "contains", "absent"):
        if t.get(k):
            L.append(f"//! {k}:  {'; '.join(t[k])}")
    L.append(f"//! spec:      {t['spec']}")
    if t.get("note"):
        L.append(f"//! note:      {t['note']}")
    L.append("//! ---")
    return "\n".join(L)


def toml_escape(s):
    return s.replace("\\", "\\\\").replace('"', '\\"')


def main():
    seen = set()
    counts = {}
    for t in T:
        assert t["id"] not in seen, f"duplicate id {t['id']}"
        seen.add(t["id"])
        d = os.path.join(TESTS_DIR, t["section"])
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, t["id"] + ".ag"), "w", encoding="utf-8") as f:
            f.write(header(t) + "\n" + t["src"].rstrip() + "\n")
        counts[t["expect"]] = counts.get(t["expect"], 0) + 1

    tl = ["# Agape v1.0 conformance manifest (generated by gen.py).",
          "# A conformant implementation must satisfy every non-blocked test.",
          "schema = 1", ""]
    for t in T:
        tl.append("[[test]]")
        tl.append(f'id = "{t["id"]}"')
        tl.append(f'section = "{t["section"]}"')
        tl.append(f'path = "tests/{t["section"]}/{t["id"]}.ag"')
        tl.append(f'expect = "{t["expect"]}"')
        if t["expect"] == "reject":
            tl.append(f'error = "{t["error"]}"')
        for k in ("spine", "contains", "absent"):
            if t.get(k):
                arr = ", ".join(f'"{toml_escape(x)}"' for x in t[k])
                tl.append(f"{k} = [{arr}]")
        if t["expect"] == "blocked":
            tl.append(f'question = "{toml_escape(" ".join(t["question"].split()))}"')
        tl.append(f'spec = "{toml_escape(t["spec"])}"')
        if t.get("note"):
            tl.append(f'note = "{toml_escape(" ".join(t["note"].split()))}"')
        tl.append("")
    with open(os.path.join(ROOT, "MANIFEST.toml"), "w", encoding="utf-8") as f:
        f.write("\n".join(tl))

    md = ["# Agape v1.0 — Conformance Test Index\n",
          f"**{len(T)} tests** — " + ", ".join(f"{k}: {v}" for k, v in sorted(counts.items())) + "\n",
          "A conformant implementation must satisfy every `accept`/`reject` test "
          "(rejects with the declared error class; accepts matching any asserted spine).\n"]
    by = {}
    for t in T:
        by.setdefault(t["section"], []).append(t)
    for sec in sorted(by):
        md.append(f"\n## {sec}\n")
        md.append("| id | expect | error | spec |")
        md.append("|---|---|---|---|")
        for t in by[sec]:
            md.append(f"| `{t['id']}` | {t['expect']} | {t.get('error','—')} | {t['spec']} |")
    with open(os.path.join(ROOT, "MANIFEST.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(md) + "\n")

    print(f"wrote {len(T)} tests: " + ", ".join(f"{k}={v}" for k, v in sorted(counts.items())))


if __name__ == "__main__":
    main()
