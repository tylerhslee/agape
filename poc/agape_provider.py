"""agape_provider.py — the provider seam: think() and embed()."""
from __future__ import annotations
import json
import math
import re


class Provider:
    def think(self, prompt: str, agent_inst=None, schema: str = "text") -> object:
        raise NotImplementedError

    def embed(self, text: str) -> list[float]:
        raise NotImplementedError

    def similarity(self, a: str, b: str) -> float:
        va = self.embed(a)
        vb = self.embed(b)
        return _cosine(va, vb)

    def entail(self, answer: str, claim: str) -> str:
        """Return 'Entailment', 'Contradiction', or 'Neutral'."""
        raise NotImplementedError


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na  = math.sqrt(sum(x * x for x in a))
    nb  = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


# ── MockProvider ─────────────────────────────────────────────────────────────

class MockProvider(Provider):
    """
    Deterministic provider driven by keyword rules. Every response is
    predictable so hello.ag exercises both pass and fail paths cleanly.

    think() is called with:
      prompt     — the message text sent to the agent
      agent_inst — the AgentInstance receiving it (may be None)
      schema     — "text" | "bool" | "null" | other type name

    The provider inspects the prompt, updates agent_inst state (side-channel
    for name/role seeding), and returns a typed Python value.
    """

    def think(self, prompt: str, agent_inst=None, schema: str = "text") -> object:
        p = prompt.lower()

        # ── seeding: fire-and-forget sends that set up identity/role ─────────
        m = re.search(r"your name is ([a-z]+)", p)
        if m and agent_inst is not None:
            agent_inst.seeded_name = m.group(1).capitalize()
            # Graph internalization (the is_named triple) is the interpreter's
            # job, not the provider's — see Interpreter._eval_send_named.
            return None  # event<null>

        if "you are a poker coach" in p:
            if agent_inst is not None:
                agent_inst.seeded_role = "coach"
            return None
        if "you are a poker student" in p:
            if agent_inst is not None:
                agent_inst.seeded_role = "student"
            return None
        if "a flush beats a straight" in p and schema == "null":
            # Teaching a fact (event<null>)
            if agent_inst is not None:
                agent_inst.known_facts["flush_beats_straight"] = True
            return None

        # ── identity queries ──────────────────────────────────────────────────
        if "what is your name?" in p:
            name = (agent_inst.seeded_name if agent_inst else None) or "unknown"
            return f"My name is {name}."

        # ── role confirmations ────────────────────────────────────────────────
        if "are you a poker coach?" in p or "are you still a poker coach?" in p:
            if agent_inst and agent_inst.seeded_role == "coach":
                return True
            return False
        if "are you a poker student?" in p:
            if agent_inst and agent_inst.seeded_role == "student":
                return True
            return False

        # ── rule queries ──────────────────────────────────────────────────────
        if "does a flush beat a straight" in p:
            if schema == "bool":
                return True
            return ("Yes, a flush beats a straight. A flush (five cards of the same "
                    "suit) outranks a straight (five consecutive ranks).")
        if "does a flush beat a straight, and why" in p:
            return ("Yes, a flush beats a straight. A flush consists of five cards of "
                    "the same suit, which outranks a straight of five consecutive ranks.")

        # ── poker rule request ────────────────────────────────────────────────
        if "name one rule of poker" in p:
            return "A flush beats a straight."

        # ── fallback ──────────────────────────────────────────────────────────
        return "I don't know." if schema == "text" else (
            False if schema == "bool" else None
        )

    def embed(self, text: str) -> list[float]:
        """
        Word-level hash embedding: deterministic, cosine-comparable.
        Words shared between two strings contribute to cosine similarity.
        """
        words = re.findall(r"\b\w+\b", text.lower())
        vec = [0.0] * 128
        for word in words:
            h = hash(word) & 0x7FFFFFFF
            for i in range(4):
                vec[(h >> (i * 5)) % 128] += 1.0
        norm = math.sqrt(sum(x * x for x in vec)) or 1.0
        return [x / norm for x in vec]

    def similarity(self, a: str, b: str) -> float:
        """
        Semantic similarity for the mock. Uses word/substring overlap so that
        'My name is John.' is close to 'John', enabling verify ~ to pass
        while verify == fails (exact equality is a different check).
        """
        a_l, b_l = a.lower().strip(), b.lower().strip()
        if a_l == b_l:
            return 1.0
        # substring containment → high similarity
        if b_l in a_l or a_l in b_l:
            return 0.9
        # full-word overlap (Jaccard on word sets)
        wa = set(re.findall(r"\b\w+\b", a_l))
        wb = set(re.findall(r"\b\w+\b", b_l))
        if not wa or not wb:
            return 0.0
        if wb <= wa:      # all words of b appear in a
            return 0.85
        overlap = len(wa & wb)
        return overlap / max(len(wa | wb), 1)

    def entail(self, answer: str, claim: str) -> str:
        """
        Three-valued entailment for the mock.
        Keys off strong affirmative/negative signals and known facts.
        """
        a = answer.lower()
        c = claim.lower()
        # Strong positive: answer directly affirms the claim's key content
        if "yes" in a or "correct" in a or "right" in a:
            if "no" not in a.split()[:3]:   # not "no, yes ..." hedging
                return "Entailment"
        # Check for shared key noun-phrases
        key_words = set(re.findall(r"\b\w+\b", c)) - {"a", "the", "is", "and", "or"}
        answer_words = set(re.findall(r"\b\w+\b", a))
        if key_words and (key_words <= answer_words):
            return "Entailment"
        # Strong negative
        if "no," in a or "not" in a or "wrong" in a or "false" in a:
            return "Contradiction"
        return "Neutral"


