"""agape_provider.py — the provider seam: think() and embed()."""
from __future__ import annotations
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
            # Also seed into world graph via the interpreter hook if available
            if hasattr(agent_inst, "_on_seed_name"):
                agent_inst._on_seed_name(agent_inst.seeded_name)
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
    Real provider via the Anthropic API. Uses constrained output (json_schema)
    for typed replies. Swap in by passing --provider anthropic to run.py.
    """

    def __init__(self, model: str = "claude-sonnet-4-6"):
        from anthropic import Anthropic
        self.client = Anthropic()
        self.model = model
        self._emb_model = None  # lazy-loaded sentence-transformers

    def think(self, prompt: str, agent_inst=None, schema: str = "text") -> object:
        from agape_schema import schema_for_type
        json_schema = schema_for_type(schema)
        msg = self.client.messages.create(
            model=self.model,
            max_tokens=512,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = "".join(b.text for b in msg.content if b.type == "text")
        return _coerce(raw, schema)

    def embed(self, text: str) -> list[float]:
        if self._emb_model is None:
            from sentence_transformers import SentenceTransformer
            self._emb_model = SentenceTransformer("all-MiniLM-L6-v2")
        return self._emb_model.encode(text).tolist()

    def entail(self, answer: str, claim: str) -> str:
        prompt = (
            f'Does the following answer logically commit to the claim being true, '
            f'false, or neither?\n\nAnswer: "{answer}"\nClaim: "{claim}"\n\n'
            f'Reply with exactly one word: Entailment, Contradiction, or Neutral.'
        )
        msg = self.client.messages.create(
            model=self.model,
            max_tokens=10,
            messages=[{"role": "user", "content": prompt}],
        )
        word = msg.content[0].text.strip()
        if "entailment" in word.lower():
            return "Entailment"
        if "contradiction" in word.lower():
            return "Contradiction"
        return "Neutral"


def _coerce(raw: str, schema: str) -> object:
    """Best-effort coerce a raw string to the expected Python type."""
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
    if schema == "null":
        return None
    return raw
