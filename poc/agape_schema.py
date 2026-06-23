"""agape_schema.py — Agape type → JSON Schema + schema name extraction."""
from __future__ import annotations
import agape_ast as A


def schema_for_type(type_node) -> str:
    """Return the JSON Schema type string for a type node or string name."""
    if isinstance(type_node, str):
        return _scalar_schema(type_node)
    if isinstance(type_node, A.SimpleType):
        return _scalar_schema(type_node.name)
    if isinstance(type_node, A.EventType):
        return schema_for_type(type_node.inner)
    return "text"


def _scalar_schema(name: str) -> str:
    return {
        "int":    "int",
        "float":  "float",
        "bool":   "bool",
        "text":   "text",
        "null":   "null",
    }.get(name, name)  # fall through to user type name


def type_name(type_node) -> str:
    """Return a short string name for a type node (for display/schema lookup)."""
    if isinstance(type_node, str):
        return type_node
    if isinstance(type_node, A.SimpleType):
        return type_node.name
    if isinstance(type_node, A.EventType):
        return type_name(type_node.inner)
    return "unknown"


def is_event_type(type_node) -> bool:
    return isinstance(type_node, A.EventType)


# ── JSON Schema bridge (SPEC §8) ──────────────────────────────────────────────
#
# Each Agate scalar type compiles to a JSON Schema. The Anthropic provider passes
# this to `output_config.format` so the model returns schema-conforming JSON via
# constrained decoding (no regex fallback). Scalars are wrapped in a one-field
# object because structured-output schemas must be objects at the top level; the
# provider unwraps the `value` field back into a typed Python value.

_SCALAR_JSON = {
    "bool":  {"type": "boolean"},
    "int":   {"type": "integer"},
    "float": {"type": "number"},
    "text":  {"type": "string"},
}


def json_schema_for_scalar(name: str):
    """Return a JSON Schema dict for a scalar type, or None if no constraint
    is needed (free text / null). The schema wraps the value in an object so it
    is a valid top-level structured-output format."""
    if name in ("text", "null"):
        return None  # free-form text; null is fire-and-forget
    inner = _SCALAR_JSON.get(name)
    if inner is None:
        return None  # user/struct type — POC treats as free text
    return {
        "type": "object",
        "properties": {"value": inner},
        "required": ["value"],
        "additionalProperties": False,
    }
