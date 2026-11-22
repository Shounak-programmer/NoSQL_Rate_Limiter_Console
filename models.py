"""
models.py — MongoDB Document Data-Model Layer
==============================================
Defines *how* each rate-limiting algorithm maps onto MongoDB collections,
BSON documents, and TTL indexes.

This module does **not** contain rate-limiting decision logic (that lives
in ``algorithms/``). Instead it provides:

* Collection names and client/database helpers
* TTL index setup for automatic garbage collection of expired state
* Read/clear inspection helpers for ``/status/{client_id}``
* Documentation of the MongoDB document schemas

MongoDB Document Schemas
------------------------

1. **Token Bucket** — Collection ``token_buckets``
   Document::

       {
           "_id": "<client_id>",
           "tokens": 9.0,
           "last_refill": 1700000000.123,
           "allowed": true,
           "expires_at": ISODate("...")
       }

2. **Sliding Window Log** — Collection ``sliding_windows``
   Document (uses an embedded array of UNIX timestamps)::

       {
           "_id": "<client_id>",
           "timestamps": [1700000001.1, 1700000002.4],
           "count": 2,
           "allowed": true,
           "expires_at": ISODate("...")
       }

3. **Fixed Window Counter** — Collection ``fixed_windows``
   Document::

       {
           "_id": "<client_id>:<window_id>",
           "client_id": "<client_id>",
           "window_id": 28333333,
           "count": 4,
           "allowed": true,
           "expires_at": ISODate("...")
       }

All three collections use a MongoDB **TTL index** on ``expires_at`` with
``expireAfterSeconds=0`` so stale documents are automatically purged.

CSE13202 — Unstructured Database Assignment
"""

from __future__ import annotations

import datetime
import time
from typing import Any, Dict, Optional

from bson import ObjectId
from pymongo import ASCENDING, MongoClient
from pymongo.database import Database

from config import settings

# ---------------------------------------------------------------------------
# Collection names
# ---------------------------------------------------------------------------

TOKEN_BUCKET_COLLECTION = "token_buckets"
SLIDING_WINDOW_COLLECTION = "sliding_windows"
FIXED_WINDOW_COLLECTION = "fixed_windows"


# ---------------------------------------------------------------------------
# MongoDB connection & index helpers
# ---------------------------------------------------------------------------

def get_mongo_client() -> MongoClient:
    """Return a configured ``pymongo.MongoClient`` with local fallback if remote is unreachable."""
    cfg = settings.mongo
    try:
        client = MongoClient(
            cfg.uri,
            serverSelectionTimeoutMS=cfg.server_selection_timeout_ms,
        )
        client.admin.command("ping")
        return client
    except Exception:
        # If remote Atlas cluster cannot be reached (e.g., dynamic IP change on local machine),
        # gracefully fall back to local mongod if running.
        if "127.0.0.1" not in cfg.uri and "localhost" not in cfg.uri:
            try:
                local_client = MongoClient("mongodb://127.0.0.1:27017", serverSelectionTimeoutMS=2000)
                local_client.admin.command("ping")
                return local_client
            except Exception:
                pass
        return MongoClient(
            cfg.uri,
            serverSelectionTimeoutMS=cfg.server_selection_timeout_ms,
        )


def get_database(client: Optional[MongoClient] = None) -> Database:
    """Return the target MongoDB database instance."""
    mongo_client = client or get_mongo_client()
    return mongo_client[settings.mongo.db_name]


def ensure_indexes(db: Database) -> None:
    """Create TTL and lookup indexes across all rate-limiter collections.

    Idempotent: MongoDB ignores index creation if the identical index
    already exists.
    """
    for coll_name in (
        TOKEN_BUCKET_COLLECTION,
        SLIDING_WINDOW_COLLECTION,
        FIXED_WINDOW_COLLECTION,
    ):
        db[coll_name].create_index(
            [("expires_at", ASCENDING)],
            expireAfterSeconds=0,
            name="ttl_expires_at",
        )

    db[FIXED_WINDOW_COLLECTION].create_index(
        [("client_id", ASCENDING)],
        name="idx_client_id",
    )


def fixed_window_doc_id(client_id: str, window_id: Optional[int] = None) -> str:
    """Build the ``_id`` for a Fixed Window Counter document."""
    if window_id is None:
        window_id = int(time.time()) // settings.rate_limit.window_seconds
    return f"{client_id}:{window_id}"


# ---------------------------------------------------------------------------
# State inspection helpers
# ---------------------------------------------------------------------------

def _sanitize_doc(doc: Any) -> Any:
    """Recursively stringify datetimes and ObjectIds for JSON serialization."""
    if doc is None:
        return None
    if isinstance(doc, (datetime.datetime, datetime.date)):
        return doc.isoformat()
    if isinstance(doc, ObjectId):
        return str(doc)
    if isinstance(doc, dict):
        return {str(k): _sanitize_doc(v) for k, v in doc.items()}
    if isinstance(doc, (list, tuple, set)):
        return [_sanitize_doc(v) for v in doc]
    return doc


