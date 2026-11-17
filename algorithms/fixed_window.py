"""
fixed_window.py — Fixed Window Counter Rate Limiter (MongoDB Document + TTL)
==============================================================================
The Fixed Window Counter divides time into discrete, non-overlapping windows
of ``window_seconds`` length. Each window document holds an integer counter
starting at 0; once the counter reaches ``max_requests``, further requests in
that window are rejected.

MongoDB Data Model
------------------
Collection : ``fixed_windows``
Document   ::

    {
        "_id": "<client_id>:<window_id>",
        "client_id": "<client_id>",
        "window_id": 28333333,
        "count": 4,
        "allowed": true,
        "expires_at": ISODate("...")
    }

``window_id`` is ``floor(now / window_seconds)``, and a TTL index on
``expires_at`` automatically purges old window documents once they expire.

CSE13202 — Unstructured Database Assignment
"""

from __future__ import annotations

import math
import time
from datetime import datetime, timezone
from typing import Any, Dict

from pymongo import ASCENDING, ReturnDocument
from pymongo.database import Database

from algorithms.base import RateLimiter, RateLimitResult
from models import FIXED_WINDOW_COLLECTION, fixed_window_doc_id


class FixedWindowLimiter(RateLimiter):
    """Fixed Window Counter backed by MongoDB atomic ``find_one_and_update``."""

    def __init__(
        self,
        db: Database,
        max_requests: int,
        window_seconds: int,
        **kwargs: Any,
    ) -> None:
        super().__init__(db, max_requests, window_seconds, **kwargs)
        self.collection = self.db[FIXED_WINDOW_COLLECTION]

    def _ensure_index(self) -> None:
        """Ensure TTL and ``client_id`` lookup indexes exist."""
        if not self._index_ready:
            self.collection.create_index(
                [("expires_at", ASCENDING)],
                expireAfterSeconds=0,
                name="ttl_expires_at",
            )
            self.collection.create_index(
                [("client_id", ASCENDING)],
                name="idx_client_id",
            )
            self._index_ready = True

    def is_allowed(self, client_id: str) -> RateLimitResult:
        """Atomically check and increment the current window counter."""
        self._ensure_index()

        now = time.time()
        window_id = int(now) // self.window_seconds
        doc_id = fixed_window_doc_id(client_id, window_id)
        window_end_ts = (window_id + 1) * self.window_seconds
        window_end_dt = datetime.fromtimestamp(window_end_ts, tz=timezone.utc)

        # Single-document atomic pipeline:
        # 1. Read existing count (or initialize to 0) and preserve window metadata
        # 2. If count < max_requests, increment and allow; else cap count and deny
        # 3. Clean up temporary field
        pipeline = [
            {
                "$set": {
                    "_prev_count": {"$ifNull": ["$count", 0]},
                    "client_id": client_id,
                    "window_id": window_id,
                    "expires_at": {"$ifNull": ["$expires_at", window_end_dt]},
                }
            },
            {
                "$set": {
                    "allowed": {"$lt": ["$_prev_count", self.max_requests]},
                    "count": {
                        "$cond": {
                            "if": {"$lt": ["$_prev_count", self.max_requests]},
                            "then": {"$add": ["$_prev_count", 1]},
                            "else": "$_prev_count",
                        }
                    },
                }
            },
            {
                "$unset": ["_prev_count"],
            },
        ]

        doc = self.collection.find_one_and_update(
            {"_id": doc_id},
            pipeline,
            upsert=True,
            return_document=ReturnDocument.AFTER,
        )

        allowed = bool(doc["allowed"])
        current_count = int(doc["count"])
        remaining = max(0, self.max_requests - current_count)
        ttl_remaining = max(1, math.ceil(window_end_ts - now))

        info: Dict[str, Any] = {
            "limit": self.max_requests,
            "remaining": remaining,
            "reset": int(window_end_ts),
            "retry_after": ttl_remaining if not allowed else 0,
        }
        return allowed, info
