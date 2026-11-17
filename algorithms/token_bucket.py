"""
token_bucket.py — Token Bucket Rate Limiter (MongoDB Document + Atomic Pipeline)
================================================================================
The Token Bucket algorithm allows short bursts up to ``max_requests`` while
enforcing a long-term average ``refill_rate`` (tokens/sec). Each request
consumes one token; if fewer than 1 token remain, the request is rejected.

MongoDB Data Model
------------------
Collection : ``token_buckets``
Document   ::

    {
        "_id": "<client_id>",
        "tokens": 8.5,
        "last_refill": 1700000000.123,
        "allowed": true,
        "expires_at": ISODate("...")
    }

Atomicity is guaranteed by MongoDB's single-document atomic
``find_one_and_update`` using an aggregation pipeline (MongoDB 4.2+),
performing read → refill → consume → persist in one round-trip with no
race conditions.

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
from models import TOKEN_BUCKET_COLLECTION


class TokenBucketLimiter(RateLimiter):
    """Token Bucket algorithm backed by MongoDB ``find_one_and_update``."""

    def __init__(
        self,
        db: Database,
        max_requests: int,
        window_seconds: int,
        refill_rate: float | None = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(db, max_requests, window_seconds, **kwargs)
        self.refill_rate: float = (
            float(refill_rate)
            if refill_rate is not None
            else max_requests / window_seconds
        )
        self.collection = self.db[TOKEN_BUCKET_COLLECTION]

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
        """Atomically refill and attempt to consume 1 token for *client_id*."""
        self._ensure_index()

        now = time.time()
        ttl_seconds = max(60, math.ceil(self.max_requests / self.refill_rate) * 2)
        expires_at = datetime.fromtimestamp(now + ttl_seconds, tz=timezone.utc)
        capacity = float(self.max_requests)
        rate = float(self.refill_rate)

        # Single-document atomic pipeline:
        # 1. Initialize missing fields for new clients (full bucket)
        # 2. Compute elapsed time and refill tokens up to capacity
        # 3. Check >= 1 token, decrement if allowed, record decision
        # 4. Strip temporary fields so the stored BSON document stays clean
        pipeline = [
            {
                "$set": {
                    "_prev_tokens": {"$ifNull": ["$tokens", capacity]},
                    "_prev_refill": {"$ifNull": ["$last_refill", now]},
                }
            },
            {
                "$set": {
                    "_refilled": {
                        "$min": [
                            capacity,
                            {
                                "$add": [
                                    "$_prev_tokens",
                                    {
                                        "$multiply": [
                                            {
                                                "$max": [
                                                    0.0,
                                                    {"$subtract": [now, "$_prev_refill"]},
                                                ]
                                            },
                                            rate,
                                        ]
                                    },
                                ]
                            },
                        ]
                    }
                }
            },
            {
                "$set": {
                    "allowed": {"$gte": ["$_refilled", 1.0]},
                    "tokens": {
                        "$cond": {
                            "if": {"$gte": ["$_refilled", 1.0]},
                            "then": {"$subtract": ["$_refilled", 1.0]},
                            "else": "$_refilled",
                        }
                    },
                    "last_refill": {"$max": [now, "$_prev_refill"]},
                    "expires_at": expires_at,
                }
            },
            {
                "$unset": ["_prev_tokens", "_prev_refill", "_refilled"],
            },
        ]

        doc = self.collection.find_one_and_update(
            {"_id": client_id},
            pipeline,
            upsert=True,
            return_document=ReturnDocument.AFTER,
        )

        allowed = bool(doc["allowed"])
        remaining_tokens = float(doc["tokens"])

        if remaining_tokens < 1.0 and self.refill_rate > 0:
            wait_seconds = (1.0 - remaining_tokens) / self.refill_rate
        else:
            wait_seconds = 0.0

        info: Dict[str, Any] = {
            "limit": self.max_requests,
            "remaining": max(0, int(remaining_tokens)),
            "reset": int(math.ceil(now + wait_seconds)),
            "retry_after": max(1, math.ceil(wait_seconds)) if not allowed else 0,
        }
        return allowed, info
