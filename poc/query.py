"""
find/where query engine: triple-pattern matching by unification (Datalog/SPARQL
style) over a flat list of triples. THIS is where the resolution deferred by the
lexer and parser finally happens — a name in a node slot is classified by what it
denotes in scope:

  - BOUND VALUE (name is in scope)  -> must equal that literal
  - TYPE (a known type name)        -> a shared variable that must be of that type
  - otherwise a fresh VARIABLE      -> binds to whatever matches

Predicates are edge-name constants. Returns every variable-binding (a dict) for
which all the patterns hold simultaneously.
"""


def solve(triples, patterns, values, types):
    results = []

    def classify(name):
        if name in values:
            return ("value", name)
        if name in types:
            return ("type", name)       # acts as a shared, type-constrained var
        return ("var", name)

    def unify(slot, actual, subst):
        kind, name = slot
        if kind == "value":
            return subst if actual == name else None
        if kind == "var":
            if name in subst:
                return subst if subst[name] == actual else None
            nxt = dict(subst); nxt[name] = actual; return nxt
        if kind == "type":
            if name in subst and subst[name] != actual:
                return None
            if (actual, "is_a", name) not in triples:      # the type constraint
                return None
            nxt = dict(subst); nxt[name] = actual; return nxt
        return None

    def match(i, subst):
        if i == len(patterns):
            results.append(subst)
            return
        pat = patterns[i]
        subj, obj = classify(pat.subject), classify(pat.object)
        for (s, p, o) in triples:
            if p != pat.predicate:          # predicate is a literal edge name
                continue
            s1 = unify(subj, s, subst)
            if s1 is None:
                continue
            s2 = unify(obj, o, s1)
            if s2 is None:
                continue
            match(i + 1, s2)

    match(0, {})
    return results
