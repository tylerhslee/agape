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
