"""
spine.py — THE EVENT SPINE. The single most important component of Agape.

The spine is an append-only log. It is the source of truth. Every meaningful
action appends an immutable Event. State is a projection of the log; replay
re-derives state by folding the log.

Design decisions locked in conversation:
  - Ticks are assigned at the SYSTEM level, not by any agent. Monotonic counter.
  - Async cognitive ops append a PAIR: <Op>Started then <Op>Resolved, correlated
    by a unique `corr` id. "Pending" = a Started with no matching Resolved.
  - Synchronous deterministic ops append a SINGLE event.
  - catch/when are the SAME mechanism: a subscription keyed by (event_type, subject)
    at opposite polarities. Subscriptions fire on the MOST RECENT matching event at
    registration (retroactive), then once per new matching event (prospective).
  - "All of history" is a QUERY, not a subscription.
"""

from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any, Callable
import itertools


# Unique correlation ids for Started/Resolved pairing.
_corr_counter = itertools.count(1)


def new_corr() -> str:
    return f"c{next(_corr_counter)}"


@dataclass
class Event:
    """
    One immutable entry on the spine.

    tick      : system-assigned monotonic order (the global clock)
    etype     : event type name, e.g. "ThinkStarted", "FailedVerification",
                "Contradiction", "Event" (user emit), "Error", "SpawnResolved"
    subject   : the thing this event is ABOUT — the correlation key catch/when use.
                For a verification, the left operand. For a think, the destination.
                May be None for global/system events.
    payload   : arbitrary data (the verdict, the reply text, the error message...)
    corr      : correlation id linking a Started to its Resolved (None for singles)
    agent     : id of the agent that produced it (None for top-level/system)
    """
    tick: int
    etype: str
    subject: Any = None
    payload: Any = None
    corr: str | None = None
    agent: str | None = None

    def __repr__(self) -> str:
        sub = "" if self.subject is None else f" subject={self.subject!r}"
        pay = "" if self.payload is None else f" payload={_short(self.payload)}"
        cor = "" if self.corr is None else f" corr={self.corr}"
        ag = "" if self.agent is None else f" @{self.agent}"
        return f"[{self.tick:>3}] {self.etype}{sub}{pay}{cor}{ag}"


def _short(v: Any) -> str:
    s = repr(v)
    return s if len(s) <= 60 else s[:57] + "..."


# A subscription: fire `handler(event)` when an event matches (etype, subject).
@dataclass
class Subscription:
    etype: str
    subject: Any            # match this subject; None means "any subject"
    handler: Callable[[Event], None]
    polarity: str           # "when" (success) or "catch" (failure) — informational
    registered_at: int      # tick at registration, for retroactive semantics
    fired_for: set = field(default_factory=set)  # ticks already fired, avoid dupes


class Spine:
    def __init__(self):
        self.log: list[Event] = []
        self._tick = itertools.count(0)
        self.subs: list[Subscription] = []

    # ---- appending --------------------------------------------------------

    def append(self, etype: str, subject: Any = None, payload: Any = None,
               corr: str | None = None, agent: str | None = None) -> Event:
        """Append a single event to the log and notify matching subscriptions."""
        ev = Event(tick=next(self._tick), etype=etype, subject=subject,
                   payload=payload, corr=corr, agent=agent)
        self.log.append(ev)
        self._notify(ev)
        return ev

    def started(self, op: str, subject: Any = None, payload: Any = None,
                agent: str | None = None) -> str:
        """Append an <Op>Started event; return its corr id for the later Resolved."""
        corr = new_corr()
        self.append(f"{op}Started", subject=subject, payload=payload,
                    corr=corr, agent=agent)
        return corr

    def resolved(self, op: str, corr: str, subject: Any = None, payload: Any = None,
                 agent: str | None = None) -> Event:
        """Append the matching <Op>Resolved event, correlated by corr id."""
        return self.append(f"{op}Resolved", subject=subject, payload=payload,
                           corr=corr, agent=agent)

    # ---- subscriptions (catch / when) ------------------------------------

    def subscribe(self, etype: str, subject: Any, handler: Callable[[Event], None],
                  polarity: str = "when") -> Subscription:
        """
        Register a subscription. Per locked semantics: it fires for the MOST RECENT
        already-logged matching event (retroactive), then once per new match.
        """
        sub = Subscription(etype=etype, subject=subject, handler=handler,
                           polarity=polarity, registered_at=self._peek_tick())
        self.subs.append(sub)
        # Retroactive: find the most recent matching event already on the log.
        for ev in reversed(self.log):
            if self._matches(sub, ev):
                self._fire(sub, ev)
                break
        return sub

    def _peek_tick(self) -> int:
        # next() would consume; we just want the current value without advancing.
        # itertools.count has no peek, so we track via len-independent shadow.
        return len(self.log)

    def _matches(self, sub: Subscription, ev: Event) -> bool:
        if sub.etype != ev.etype:
            return False
        if sub.subject is None:
            return True
        return _subject_eq(sub.subject, ev.subject)

    def _fire(self, sub: Subscription, ev: Event):
        if ev.tick in sub.fired_for:
            return
        sub.fired_for.add(ev.tick)
        sub.handler(ev)

    def _notify(self, ev: Event):
        # Prospective: any existing subscription that matches this new event fires.
        for sub in list(self.subs):
            if self._matches(sub, ev):
                self._fire(sub, ev)

    # ---- queries (the "all of history" path, distinct from subscriptions) -

    def query(self, etype: str | None = None, subject: Any = None) -> list[Event]:
        out = []
        for ev in self.log:
            if etype is not None and ev.etype != etype:
                continue
            if subject is not None and not _subject_eq(subject, ev.subject):
                continue
            out.append(ev)
        return out

    def pending(self) -> list[Event]:
        """Started events with no matching Resolved — what was in flight."""
        resolved_corrs = {ev.corr for ev in self.log
                          if ev.etype.endswith("Resolved") and ev.corr}
        return [ev for ev in self.log
                if ev.etype.endswith("Started") and ev.corr
                and ev.corr not in resolved_corrs]

    # ---- presentation -----------------------------------------------------

    def dump(self) -> str:
        return "\n".join(repr(ev) for ev in self.log)


def _subject_eq(a: Any, b: Any) -> bool:
    """
    Subjects are correlation keys. Two subjects match if they refer to the same
    thing. For our slice, subjects are SubjectRef objects (stable identity) or
    plain values; compare by identity-key when available, else by equality.
    """
    ak = getattr(a, "subject_key", None)
    bk = getattr(b, "subject_key", None)
    if ak is not None or bk is not None:
        return ak == bk
    return a == b
