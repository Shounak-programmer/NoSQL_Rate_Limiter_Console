"""
app.py — FastAPI Application with MongoDB Rate-Limiting Middleware
==================================================================
Provides a REST API that demonstrates three rate-limiting algorithms
backed by MongoDB (Document Data Model). The middleware intercepts every
non-exempt request, applies the selected algorithm atomically via
``find_one_and_update``, and injects standard rate-limit HTTP headers.

Endpoints
---------
GET    /              — Hello / health endpoint
GET    /limited       — Explicitly rate-limited test endpoint
GET    /status/{id}   — Inspect the current rate-limit state for a client
DELETE /status/{id}   — Clear all rate-limit documents for a client
GET    /config        — View the running configuration
POST   /config        — Hot-reload algorithm / limits at runtime
GET    /dashboard     — Interactive web dashboard

CSE13202 — Unstructured Database Assignment
"""

from __future__ import annotations

import re
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Dict

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from pymongo.errors import PyMongoError

from algorithms import (
    FixedWindowLimiter,
    RateLimiter,
    SlidingWindowLimiter,
    TokenBucketLimiter,
)
from config import Algorithm, settings
from models import (
    clear_client_state,
    ensure_indexes,
    get_client_state,
    get_database,
    get_mongo_client,
)

# ---------------------------------------------------------------------------
# Global state — MongoDB client, database & current limiter
# ---------------------------------------------------------------------------

mongo_client = get_mongo_client()
db = get_database(mongo_client)


def _build_limiter() -> RateLimiter:
    """Instantiate the currently-configured rate limiter."""
    cfg = settings.rate_limit
    factory = {
        Algorithm.TOKEN_BUCKET: TokenBucketLimiter,
        Algorithm.SLIDING_WINDOW: SlidingWindowLimiter,
        Algorithm.FIXED_WINDOW: FixedWindowLimiter,
    }
    cls = factory[cfg.algorithm]
    kwargs: Dict[str, Any] = {
        "db": db,
        "max_requests": cfg.max_requests,
        "window_seconds": cfg.window_seconds,
    }
    if cfg.algorithm == Algorithm.TOKEN_BUCKET:
        kwargs["refill_rate"] = cfg.refill_rate
    return cls(**kwargs)


