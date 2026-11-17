# Data Model Deep Dive — MongoDB for Rate Limiting

This document explains the **Document Data Model** used in this rate limiter, why MongoDB fits an unstructured database design, how single-document atomicity replaces distributed locks, and the time/space trade-offs of each algorithm.

---

## Table of Contents

1. [Why a Document Store (MongoDB)?](#why-a-document-store-mongodb)
2. [MongoDB Design Patterns for Rate Limiting](#mongodb-design-patterns-for-rate-limiting)
3. [Collection 1: `token_buckets` (Token Bucket)](#1-token-bucket--token_buckets)
4. [Collection 2: `sliding_windows` (Sliding Window Log)](#2-sliding-window-log--sliding_windows)
5. [Collection 3: `fixed_windows` (Fixed Window Counter)](#3-fixed-window-counter--fixed_windows)
6. [Atomicity Without Transactions: `findOneAndUpdate` Pipelines](#atomicity-without-transactions-findoneandupdate-pipelines)
7. [TTL Index Cleanup & Precision](#ttl-index-cleanup--precision)
8. [Complexity & Memory Analysis](#complexity--memory-analysis)

---

## Why a Document Store (MongoDB)?

A rate limiter stores per-client state whose structure varies dramatically depending on the algorithm:
- **Token Bucket** needs floating-point counters and refill timestamps (`tokens`, `last_refill`).
- **Sliding Window Log** needs an ordered variable-length history of request timestamps (`timestamps: [...]`).
- **Fixed Window Counter** needs time-bucketed counters (`client_id`, `window_id`, `count`).

In a relational database (SQL), switching or supporting multiple rate-limiting structures requires multiple rigid tables, joins, or separate log rows with expensive `DELETE` sweeps. In **MongoDB**:
1. **Self-contained BSON documents** hold each client's complete state under a single `_id` index.
2. **Embedded arrays** (`timestamps`) keep all active window hits in one document, enabling O(1) document lookup by `_id`.
3. **Single-document ACID atomicity** guarantees safe concurrent updates via `findOneAndUpdate` with aggregation pipelines (MongoDB 4.2+).
4. **Native TTL indexes** automatically garbage-collect stale rate-limit documents in the background without cron jobs.
5. **Durability & observability**: unlike pure ephemeral caches, documents are queryable and inspectable anytime in MongoDB Compass or via `GET /status/{client_id}`.

---

## MongoDB Design Patterns for Rate Limiting

| Algorithm | Collection | `_id` Strategy | Core MongoDB Feature Used |
|---|---|---|---|
| **Token Bucket** | `token_buckets` | `<client_id>` | Aggregation pipeline arithmetic (`$min`, `$max`, `$subtract`, `$multiply`) |
| **Sliding Window Log** | `sliding_windows` | `<client_id>` | Embedded array + `$filter`, `$size`, `$concatArrays` |
| **Fixed Window Counter** | `fixed_windows` | `<client_id>:<window_id>` | Composite `_id` + TTL index (`expireAfterSeconds: 0`) |

---

## 1. Token Bucket → `token_buckets`

### Document Schema

```json
{
  "_id": "192.168.1.42",
  "tokens": 7.35,
  "last_refill": 1700000000.123,
  "allowed": true,
  "expires_at": ISODate("2026-11-11T08:30:00Z")
}
```

### Why This Schema?

Token Bucket requires reading `tokens` and `last_refill`, computing `min(capacity, tokens + (now - last_refill) * rate)`, checking if `>= 1`, subtracting `1` when allowed, and storing both updated values together. Placing both fields in one BSON document lets `findOneAndUpdate` perform the entire read-refill-consume-write cycle under a single document lock.

### Atomic Pipeline Walkthrough

1. **Stage 1 (`$set`)**: Initialize `_prev_tokens = max_requests` and `_prev_refill = now` via `$ifNull` if this is a brand-new client (`upsert: true`).
2. **Stage 2 (`$set`)**: Compute `_refilled = min(capacity, _prev_tokens + max(0, now - _prev_refill) * rate)`.
3. **Stage 3 (`$set`)**:
   - `allowed = (_refilled >= 1.0)`
   - `tokens = _refilled - 1.0` if allowed else `_refilled`
   - `last_refill = max(now, _prev_refill)`
   - `expires_at = now + ttl_seconds`
4. **Stage 4 (`$unset`)**: Remove temporary `_prev_*` and `_refilled` fields so the stored document remains minimal.

---

## 2. Sliding Window Log → `sliding_windows`

### Document Schema

```json
{
  "_id": "192.168.1.42",
  "timestamps": [1700000001.001, 1700000002.523, 1700000008.887],
  "count": 3,
  "allowed": true,
  "expires_at": ISODate("2026-11-11T08:30:00Z")
}
```

### Why Embedded Array Instead of One-Doc-Per-Request?

If every request inserted its own document into a `request_logs` collection:
- Checking the count (`countDocuments`) and inserting (`insertOne`) would be **two separate database round-trips**, creating a race condition where concurrent requests pass the check simultaneously.
- Preventing that race would require **multi-document ACID transactions**, which only work on MongoDB Replica Sets and add locking overhead.

By embedding `timestamps` inside a single document keyed by `_id: client_id`, pruning expired timestamps (`$filter`), checking capacity (`$lt: [{$size: ...}, max_requests]`), and appending (`$concatArrays`) happen **atomically in a single `findOneAndUpdate`**, working identically on standalone `mongod`, Replica Sets, and MongoDB Atlas.

> **Practical limit:** MongoDB documents are capped at 16 MB (~2 million `double` timestamps), which far exceeds normal API per-client rate-limit windows.

---

## 3. Fixed Window Counter → `fixed_windows`

### Document Schema

```json
{
  "_id": "192.168.1.42:28333333",
  "client_id": "192.168.1.42",
  "window_id": 28333333,
  "count": 5,
  "allowed": true,
  "expires_at": ISODate("2026-11-11T08:25:00Z")
}
```

### Why Composite `_id` + Pipeline Cap?

- `window_id = floor(now / window_seconds)` gives each time slice a deterministic `_id`.
- Instead of blind `$inc` followed by a compensating `$inc: -1` (which temporarily inflates `count` past `max_requests`), the 3-stage pipeline checks `_prev_count < max_requests` **before** incrementing, keeping `count` accurately capped at `max_requests`.
- `expires_at` is set to the exact end of the window (`(window_id + 1) * window_seconds`), letting MongoDB's TTL background thread automatically purge closed windows.

---

## Atomicity Without Transactions: `findOneAndUpdate` Pipelines

A naive application-level implementation:
```python
doc = col.find_one({"_id": client_id})   # Thread A & Thread B both read count = 9
if doc["count"] < 10:
    col.update_one(..., {"$inc": ...})   # Both threads write -> count = 11 (RACE CONDITION!)
```

By using **aggregation-pipeline updates** inside `find_one_and_update(..., return_document=ReturnDocument.AFTER)`:
- MongoDB acquires an exclusive document-level latch while evaluating all pipeline stages.
- Both threads serialize cleanly on the single document.
- Recording `"allowed": true/false` directly in the returned document guarantees the caller receives the exact decision made during that atomic step.

---

## TTL Index Cleanup & Precision

All three collections define:
```python
collection.create_index([("expires_at", ASCENDING)], expireAfterSeconds=0)
```

**Important MongoDB detail:** MongoDB's TTL monitor thread runs approximately **once every 60 seconds**. Therefore:
- **Correctness never depends on the TTL thread running on the exact second**:
  - *Token Bucket* recomputes refill from `last_refill`.
  - *Sliding Window* filters `timestamps > now - window_seconds` on every request.
  - *Fixed Window* isolates each window by `window_id` in `_id`.
- **Role of the TTL index:** Purely automatic storage reclamation so idle client documents don't accumulate indefinitely.

---

## Complexity & Memory Analysis

| Algorithm | Time Complexity (per request) | Document Size (per active client) | Accuracy |
|---|---|---|---|
| **Token Bucket** | **O(1)** (`_id` B-tree lookup + arithmetic) | ~120 bytes (constant) | Smooth bursts + steady average rate |
| **Sliding Window Log** | **O(W)** where W = `max_requests` in window | ~100 bytes + 8 bytes × W | Exact; zero boundary burst spikes |
| **Fixed Window Counter** | **O(1)** (`_id` B-tree lookup + increment) | ~140 bytes (constant per window) | Allows up to 2× burst across window edge |
