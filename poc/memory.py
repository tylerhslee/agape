"""
Memory — the agentic memory subsystem (the genuinely new part).

THE ATOM. Everything an agent knows is built from one irreducible unit, taken
straight from the graph world: the TRIPLE.

    (subject, predicate, object)        e.g.  ("self", "name", "John")

A triple is a graph EDGE. It is the low-level, atomic information architecture.
Higher-level structures roll UP from it: an "observation" — eventually
{ entity, source, confidence } — is just a node with several edges hanging off
it (reification). So arity is settled by LAYERING: strict 3 at the atom, free
arity above it. We build the atom now; the roll-up comes later.

ONE SUBSTRATE, THREE MODALITIES. The three modalities (SQL / vector / graph) are
NOT three separate stores — they are three ways to *index and recall* the same
pile of triples:

    structured (exact)      recall by exact match         <- THIS FILE, for now
    semantic   (similar)    recall by vector similarity    (later)
    relational (connected)  recall by graph traversal      (later)

`self` is the reserved subject meaning "the agent that owns this memory," so
("self","name","John") is literally the agent learning *"my name is John."*

This whole module is the SOMATIC substrate, emulated today on plain in-process
data. We deliberately do NOT delegate recall to a database: the recall logic IS
part of the spec we hand the EE, so it must be visible here, written by us — not
hidden inside someone else's query engine.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class Fact:
    """One atom: a triple / graph edge."""
    subject: str
    predicate: str
    object: str

    def __repr__(self):
        return f"({self.subject} {self.predicate} {self.object!r})"


class Memory:
    """An agent's private memory: one pile of atoms, several ways to recall them.

    For now only the structured (exact) recall exists; semantic recall and graph
    traversal are added later as more index strategies over the SAME `_atoms`.
    """

    def __init__(self):
        # The substrate: a plain in-process list of atoms. Not a database — on
        # purpose. (Persistence — surviving a restart so the agent truly *learns*
        # — is a deliberate later bite.)
        self._atoms: list[Fact] = []

    def store(self, subject, predicate, object):
        """Commit one atom. Append-only in spirit: we ADD facts, we don't
        overwrite them — which keeps a trail of how a belief came to be."""
        fact = Fact(subject, predicate, object)
        self._atoms.append(fact)
        return fact

    def recall(self, subject, predicate=None):
        """STRUCTURED modality: exact-match recall, written by us so the
        semantics are explicit and inspectable. Deterministic — same query, same
        answer. Omit `predicate` to recall everything known about a subject."""
        return [
            f for f in self._atoms
            if f.subject == subject and (predicate is None or f.predicate == predicate)
        ]


if __name__ == "__main__":
    m = Memory()

    print("teaching the agent:  my name is John")
    m.store("self", "name", "John")
    print("teaching the agent:  my role is poker coach")
    m.store("self", "role", "poker coach")

    print()
    print("recall self.name           ->", m.recall("self", "name"))
    print("recall everything re: self ->", m.recall("self"))