limiter: RateLimiter = _build_limiter()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Ensure MongoDB TTL and lookup indexes exist on startup."""
    try:
        ensure_indexes(db)
    except PyMongoError:
        # Allow app to start even if MongoDB starts slightly later;
        # each limiter also ensures its own index lazily.
        pass
    yield
    mongo_client.close()


# ---------------------------------------------------------------------------
# Application setup
# ---------------------------------------------------------------------------

app = FastAPI(
    title=settings.app_title,
    version=settings.app_version,
    description=(
        "A MongoDB-backed rate limiter showcasing three algorithms: "
        "Token Bucket, Sliding Window Log, and Fixed Window Counter."
    ),
    lifespan=lifespan,
)

# Allow cross-origin requests for the dashboard frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Rate-Limiting Middleware
# ---------------------------------------------------------------------------

_EXEMPT_PREFIXES = (
    "/docs",
    "/openapi.json",
    "/redoc",
    "/config",
    "/status",
    "/dashboard",
    "/static",
)


def _mask_uri(uri: str) -> str:
    """Hide credentials if a MongoDB URI contains username/password."""
    return re.sub(r"://([^:@]+):([^@]+)@", r"://\1:***@", uri)


@app.middleware("http")
async def rate_limit_middleware(request: Request, call_next) -> Response:
    """Apply rate limiting based on ``X-Client-ID`` header or client IP.

    Injects standard rate-limit headers into every response:
    - ``X-RateLimit-Limit``     — max allowed requests
    - ``X-RateLimit-Remaining`` — requests left in the window / bucket
    - ``X-RateLimit-Reset``     — UNIX timestamp when the window resets
    - ``Retry-After``           — seconds to wait (only on 429)
    """
    path = request.url.path

    # Skip rate limiting for docs, config, status, and dashboard assets
    if any(path.startswith(prefix) for prefix in _EXEMPT_PREFIXES):
        return await call_next(request)

    # Identify client: explicit header (great for testing) → proxy header → IP
    client_id: str = (
        request.headers.get("X-Client-ID")
        or request.headers.get("X-Forwarded-For")
        or (request.client.host if request.client else "unknown")
    ).strip()

    try:
        allowed, info = limiter.is_allowed(client_id)
    except PyMongoError as exc:
        return JSONResponse(
            status_code=503,
            content={
                "detail": "Database unavailable (MongoDB connection error).",
                "error": str(exc),
            },
        )

    if not allowed:
        response = JSONResponse(
            status_code=429,
            content={
                "detail": "Rate limit exceeded. Please slow down.",
                "client_id": client_id,
                "retry_after": info.get("retry_after", 1),
            },
        )
    else:
        response = await call_next(request)

    response.headers["X-RateLimit-Limit"] = str(info.get("limit", 0))
    response.headers["X-RateLimit-Remaining"] = str(info.get("remaining", 0))
    response.headers["X-RateLimit-Reset"] = str(info.get("reset", 0))
    if not allowed:
        response.headers["Retry-After"] = str(info.get("retry_after", 1))

    return response


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/", tags=["General"])
async def root() -> Dict[str, Any]:
    """Hello endpoint — confirms the service is running."""
    return {
        "message": "Welcome to the MongoDB Rate Limiter!",
        "database": "MongoDB",
        "db_name": settings.mongo.db_name,
        "algorithm": settings.rate_limit.algorithm.value,
        "max_requests": settings.rate_limit.max_requests,
        "window_seconds": settings.rate_limit.window_seconds,
        "dashboard": "/dashboard",
        "docs": "/docs",
    }


@app.get("/limited", tags=["General"])
async def limited_endpoint() -> Dict[str, str]:
    """An explicitly rate-limited endpoint for testing."""
    return {
        "message": "You got through! This endpoint is rate-limited.",
        "timestamp": str(time.time()),
    }


@app.get("/status/{client_id}", tags=["Monitoring"])
async def client_status(client_id: str) -> Dict[str, Any]:
    """Inspect the current rate-limit document for a specific client."""
    state = get_client_state(
        db, client_id, settings.rate_limit.algorithm.value
    )
    return {
        "client_id": client_id,
        "algorithm": settings.rate_limit.algorithm.value,
        "limit": state.get("limit", settings.rate_limit.max_requests),
        "remaining": state.get("remaining", 0),
        "state": state,
    }


@app.delete("/status/{client_id}", tags=["Monitoring"])
async def clear_status(client_id: str) -> Dict[str, Any]:
    """Clear all rate-limit documents for a client (useful for testing)."""
    deleted = clear_client_state(db, client_id)
    return {"client_id": client_id, "documents_deleted": deleted}


@app.get("/config", tags=["Configuration"])
async def get_config() -> Dict[str, Any]:
    """Return the running configuration."""
    return {
        "algorithm": settings.rate_limit.algorithm.value,
        "max_requests": settings.rate_limit.max_requests,
        "window_seconds": settings.rate_limit.window_seconds,
        "refill_rate": settings.rate_limit.refill_rate,
        "mongodb": {
            "uri": _mask_uri(settings.mongo.uri),
            "database": settings.mongo.db_name,
        },
    }


class ConfigUpdate(BaseModel):
    """Request body for ``POST /config``."""

    algorithm: Algorithm | None = Field(None, description="Rate-limiting algorithm")
    max_requests: int | None = Field(None, gt=0, description="Max requests per window")
    window_seconds: int | None = Field(None, gt=0, description="Window duration in seconds")
    refill_rate: float | None = Field(None, gt=0, description="Tokens/sec (Token Bucket only)")


@app.post("/config", tags=["Configuration"])
async def update_config(body: ConfigUpdate) -> Dict[str, Any]:
    """Hot-reload algorithm and/or limits at runtime."""
    global limiter

    if body.algorithm is not None:
        settings.rate_limit.algorithm = body.algorithm
    if body.max_requests is not None:
        settings.rate_limit.max_requests = body.max_requests
    if body.window_seconds is not None:
        settings.rate_limit.window_seconds = body.window_seconds

    if body.refill_rate is not None:
        settings.rate_limit.refill_rate = body.refill_rate
    elif body.max_requests is not None or body.window_seconds is not None:
        settings.rate_limit.refill_rate = (
            settings.rate_limit.max_requests / settings.rate_limit.window_seconds
        )

    limiter = _build_limiter()

    return {
        "message": "Configuration updated successfully.",
        "new_config": {
            "algorithm": settings.rate_limit.algorithm.value,
            "max_requests": settings.rate_limit.max_requests,
            "window_seconds": settings.rate_limit.window_seconds,
            "refill_rate": settings.rate_limit.refill_rate,
        },
    }


# ---------------------------------------------------------------------------
# Static files & Dashboard
# ---------------------------------------------------------------------------

STATIC_DIR = Path(__file__).parent / "static"
if STATIC_DIR.is_dir():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

    @app.get("/dashboard", tags=["General"], include_in_schema=False)
    async def dashboard():
        """Serve the interactive rate-limiter dashboard."""
        return FileResponse(str(STATIC_DIR / "index.html"))


# ---------------------------------------------------------------------------
# Entry point — ``python app.py``
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=True)
