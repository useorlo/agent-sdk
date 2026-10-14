# Compatibility layer for langchain-core, an optional dependency. Imports what the adapter needs
# from it, with fallbacks so the package still imports without it, and defines to_jsonable, which
# callbacks.py and wrappers.py use to turn LangChain objects and other values into JSON for Orlo.

from __future__ import annotations

from typing import Any

try:  # pragma: no cover - exercised only when langchain-core is installed
    from langchain_core.callbacks import AsyncCallbackHandler  # type: ignore
except Exception:  # pragma: no cover - fallback keeps package importable
    class AsyncCallbackHandler:  # type: ignore
        """Fallback base class when langchain-core is not installed."""

        pass


try:  # pragma: no cover - exercised only when langchain-core is installed
    from langchain_core.runnables import Runnable, ensure_config  # type: ignore
except Exception:  # pragma: no cover - fallback keeps package importable
    Runnable = None  # type: ignore
    ensure_config = None  # type: ignore


def current_run_id() -> str | None:
    # Inside a LangChain run (such as a tool function) the active config holds the callbacks for
    # that run's children, so their parent is the run itself.
    if ensure_config is None:
        return None
    run_id = getattr(ensure_config().get("callbacks"), "parent_run_id", None)
    return str(run_id) if run_id else None


def is_runnable(value: Any) -> bool:
    return Runnable is not None and isinstance(value, Runnable)


def to_jsonable(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(key): to_jsonable(inner) for key, inner in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [to_jsonable(item) for item in value]
    if hasattr(value, "model_dump"):
        return to_jsonable(value.model_dump())
    if hasattr(value, "dict"):
        return to_jsonable(value.dict())
    if hasattr(value, "__dict__"):
        return to_jsonable(vars(value))
    return str(value)
