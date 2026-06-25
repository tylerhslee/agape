"""test_studio.py — checks for the Studio session layer (Phase 1).

Run:  python3 studio/server/test_studio.py
Exercises the Session that wraps the live interpreter — load, drive, project —
without needing the HTTP layer or an API key (mock provider throughout).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from session import Session, SessionError

DEMO = os.path.join(os.path.dirname(__file__), "..", "programs", "console_demo.ag")

_passed = 0


def check(name, cond):
    global _passed
    status = "PASS" if cond else "FAIL"
    print(f"  {status}  {name}")
    assert cond, f"FAILED: {name}"
    _passed += 1


def main():
    print("== load leaves agents live ==")
    s = Session(provider="mock")
    snap = s.load(open(DEMO).read(), path="console_demo.ag")
    names = {a["name"]: a for a in snap["agents"]}
    check("two agents spawned", set(names) == {"ada", "bo"})
    check("both awake (program never sleeps them)", all(a["awake"] for a in names.values()))
    check("spine has events", len(snap["events"]) > 0)
    check("Helper template registered", "Helper" in snap["templates"])

    print("\n== eval drives the live interpreter (a real send) ==")
    r = s.eval('event<text> q = ada <- "What is your name?";')
    etypes = [e["etype"] for e in r["new_events"]]
    check("send produced a ThinkStarted/ThinkResolved pair",
          "ThinkStarted" in etypes and "ThinkResolved" in etypes)
    resolved = [e for e in r["new_events"] if e["etype"] == "ThinkResolved"]
    check("mock answered with the seeded name", resolved and "Ada" in str(resolved[-1]["payload"]))
    check("new_events is a delta, not the whole log",
          len(r["new_events"]) < len(r["events"]))

    print("\n== graph query binds across agents ==")
    s.eval("find n where { Helper is_named n };")
    check("find bound both names", set(s.interp.global_env.get("n") or []) == {"Ada", "Bo"})

    print("\n== lifecycle: sleep then awake flips awake state ==")
    s.eval("sleep ada;")
    a = {x["name"]: x for x in s.snapshot()["agents"]}["ada"]
    check("ada is asleep after sleep", a["awake"] is False)
    s.eval("awake ada;")
    a = {x["name"]: x for x in s.snapshot()["agents"]}["ada"]
    check("ada is awake again", a["awake"] is True)

    print("\n== guarantees are enforced incrementally ==")
    try:
        # emitting an undeclared/ungranted event from the top level should not
        # silently pass the static check; an unknown agent type is a hard error.
        s.eval("spawn Ghost g();")
        check("unknown agent type rejected", False)
    except SessionError as e:
        check("unknown agent type rejected", "Ghost" in str(e))

    print("\n== a `<-` to an undefined agent errors (not a silent seam call) ==")
    try:
        # `nope` was never spawned. Pre-fix this silently became an agent-less
        # think and returned an LLM response; now it must error.
        s.eval('event<text> a = nope <- "what is your name?";')
        check("undefined send destination rejected", False)
    except SessionError as e:
        check("undefined send destination rejected", "nope" in str(e))

    print(f"\nAll {_passed} studio checks passed.")


if __name__ == "__main__":
    main()
