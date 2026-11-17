"""
test_limiter.py — Comprehensive Test Suite for the MongoDB Rate Limiter
=========================================================================
Exercises each algorithm (Token Bucket, Sliding Window Log, Fixed Window
Counter) directly against MongoDB, verifying:

  1. Requests are allowed up to ``max_requests``.
  2. Requests are blocked once the quota is exhausted.
  3. Requests recover after the window / refill period elapses.

Run directly:
    python test_limiter.py

Requires a running MongoDB server (defaults to ``mongodb://127.0.0.1:27017``,
override with ``MONGO_URI`` env var).

CSE13202 — Unstructured Database Assignment
"""

from __future__ import annotations

import json
import sys
import time
from typing import List, Tuple, Type

from pymongo.errors import PyMongoError

from algorithms.base import RateLimiter
from algorithms.fixed_window import FixedWindowLimiter
from algorithms.sliding_window import SlidingWindowLimiter
from algorithms.token_bucket import TokenBucketLimiter
from config import settings
from models import (
    FIXED_WINDOW_COLLECTION,
    SLIDING_WINDOW_COLLECTION,
    TOKEN_BUCKET_COLLECTION,
    clear_client_state,
    ensure_indexes,
    get_database,
    get_mongo_client,
)

# ---------------------------------------------------------------------------
# Test parameters — intentionally short window for fast feedback
# ---------------------------------------------------------------------------

TEST_MAX_REQUESTS = 5
TEST_WINDOW_SECONDS = 3
TEST_CLIENT_ID = "test-client-127.0.0.1"

# ANSI color helpers
GREEN = "\033[92m"
RED = "\033[91m"
YELLOW = "\033[93m"
CYAN = "\033[96m"
BOLD = "\033[1m"
RESET = "\033[0m"


def banner(text: str) -> None:
    """Print a section banner."""
    width = 64
    print(f"\n{'=' * width}")
    print(f"{BOLD}{CYAN}{text.center(width)}{RESET}")
    print(f"{'=' * width}")


def result_line(i: int, allowed: bool, info: dict) -> None:
    """Print one test-request result."""
    status = f"{GREEN}ALLOWED{RESET}" if allowed else f"{RED}BLOCKED{RESET}"
    remaining = info.get("remaining", "?")
    print(f"  Request {i:>2}: {status}  | remaining={remaining}  | info={info}")


def dump_sample_doc(db, collection_name: str, client_id: str) -> None:
    """Print the stored MongoDB BSON document for educational inspection."""
    if collection_name == FIXED_WINDOW_COLLECTION:
        doc = db[collection_name].find_one({"client_id": client_id})
    else:
        doc = db[collection_name].find_one({"_id": client_id})

    if doc:
        print(f"  {CYAN}Stored MongoDB doc ({collection_name}):{RESET}")
        print("   ", json.dumps(doc, default=str))


