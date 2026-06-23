"""agape_provider.py — the provider seam: think() / embed() / similarity() / entail().

Two ideas matter here:

  1. THE SEAM. Agape code never names a provider. The interpreter only ever calls
     `think`, `embed`, `similarity`, and `entail`. Swap the provider class and not
     one line of Agape changes.

  2. IMPLICIT INTERNALIZATION (SPEC §10). Every message an agent receives is
     decomposed into facts/relationships against a CONTROLLED VOCABULARY (name,
     role, the flush-beats-straight rule). That decomposition is deterministic and
     provider-independent, so it lives in the base class and runs for every
     provider — the world graph the interpreter queries stays consistent whether
     cognition is mocked or real.

To run hello.ag against a real agent you only need to:

    pip install anthropic           # see requirements.txt
    export ANTHROPIC_API_KEY=sk-...
    python run.py hello.ag --provider anthropic
"""
from __future__ import annotations
import json
import math
import re

from agape_schema import json_value_schema, TypeMismatch


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

    # ── implicit internalization (shared, deterministic; SPEC §10) ────────────

    def internalize(self, prompt: str, agent_inst) -> bool:
        """
        Decompose a received message against the controlled vocabulary and write
        it into the agent's state (and, via the interpreter callback, the world
        graph). Returns True if the message was a pure seed/fact statement — i.e.
        fire-and-forget, no typed reply expected (`event<null>`).

        Every provider calls this so name/role/fact queries resolve the same way
        regardless of which provider answers the cognition.
        """
        if agent_inst is None:
            return False

        p = prompt.lower()
        seeded = False

        m = re.search(r"your name is ([a-z]+)", p)
        if m:
            name = m.group(1).capitalize()
            agent_inst.seeded_name = name
            cb = getattr(agent_inst, "_on_seed_name", None)
            if cb is not None:
                cb(name)
            seeded = True

        if "you are a poker coach" in p:
            agent_inst.seeded_role = "coach"
            seeded = True
        elif "you are a poker student" in p:
            agent_inst.seeded_role = "student"
            seeded = True

        # The teaching statement uses "beats"; the *query* uses "beat", so a
        # question like "Does a flush beat a straight?" does not match here.
        if "flush beats a straight" in p:
            agent_inst.known_facts["flush_beats_straight"] = True
            seeded = True

        return seeded


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na  = math.sqrt(sum(x * x for x in a))
    nb  = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


def _hash_embed(text: str) -> list[float]:
    """Word-level hash pseudo-vector: deterministic, fixed-dim, cosine-comparable.
    Words shared between two strings contribute to cosine similarity."""
    words = re.findall(r"\b\w+\b", text.lower())
    vec = [0.0] * 128
    for word in words:
        h = hash(word) & 0x7FFFFFFF
        for i in range(4):
            vec[(h >> (i * 5)) % 128] += 1.0
    norm = math.sqrt(sum(x * x for x in vec)) or 1.0
    return [x / norm for x in vec]


# ── MockProvider ─────────────────────────────────────────────────────────────