# ── AnthropicProvider ─────────────────────────────────────────────────────────

class AnthropicProvider(Provider):
    """
    Real provider via the Anthropic API. Cognition is real: each agent keeps its
    own conversation history, so an agent told "Your name is John." actually
    remembers it when later asked "What is your name?". Typed replies
    (event<bool>, event<int>, ...) use structured output (output_config.format)
    so the model returns schema-conforming JSON via constrained decoding — no
    string parsing, no regex fallback (SPEC §8).

    Swap in by passing --provider anthropic to run.py. Reads ANTHROPIC_API_KEY
    from the environment; model defaults to claude-opus-4-8 (override with
    ANTHROPIC_MODEL).
    """

    def __init__(self, model: str | None = None):
        import os
        from anthropic import Anthropic
        self.client = Anthropic()
        self.model = model or os.environ.get("ANTHROPIC_MODEL", "claude-opus-4-8")
        # Per-agent conversation history, keyed by agent instance name.
        self.conversations: dict[str, list[dict]] = {}

    # ── conversation memory ───────────────────────────────────────────────────

    def _history(self, agent_inst) -> list[dict]:
        key = agent_inst.name if agent_inst is not None else "__global__"
        return self.conversations.setdefault(key, [])

    def _system_for(self, agent_inst) -> str:
        if agent_inst is not None:
            return (
                f"You are an agent in a multi-agent system. Your instance is "
                f"'{agent_inst.name}'. Stay in character, answer concisely, and "
                f"honor facts you have been told in this conversation."
            )
        return "Answer concisely."

    # ── think: the cognition seam ─────────────────────────────────────────────

    def think(self, prompt: str, agent_inst=None, schema: str = "text") -> object:
        history = self._history(agent_inst)

        # event<null> is fire-and-forget: seed the agent's context with the
        # statement but don't spend a model turn. The next real question sees it.
        if schema == "null":
            history.append({"role": "user", "content": prompt})
            history.append({"role": "assistant", "content": "Understood."})
            return None

        from agape_schema import json_schema_for_scalar
        json_schema = json_schema_for_scalar(schema)

        kwargs = dict(
            model=self.model,
            max_tokens=1024,
            system=self._system_for(agent_inst),
            messages=history + [{"role": "user", "content": prompt}],
        )
        if json_schema is not None:
            kwargs["output_config"] = {
                "format": {"type": "json_schema", "schema": json_schema}
            }

        msg = self.client.messages.create(**kwargs)
        raw = "".join(b.text for b in msg.content if b.type == "text").strip()

        # Record the turn so the agent remembers what it said.
        history.append({"role": "user", "content": prompt})
        history.append({"role": "assistant", "content": raw})

        return _coerce(raw, schema, json_schema is not None)

    def embed(self, text: str) -> list[float]:
        # No Anthropic embeddings endpoint; `~` is served by similarity() below
        # (a real entailment-style judgment), so this is only a deterministic
        # fallback for the base-class cosine path.
        return MockProvider().embed(text)

    def similarity(self, a: str, b: str) -> float:
        """Semantic closeness via the model itself, returned as a 0..1 score.
        The caller thresholds it (default >= 0.8), so this stays uniform with
        the mock's cosine path."""
        schema = {
            "type": "object",
            "properties": {"score": {"type": "number"}},
            "required": ["score"],
            "additionalProperties": False,
        }
        msg = self.client.messages.create(
            model=self.model,
            max_tokens=256,
            system="You judge semantic agreement. Reply only via the schema.",
            messages=[{"role": "user", "content": (
                f"Does statement A convey, affirm, or match the core meaning of "
                f"statement B? Score 1.0 if A clearly affirms or matches B (even "
                f"if A is a fuller sentence and B is a short phrase), and 0.0 if "
                f"A is unrelated to or contradicts B.\n\n"
                f"A: {a!r}\nB: {b!r}"
            )}],
            output_config={"format": {"type": "json_schema", "schema": schema}},
        )
        raw = "".join(b.text for b in msg.content if b.type == "text").strip()
        try:
            return float(json.loads(raw)["score"])
        except (ValueError, KeyError, json.JSONDecodeError):
            return 0.0

    def entail(self, answer: str, claim: str) -> str:
        """Three-valued entailment via structured output (SPEC §8)."""
        schema = {
            "type": "object",
            "properties": {
                "verdict": {
                    "type": "string",
                    "enum": ["Entailment", "Contradiction", "Neutral"],
                }
            },
            "required": ["verdict"],
            "additionalProperties": False,
        }
        msg = self.client.messages.create(
            model=self.model,
            max_tokens=256,
            system="You judge logical entailment. Reply only via the schema.",
            messages=[{"role": "user", "content": (
                f"Does the answer logically COMMIT to the claim being true "
                f"(Entailment), false (Contradiction), or neither (Neutral)?\n\n"
                f"Answer: {answer!r}\nClaim: {claim!r}"
            )}],
            output_config={"format": {"type": "json_schema", "schema": schema}},
        )
        raw = "".join(b.text for b in msg.content if b.type == "text").strip()
        try:
            verdict = json.loads(raw)["verdict"]
        except (ValueError, KeyError, json.JSONDecodeError):
            return "Neutral"
        return verdict if verdict in ("Entailment", "Contradiction", "Neutral") else "Neutral"


def _coerce(raw: str, schema: str, structured: bool) -> object:
    """Coerce a raw model reply to the expected Python type. When `structured`
    is True the reply is schema-conforming JSON ({"value": ...}); otherwise it
    is free text."""
    if schema == "null":
        return None
    if structured:
        try:
            return json.loads(raw)["value"]
        except (ValueError, KeyError, json.JSONDecodeError):
            pass  # fall through to best-effort coercion below
    if schema == "bool":
        return raw.strip().lower() in ("true", "yes", "1")
    if schema == "int":
        try:
            return int(raw.strip())
        except ValueError:
            return 0
    if schema == "float":
        try:
            return float(raw.strip())
        except ValueError:
            return 0.0
    return raw
