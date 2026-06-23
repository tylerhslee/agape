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
# Each Agape scalar compiles to a JSON Schema fragment. A provider that supports
# constrained decoding (e.g. AnthropicProvider via output_config.format) returns
# schema-conforming JSON; we parse it back to a typed Python value. There is NO
# regex fallback — a non-conforming response is a TypeMismatch, not silent garbage.

_SCALAR_JSON = {
    "text":  {"type": "string"},
    "bool":  {"type": "boolean"},
    "int":   {"type": "integer"},
    "float": {"type": "number"},
}


def json_value_schema(name: str, *, enum: list | None = None) -> dict:
    """
    Build a JSON Schema object wrapping a single typed `value` field.

    We always wrap the scalar in an object with `additionalProperties: false`
    and `required: ["value"]` — the shape structured-output decoding supports
    most reliably across providers. The caller reads `parsed["value"]`.

    `name` is an Agape scalar ("text" | "bool" | "int" | "float"); anything
    else (user/struct type) falls back to a string. Pass `enum` for closed sets
    (e.g. the Verdict variants).
    """
    if enum is not None:
        inner = {"type": "string", "enum": list(enum)}
    else:
        inner = _SCALAR_JSON.get(name, {"type": "string"})
    return {
        "type": "object",
        "properties": {"value": inner},
        "required": ["value"],
        "additionalProperties": False,
    }


class TypeMismatch(Exception):
    """Raised when a provider response does not conform to the declared schema."""