class MockProvider(Provider):
    """
    Deterministic provider driven by keyword rules. Every response is predictable
    so hello.ag exercises both pass and fail paths cleanly — and needs no API key.

    think() is called with:
      prompt     — the message text sent to the agent
      agent_inst — the AgentInstance receiving it (may be None)
      schema     — "text" | "bool" | "null" | other type name
    """

    def think(self, prompt: str, agent_inst=None, schema: str = "text") -> object:
        # Seeds / taught facts are internalized and bind no reply (event<null>).
        if self.internalize(prompt, agent_inst):
            return None

        p = prompt.lower()

        # ── identity queries ──────────────────────────────────────────────────
        if "what is your name?" in p:
            name = (agent_inst.seeded_name if agent_inst else None) or "unknown"
            return f"My name is {name}."

        # ── role confirmations ────────────────────────────────────────────────
        if "are you a poker coach?" in p or "are you still a poker coach?" in p:
            return bool(agent_inst and agent_inst.seeded_role == "coach")
        if "are you a poker student?" in p:
            return bool(agent_inst and agent_inst.seeded_role == "student")

        # ── rule queries ──────────────────────────────────────────────────────
        if "does a flush beat a straight, and why" in p:
            return ("Yes, a flush beats a straight. A flush consists of five cards of "
                    "the same suit, which outranks a straight of five consecutive ranks.")
        if "does a flush beat a straight" in p:
            if schema == "bool":
                return True
            return ("Yes, a flush beats a straight. A flush (five cards of the same "
                    "suit) outranks a straight (five consecutive ranks).")

        # ── poker rule request ────────────────────────────────────────────────
        if "name one rule of poker" in p:
            return "A flush beats a straight."

        # ── fallback ──────────────────────────────────────────────────────────
        if schema == "bool":
            return False
        if schema == "null":
            return None
        return "I don't know."

    def embed(self, text: str) -> list[float]:
        return _hash_embed(text)

    def similarity(self, a: str, b: str) -> float:
        """
        Semantic similarity for the mock. Uses word/substring overlap so that
        'My name is John.' is close to 'John' (verify ~ passes) while exact
        equality stays a separate, stricter check.
        """
        a_l, b_l = a.lower().strip(), b.lower().strip()
        if a_l == b_l:
            return 1.0
        if b_l in a_l or a_l in b_l:          # substring containment → high
            return 0.9
        wa = set(re.findall(r"\b\w+\b", a_l))
        wb = set(re.findall(r"\b\w+\b", b_l))
        if not wa or not wb:
            return 0.0
        if wb <= wa:                          # all words of b appear in a
            return 0.85
        return len(wa & wb) / max(len(wa | wb), 1)

    def entail(self, answer: str, claim: str) -> str:
        """Three-valued entailment for the mock, keyed off affirmative/negative signals."""
        a = answer.lower()
        c = claim.lower()
        if "yes" in a or "correct" in a or "right" in a:
            if "no" not in a.split()[:3]:     # not "no, yes ..." hedging
                return "Entailment"
        key_words = set(re.findall(r"\b\w+\b", c)) - {"a", "the", "is", "and", "or"}
        answer_words = set(re.findall(r"\b\w+\b", a))
        if key_words and (key_words <= answer_words):
            return "Entailment"
        if "no," in a or "not" in a or "wrong" in a or "false" in a:
            return "Contradiction"
        return "Neutral"


# ── AnthropicProvider ─────────────────────────────────────────────────────────

_AGENT_SYSTEM = (
    "You are an autonomous agent in a multi-agent system. You have a persistent "
    "identity and you remember everything said earlier in this conversation. "
    "Answer truthfully and concisely, based only on what you have been told. "
    "When asked your name, state it exactly as you were given it."
)

_SIMILARITY_SYSTEM = (
    "You judge semantic equivalence. Given two statements, return a single score "
    "in the 'value' field from 0.0 (unrelated) to 1.0 (the same meaning). Judge "
    "meaning, not wording — 'My name is John.' and 'John' are highly similar."
)

_ENTAIL_SYSTEM = (
    "You judge logical entailment between an answer and a claim. Return one of "
    "three variants in the 'value' field:\n"
    "  Entailment    — the answer commits to the claim being TRUE\n"
    "  Contradiction — the answer commits to the claim being FALSE\n"
    "  Neutral       — the answer neither confirms nor denies (silence is not denial)"
)


