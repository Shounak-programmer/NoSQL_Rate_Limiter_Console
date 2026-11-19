"""
config.py — Centralized Configuration for the MongoDB Rate Limiter
===================================================================
This module holds every tuneable knob for the rate-limiter service.
Values are read from environment variables when available, falling back
to sensible defaults suitable for local MongoDB development.

CSE13202 — Unstructured Database Assignment
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:
    pass


class Algorithm(str, Enum):
    """Supported rate-limiting algorithms.

    Each algorithm maps to a tailored MongoDB document schema and atomic
    ``findOneAndUpdate`` aggregation pipeline.
    """

    TOKEN_BUCKET = "token_bucket"
    SLIDING_WINDOW = "sliding_window"
    FIXED_WINDOW = "fixed_window"


@dataclass
class MongoConfig:
    """Connection settings for the MongoDB server or Atlas cluster."""

    uri: str = field(
        default_factory=lambda: os.getenv("MONGO_URI", "mongodb://127.0.0.1:27017")
    )
    db_name: str = field(
        default_factory=lambda: os.getenv("MONGO_DB", "rate_limiter")
    )
    server_selection_timeout_ms: int = field(
        default_factory=lambda: int(os.getenv("MONGO_TIMEOUT_MS", "5000"))
    )


@dataclass
class RateLimitConfig:
    """Rate-limiting parameters shared across algorithms.

    Attributes
    ----------
    algorithm : Algorithm
        Which algorithm the middleware should use.
    max_requests : int
        Maximum number of requests allowed within the time window.
        - Token Bucket: bucket capacity (burst size).
        - Sliding Window Log: max timestamp entries in the window.
        - Fixed Window Counter: max count per window document.
    window_seconds : int
        Length of the rate-limit window in seconds.
        - Token Bucket: interval over which the bucket refills.
        - Sliding Window Log: look-back window duration.
        - Fixed Window Counter: window duration.
    refill_rate : float
        Tokens added per second (Token Bucket only). Defaults to
        ``max_requests / window_seconds`` so the bucket refills once per window.
    """

    algorithm: Algorithm = field(
        default_factory=lambda: Algorithm(
            os.getenv("RATE_LIMIT_ALGORITHM", Algorithm.TOKEN_BUCKET.value)
        )
    )
    max_requests: int = field(
        default_factory=lambda: int(os.getenv("RATE_LIMIT_MAX_REQUESTS", "10"))
    )
    window_seconds: int = field(
        default_factory=lambda: int(os.getenv("RATE_LIMIT_WINDOW_SECONDS", "60"))
    )
    refill_rate: Optional[float] = None  # computed in __post_init__

    def __post_init__(self) -> None:
        if self.refill_rate is None:
            env_rate = os.getenv("RATE_LIMIT_REFILL_RATE")
            if env_rate is not None:
                self.refill_rate = float(env_rate)
            else:
                self.refill_rate = self.max_requests / self.window_seconds


@dataclass
class AppConfig:
    """Top-level application configuration."""

    mongo: MongoConfig = field(default_factory=MongoConfig)
    rate_limit: RateLimitConfig = field(default_factory=RateLimitConfig)
    app_title: str = "MongoDB Rate Limiter — CSE13202"
    app_version: str = "2.0.0"


# ---------------------------------------------------------------------------
# Singleton-style global config — importable from anywhere
# ---------------------------------------------------------------------------
settings = AppConfig()
