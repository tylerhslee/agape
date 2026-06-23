"""
The provider is the SEAM between the language's semantics and the actual
source of cognition. The evaluator never calls an LLM directly; it calls
provider.think(...) and provider.embed(...). Today that's the Anthropic API.
In the final vision it is the model running on the (emulated) substrate.
Swapping providers changes the mechanism, never the language.
"""

import math


class Provider:
    """Interface every provider must satisfy."""

    def think(self, prompt: str) -> str:
        """An agent receives an event; this produces its response."""
        raise NotImplementedError

    def embed(self, text: str) -> list[float]:
        """Map text into a vector so we can measure semantic similarity."""
        raise NotImplementedError


def cosine_similarity(a: list[float], b: list[float]) -> float:
    """Standard cosine similarity: 1.0 == identical direction, 0 == orthogonal."""
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


# ---------------------------------------------------------------------------
# StubProvider: used HERE, in the sandbox (no network, no key).
# Lets us watch the whole organism run and verify the plumbing is correct.
# It is deterministic and inspectable on purpose.
# ---------------------------------------------------------------------------

class StubProvider(Provider):
    def think(self, prompt: str) -> str:
        # A bodyless agent with no real model can't actually know your name.
        # This is exactly the honest answer, and matches your earlier pseudocode.
        return "I don't know"

    def embed(self, text: str) -> list[float]:
        # A toy, deterministic embedding: NOT semantic, just enough to exercise
        # the cosine math and the verify gate. Real meaning arrives with the
        # AnthropicProvider. Identical strings get identical vectors, so
        # exact matches score 1.0 and different strings score lower.
        vec = [0.0] * 26
        for ch in text.lower():
            if 'a' <= ch <= 'z':
                vec[ord(ch) - ord('a')] += 1.0
        return vec


# ---------------------------------------------------------------------------
# AnthropicProvider: used on YOUR machine (has key + network).
# Same interface. Drop it in and the agent genuinely thinks and verify
# genuinely compares meaning. No evaluator changes required.
# ---------------------------------------------------------------------------

class AnthropicProvider(Provider):
    def __init__(self, model="claude-sonnet-4-6"):
        # Imported lazily so the sandbox (which lacks the package) still runs.
        from anthropic import Anthropic
        self.client = Anthropic()          # reads ANTHROPIC_API_KEY from env
        self.model = model

    def think(self, prompt: str) -> str:
        msg = self.client.messages.create(
            model=self.model,
            max_tokens=256,
            messages=[{"role": "user", "content": prompt}],
        )
        return "".join(block.text for block in msg.content if block.type == "text")

    def embed(self, text: str) -> list[float]:
        # Embeddings via a sentence-transformers model loaded locally.
        # (Anthropic doesn't serve embeddings; this is the conventional choice.)
        from sentence_transformers import SentenceTransformer
        if not hasattr(self, "_emb"):
            self._emb = SentenceTransformer("all-MiniLM-L6-v2")
        return self._emb.encode(text).tolist()