def test_algorithm(
    name: str,
    limiter_cls: Type[RateLimiter],
    db,
    collection_name: str,
    extra_kwargs: dict | None = None,
) -> bool:
    """Run allow → block → recover verification for one algorithm."""
    banner(f"Testing: {name}")
    print(f"  max_requests   = {TEST_MAX_REQUESTS}")
    print(f"  window_seconds = {TEST_WINDOW_SECONDS}")
    print()

    clear_client_state(db, TEST_CLIENT_ID)

    kwargs = {
        "db": db,
        "max_requests": TEST_MAX_REQUESTS,
        "window_seconds": TEST_WINDOW_SECONDS,
    }
    if extra_kwargs:
        kwargs.update(extra_kwargs)

    limiter = limiter_cls(**kwargs)
    passed = True

    # ---- Phase 1: Allowed up to limit ----
    print(f"  {YELLOW}Phase 1: Sending {TEST_MAX_REQUESTS} requests (expect ALL allowed){RESET}")
    for i in range(1, TEST_MAX_REQUESTS + 1):
        allowed, info = limiter.is_allowed(TEST_CLIENT_ID)
        result_line(i, allowed, info)
        if not allowed:
            print(f"  {RED}FAIL: request {i} should have been allowed!{RESET}")
            passed = False

    # ---- Phase 2: Blocked beyond limit ----
    extra_requests = 3
    print(f"\n  {YELLOW}Phase 2: Sending {extra_requests} more requests (expect ALL blocked){RESET}")
    for i in range(1, extra_requests + 1):
        allowed, info = limiter.is_allowed(TEST_CLIENT_ID)
        result_line(TEST_MAX_REQUESTS + i, allowed, info)
        if allowed:
            print(f"  {RED}FAIL: request {TEST_MAX_REQUESTS + i} should have been blocked!{RESET}")
            passed = False

    dump_sample_doc(db, collection_name, TEST_CLIENT_ID)

    # ---- Phase 3: Recovery after window / refill ----
    wait = TEST_WINDOW_SECONDS + 1
    print(f"\n  {YELLOW}Phase 3: Waiting {wait}s for recovery ...{RESET}")
    time.sleep(wait)

    allowed, info = limiter.is_allowed(TEST_CLIENT_ID)
    result_line(TEST_MAX_REQUESTS + extra_requests + 1, allowed, info)
    if not allowed:
        print(f"  {RED}FAIL: request should be allowed after recovery!{RESET}")
        passed = False

    clear_client_state(db, TEST_CLIENT_ID)

    if passed:
        print(f"\n  {GREEN}{BOLD}PASS: {name}{RESET}")
    else:
        print(f"\n  {RED}{BOLD}FAIL: {name}{RESET}")

    return passed


def main() -> None:
    print(f"{BOLD}MongoDB Rate Limiter — Test Suite{RESET}")
    print(f"Connecting to MongoDB ({settings.mongo.uri}, db={settings.mongo.db_name}) ...")

    try:
        client = get_mongo_client()
        client.admin.command("ping")
        db = get_database(client)
        ensure_indexes(db)
        print(f"{GREEN}Connected to MongoDB successfully.{RESET}\n")
    except PyMongoError as exc:
        print(f"{RED}Cannot connect to MongoDB: {exc}{RESET}")
        print("Ensure MongoDB is running locally or set MONGO_URI.")
        sys.exit(1)

    results: List[Tuple[str, bool]] = []

    ok = test_algorithm(
        name="Token Bucket (MongoDB Document + Atomic Pipeline)",
        limiter_cls=TokenBucketLimiter,
        db=db,
        collection_name=TOKEN_BUCKET_COLLECTION,
        extra_kwargs={"refill_rate": TEST_MAX_REQUESTS / TEST_WINDOW_SECONDS},
    )
    results.append(("Token Bucket", ok))

    ok = test_algorithm(
        name="Sliding Window Log (MongoDB Embedded Array + Atomic Pipeline)",
        limiter_cls=SlidingWindowLimiter,
        db=db,
        collection_name=SLIDING_WINDOW_COLLECTION,
    )
    results.append(("Sliding Window Log", ok))

    ok = test_algorithm(
        name="Fixed Window Counter (MongoDB Document + TTL Index)",
        limiter_cls=FixedWindowLimiter,
        db=db,
        collection_name=FIXED_WINDOW_COLLECTION,
    )
    results.append(("Fixed Window Counter", ok))

    client.close()

    banner("Test Summary")
    all_passed = True
    for name, ok in results:
        icon = f"{GREEN}PASS{RESET}" if ok else f"{RED}FAIL{RESET}"
        print(f"  [{icon}]  {name}")
        if not ok:
            all_passed = False

    print()
    if all_passed:
        print(f"{GREEN}{BOLD}All algorithm tests passed!{RESET}")
    else:
        print(f"{RED}{BOLD}Some tests failed — see details above.{RESET}")
        sys.exit(1)


if __name__ == "__main__":
    main()
