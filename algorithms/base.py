"""
base.py — Abstract Base Class for Rate Limiters
=================================================
All algorithm implementations inherit from ``RateLimiter`` so the
FastAPI middleware can treat them uniformly.

CSE13202 — Unstructured Database Assignment
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Dict, Tuple

from pymongo.database import Database


# Type alias: (allowed?, metadata dict with limit, remaining, reset, retry_after)
RateLimitResult = Tuple[bool, Dict[str, Any]]


class RateLimiter(ABC):
    """Abstract rate limiter backed by MongoDB.

    Every concrete subclass must implement ``is_allowed`` which
    atomically checks and updates the client's state document in MongoDB.
    """

    def __init__(
        self,
        db: Database,
        max_requests: int,
        window_seconds: int,
        **kwargs: Any,
    ) -> None:
        self.db = db
        self.max_requests = max_requests
        self.window_seconds = window_seconds
        self._index_ready = False

    @abstractmethod
    def is_allowed(self, client_id: str) -> RateLimitResult:
        """Decide whether a request from *client_id* should be allowed.

        Returns
        -------
        allowed : bool
            ``True`` if the request may proceed.
        info : dict
            Metadata to include in HTTP response headers:
            - ``limit``       — max requests in the window / bucket capacity
            - ``remaining``   — how many requests the client has left
            - ``reset``       — UNIX timestamp when the window resets / refills
            - ``retry_after`` — seconds to wait before retrying (0 if allowed)
        """
        ...

    @property
    def algorithm_name(self) -> str:
        """Human-readable name used in logs and the ``/config`` endpoint."""
        return self.__class__.__name__
