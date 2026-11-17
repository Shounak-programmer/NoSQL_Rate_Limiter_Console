"""
sliding_window.py — Sliding Window Log Rate Limiter (MongoDB Embedded Array)
==============================================================================
The Sliding Window Log records the exact timestamp of every accepted request
inside a look-back window. A new request is allowed only when the number of
active timestamps in ``(now - window_seconds, now]`` is below ``max_requests``.

MongoDB Data Model
------------------
Collection : ``sliding_windows``
Document   ::

    {
        "_id": "<client_id>",
        "timestamps": [1700000001.12, 1700000002.45],
        "count": 2,
        "allowed": true,
        "expires_at": ISODate("...")
    }

Using an embedded BSON array inside a single per-client document lets us
prune expired timestamps with ``$filter``, check ``$size``, and append
with ``$concatArrays`` atomically inside one ``find_one_and_update`` call.

CSE13202 — Unstructured Database Assignment
"""

from __future__ import annotations

import math
import time
from datetime import datetime, timezone
from typing import Any, Dict, List

from pymongo import ASCENDING, ReturnDocument
from pymongo.database import Database

from algorithms.base import RateLimiter, RateLimitResult
from models import SLIDING_WINDOW_COLLECTION


class SlidingWindowLimiter(RateLimiter):
    """Sliding Window Log backed by MongoDB embedded arrays + TTL index."""

    def __init__(
        self,
        db: Database,
        max_requests: int,
        window_seconds: int,
        **kwargs: Any,
    ) -> None:
        super().__init__(db, max_requests, window_seconds, **kwargs)
        self.collection = self.db[SLIDING_WINDOW_COLLECTION]

    def _ensure_index(self) -> None:
        """Ensure the TTL index on ``expires_at`` exists."""
        if not self._index_ready:
            self.collection.create_index(
                [("expires_at", ASCENDING)],
                expireAfterSeconds=0,
                name="ttl_expires_at",
            )
            self._index_ready = True

    def is_allowed(self, client_id: str) -> RateLimitResult:
        """Atomically prune old timestamps and log the request if under limit."""
        self._ensure_index()

        now = time.time()
        window_start = now - self.window_seconds
        ttl_seconds = max(60, self.window_seconds * 2)
        expires_at = datetime.fromtimestamp(now + ttl_seconds, tz=timezone.utc)

        # Single-document atomic pipeline:
        # 1. Filter out timestamps outside the current sliding window
        # 2. If active count < max_requests, append `now` and allow; else reject
        # 3. Store active count for easy inspection and drop temporary field
        pipeline = [
            {
                "$set": {
                    "_valid": {
                        "$filter": {
                            "input": {"$ifNull": ["$timestamps", []]},
                            "as": "ts",
                            "cond": {"$gt": ["$$ts", window_start]},
                        }
                    }
                }
            },
            {
                "$set": {
                    "allowed": {"$lt": [{"$size": "$_valid"}, self.max_requests]},
                    "timestamps": {
                        "$cond": {
                            "if": {"$lt": [{"$size": "$_valid"}, self.max_requests]},
                            "then": {"$concatArrays": ["$_valid", [now]]},
                            "else": "$_valid",
                        }
                    },
                    "expires_at": expires_at,
                }
            },
            {
                "$set": {
                    "count": {"$size": "$timestamps"},
                }
            },
            {
                "$unset": ["_valid"],
            },
        ]

        doc = self.collection.find_one_and_update(
            {"_id": client_id},
            pipeline,
            upsert=True,
            return_document=ReturnDocument.AFTER,
        )

        allowed = bool(doc["allowed"])
        timestamps: List[float] = doc.get("timestamps", [])
        current_count = len(timestamps)
        remaining = max(0, self.max_requests - current_count)

        # Compute accurate reset/retry time from the oldest timestamp in window
        if timestamps:
            oldest_expires_at = float(timestamps[0]) + self.window_seconds
            wait_seconds = max(0.0, oldest_expires_at - now)
        else:
            wait_seconds = float(self.window_seconds)

        info: Dict[str, Any] = {
            "limit": self.max_requests,
            "remaining": remaining,
            "reset": int(math.ceil(now + wait_seconds)),
            "retry_after": max(1, math.ceil(wait_seconds)) if not allowed else 0,
        }
        return allowed, info