class AnthropicProvider(Provider):
    """
    Real cognition via the Anthropic API. Typed replies come back through
    constrained decoding (output_config.format with a JSON Schema), so there is
    no string parsing or regex fallback — exactly the seam contract in SPEC §8.

    Each agent gets a private, growing conversation so it genuinely remembers what
    it was told ("Your name is John." → later "What is your name?" → "My name is
    John."). Internalization into the world graph still happens deterministically
    in the base class, independent of what the model says.

    Anthropic has no embeddings endpoint, and hello.ag reaches similarity/entail
    through `similarity()`/`entail()` (not `embed()`), so those are answered by the
    model directly. `embed()` keeps the deterministic hash vectors as a dependency-
    free fallback for the (stubbed) `match` modality.
    """

    def __init__(self, model: str = "claude-opus-4-8", max_tokens: int = 512):
        from anthropic import Anthropic
        self.client = Anthropic()          # reads ANTHROPIC_API_KEY from the env
        self.model = model
        self.max_tokens = max_tokens
        self._histories: dict[str, list[dict]] = {}

    # ── core seam ─────────────────────────────────────────────────────────────

    def think(self, prompt: str, agent_inst=None, schema: str = "text") -> object:
        # Keep the interpreter's world graph / agent state consistent regardless
        # of cognition. Seeds bind no reply.
        is_seed = self.internalize(prompt, agent_inst)

        history = self._history_for(agent_inst)
        history.append({"role": "user", "content": prompt})

        if schema == "null" or is_seed:
            # Fire-and-forget. Record an acknowledgement so the conversation stays
            # well-formed for later turns, but spend no tokens on a reply.
            history.append({"role": "assistant", "content": "Understood."})
            return None

        value = self._structured_call(
            system=_AGENT_SYSTEM,
            messages=history,
            schema=json_value_schema(schema),
            record_into=history,
        )
        return _coerce(value, schema)

    def embed(self, text: str) -> list[float]:
        return _hash_embed(text)

    def similarity(self, a: str, b: str) -> float:
        value = self._structured_call(
            system=_SIMILARITY_SYSTEM,
            messages=[{"role": "user", "content": f"Statement A: {a}\nStatement B: {b}"}],
            schema=json_value_schema("float"),
        )
        try:
            score = float(value)
        except (TypeError, ValueError):
            raise TypeMismatch(f"similarity expected a number, got {value!r}")
        return max(0.0, min(1.0, score))

    def entail(self, answer: str, claim: str) -> str:
        variants = ["Entailment", "Contradiction", "Neutral"]
        value = self._structured_call(
            system=_ENTAIL_SYSTEM,
            messages=[{"role": "user", "content": f'Answer: "{answer}"\nClaim: "{claim}"'}],
            schema=json_value_schema("text", enum=variants),
        )
        if value not in variants:
            raise TypeMismatch(f"entail expected one of {variants}, got {value!r}")
        return value

    # ── internals ─────────────────────────────────────────────────────────────

    def _history_for(self, agent_inst) -> list[dict]:
        key = agent_inst.name if agent_inst is not None else "_global"
        return self._histories.setdefault(key, [])

    def _structured_call(self, *, system: str, messages: list[dict], schema: dict,
                         record_into: list[dict] | None = None) -> object:
        """One constrained-decoding call. Returns the parsed `value` field."""
        msg = self.client.messages.create(
            model=self.model,
            max_tokens=self.max_tokens,
            system=system,
            messages=messages,
            output_config={"format": {"type": "json_schema", "schema": schema}},
        )
        text = "".join(b.text for b in msg.content if b.type == "text")
        if record_into is not None:
            record_into.append({"role": "assistant", "content": text})
        try:
            data = json.loads(text)
        except json.JSONDecodeError as exc:
            raise TypeMismatch(f"provider returned non-JSON output: {text!r}") from exc
        if not isinstance(data, dict) or "value" not in data:
            raise TypeMismatch(f"provider response missing 'value': {data!r}")
        return data["value"]


def _coerce(value: object, schema: str) -> object:
    """Constrained decoding already gives us the right JSON type; this only
    normalizes the wrappers Agape uses (null, and bare scalars)."""
    if schema == "null":
        return None
    if schema == "bool":
        return bool(value)
    if schema == "int":
        return int(value)
    if schema == "float":
        return float(value)
    return value