def get_token_bucket_state(db: Database, client_id: str, raw: bool = False) -> Dict[str, Any]:
    """Read the current Token Bucket document for *client_id*."""
    doc = db[TOKEN_BUCKET_COLLECTION].find_one({"_id": client_id})
    max_req = settings.rate_limit.max_requests
    refill_rate = settings.rate_limit.refill_rate or (
        max_req / settings.rate_limit.window_seconds
    )

    if not doc:
        res = {
            "algorithm": "token_bucket",
            "client_id": client_id,
            "collection": TOKEN_BUCKET_COLLECTION,
            "limit": max_req,
            "remaining": max_req,
            "tokens": float(max_req),
            "last_refill": None,
            "exists": False,
        }
        if raw:
            res["document"] = None
        return res

    now = time.time()
    elapsed = max(0.0, now - float(doc.get("last_refill", now)))
    effective_tokens = min(
        float(max_req),
        float(doc.get("tokens", 0.0)) + elapsed * float(refill_rate),
    )

    res = {
        "algorithm": "token_bucket",
        "client_id": client_id,
        "collection": TOKEN_BUCKET_COLLECTION,
        "limit": max_req,
        "remaining": max(0, int(effective_tokens)),
        "tokens": round(effective_tokens, 3),
        "last_refill": doc.get("last_refill"),
        "expires_at": doc.get("expires_at").isoformat() if doc.get("expires_at") else None,
        "exists": True,
    }
    if raw:
        res["document"] = _sanitize_doc(doc)
    return res


def get_sliding_window_state(db: Database, client_id: str, raw: bool = False) -> Dict[str, Any]:
    """Read the current Sliding Window Log document for *client_id*."""
    doc = db[SLIDING_WINDOW_COLLECTION].find_one({"_id": client_id})
    max_req = settings.rate_limit.max_requests
    window_seconds = settings.rate_limit.window_seconds
    now = time.time()
    window_start = now - window_seconds

    if not doc:
        res = {
            "algorithm": "sliding_window",
            "client_id": client_id,
            "collection": SLIDING_WINDOW_COLLECTION,
            "limit": max_req,
            "remaining": max_req,
            "requests_in_window": 0,
            "total_entries": 0,
            "window_seconds": window_seconds,
            "exists": False,
        }
        if raw:
            res["document"] = None
        return res

    timestamps = doc.get("timestamps", [])
    active = [ts for ts in timestamps if ts > window_start]
    res = {
        "algorithm": "sliding_window",
        "client_id": client_id,
        "collection": SLIDING_WINDOW_COLLECTION,
        "limit": max_req,
        "remaining": max(0, max_req - len(active)),
        "requests_in_window": len(active),
        "total_entries": len(timestamps),
        "window_seconds": window_seconds,
        "expires_at": doc.get("expires_at").isoformat() if doc.get("expires_at") else None,
        "exists": True,
    }
    if raw:
        res["document"] = _sanitize_doc(doc)
    return res


def get_fixed_window_state(db: Database, client_id: str, raw: bool = False) -> Dict[str, Any]:
    """Read the current Fixed Window Counter document for *client_id*."""
    window_seconds = settings.rate_limit.window_seconds
    max_req = settings.rate_limit.max_requests
    now = time.time()
    window_id = int(now) // window_seconds
    doc_id = fixed_window_doc_id(client_id, window_id)
    doc = db[FIXED_WINDOW_COLLECTION].find_one({"_id": doc_id})

    count = int(doc.get("count", 0)) if doc else 0
    ttl_seconds = max(0, ((window_id + 1) * window_seconds) - int(now))

    res = {
        "algorithm": "fixed_window",
        "client_id": client_id,
        "collection": FIXED_WINDOW_COLLECTION,
        "document_id": doc_id,
        "window_id": window_id,
        "limit": max_req,
        "remaining": max(0, max_req - count),
        "request_count": count,
        "ttl_seconds": ttl_seconds,
        "expires_at": doc.get("expires_at").isoformat() if doc and doc.get("expires_at") else None,
        "exists": doc is not None,
    }
    if raw:
        res["document"] = _sanitize_doc(doc)
    return res


def get_client_state(db: Database, client_id: str, algorithm: str, raw: bool = False) -> Dict[str, Any]:
    """Dispatch to the appropriate state inspector based on *algorithm*."""
    dispatchers = {
        "token_bucket": get_token_bucket_state,
        "sliding_window": get_sliding_window_state,
        "fixed_window": get_fixed_window_state,
    }
    fn = dispatchers.get(algorithm)
    if fn is None:
        return {"error": f"Unknown algorithm: {algorithm}"}
    return fn(db, client_id, raw=raw)


def clear_client_state(db: Database, client_id: str) -> int:
    """Remove all rate-limit documents for *client_id* across collections."""
    deleted = 0
    res_tb = db[TOKEN_BUCKET_COLLECTION].delete_one({"_id": client_id})
    deleted += res_tb.deleted_count

    res_sw = db[SLIDING_WINDOW_COLLECTION].delete_one({"_id": client_id})
    deleted += res_sw.deleted_count

    res_fw = db[FIXED_WINDOW_COLLECTION].delete_many({"client_id": client_id})
    deleted += res_fw.deleted_count
    return deleted
