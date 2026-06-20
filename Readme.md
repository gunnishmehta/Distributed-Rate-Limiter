# Distributed Rate Limiter

A Redis-backed rate limiter built in deliberate stages, as a learning project — each phase
introduces one concept (a naive implementation, a data structure, a race condition, an atomic
fix) before moving to the next. The commit history and this README reflect that progression
rather than a finished product shipped all at once.

If you're reading this to see how the project evolved: start with [The Race Condition Story](#the-race-condition-story-naive-vs-atomic)
below — it's the most interesting part and the reason half of this exists.

## Why this project

Most rate limiter tutorials show you one algorithm and call it done. The goal here was to
build three, on purpose, in increasing order of complexity, and to *feel* a real concurrency
bug before fixing it properly — not just read about race conditions, but write code that has
one, prove it with a test, and then close it with an atomic Redis/Lua script.

## Tech Stack

- **Node.js + Express** — HTTP API
- **Redis** (`ioredis` client) — counters, sorted sets, hashes, and Lua scripting
- **Docker Compose** — Redis + app running as two containers
- **Vitest** — unit and concurrency tests

## Project Structure

```
.
├── docker-compose.yml          # redis + node-app services
├── Dockerfile
├── .env                        # REDIS_HOST, REDIS_PORT, NODE_APP_PORT
├── src/
│   ├── server.js                # Express app, routes
│   ├── redis/
│   │   ├── client.js             # single shared ioredis instance
│   │   └── scripts/
│   │       ├── fixedWindow.lua    # atomic fixed window (INCR + EXPIRE + TTL)
│   │       └── tokenBucket.lua    # atomic token bucket (read-refill-consume)
│   └── algorithms/
│       ├── fixedWindow.js         # naive, "truly naive", and Lua-backed versions
│       ├── slidingWindowLog.js    # Redis sorted-set (ZADD/ZREMRANGEBYSCORE/ZCARD) based
│       └── tokenBucket.js         # plain-JS and Lua-backed versions
└── tests/
    └── concurrency.test.js       # proves the race condition, and proves the fix
```

## Algorithms

Three rate-limiting strategies are implemented behind one endpoint, picked via a query param.

### 1. Fixed Window Counter

Counts requests per key within a fixed-size time bucket (e.g. "max 10 requests per 60s"),
using `INCR` + `EXPIRE` on a single Redis key.

- **Pros:** O(1) memory per key — just one integer.
- **Cons:** boundary burst problem. A client can send a full `limit` worth of requests right
  before a window boundary, and another full `limit` right after — 2x the intended rate in a
  short span, because the window resets at fixed clock boundaries rather than sliding.

### 2. Sliding Window Log

Stores every request's timestamp in a Redis sorted set (`ZADD`), trims anything outside the
current window on each check (`ZREMRANGEBYSCORE`), and counts what's left (`ZCARD`).

- **Pros:** perfectly accurate — no boundary burst, since the window slides continuously with
  "now" instead of snapping to clock boundaries.
- **Cons:** memory cost scales with the number of requests *within* the window. A limit of
  10,000 req/min means up to 10,000 stored timestamps per key.

### 3. Token Bucket

A bucket holds tokens up to some capacity; tokens refill continuously at a steady rate
(`limit / windowSeconds` tokens per second); each request consumes one token if available.

- **Pros:** allows natural bursts after idle periods, while capping sustained throughput to
  the refill rate — a more realistic model for API quotas than a hard window.
- **Cons:** the most complex of the three to implement correctly (refill math, fractional
  token precision, and — as below — atomicity).

## The Race Condition Story (naive vs. atomic)

This is the core of the project. The race condition isn't abstract — here's exactly what it
looks like and how it gets fixed.

### The bug: check-then-act across separate Redis round trips

A naive rate limiter often looks like this:

```js
const current = await redisClient.get(key);      // read
if (parseInt(current) < limit) {                  // check, in application code
    await redisClient.incr(key);                    // act, as a separate round trip
}
```

`GET` and `INCR` here are each atomic *individually*, but the sequence as a whole is not. Two
concurrent requests can both `GET` the same value (say `9`, under a limit of `10`) **before
either one's `INCR` has actually run** — both see "under limit," both proceed, and the limit
gets bypassed.

### Proving it

`tests/concurrency.test.js` fires 50 concurrent requests at the same key, against:

1. `checkFixedWindowTrulyNaive` — the GET-then-INCR pattern above (with a small artificial
   delay between the read and the write, to reliably widen the race window for the test —
   in production, this gap appears naturally from network latency and load).
2. `checkFixedWindowWithLua` — the same logic, executed as a single atomic Redis Lua script.

With `limit = 10` and 50 concurrent requests:

```
$ npm test

> distributed-rate-limiter@1.0.0 test
> vitest run


 RUN  v4.1.9 D:/Work/projects/ongoing/Distributed-Rate-Limiter

stdout | tests/concurrency.test.js > fixed window concurrency > naive INCR+EXPIRE lets the count exceed the limit under concurrency
naive allowedCount: 50

 ❯ tests/concurrency.test.js (2 tests | 1 failed) 64ms
   ❯ fixed window concurrency (2)
     × naive INCR+EXPIRE lets the count exceed the limit under concurrency 55ms
     ✓ Lua-based atomic version never lets the count exceed the limit 6ms

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/concurrency.test.js > fixed window concurrency > naive INCR+EXPIRE lets the count exceed the limit under concurrency
AssertionError: expected 50 to be less than or equal to 10
 ❯ tests/concurrency.test.js:19:26
     17|
     18|     await redisClient.del(key);
     19|     expect(allowedCount).toBeLessThanOrEqual(limit); // likely to FAIL — that's the point
       |                          ^
     20|   });
     21|

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯

 Test Files  1 failed (1)
      Tests  1 failed | 1 passed (2)
   Start at  14:57:11
   Duration  517ms (transform 69ms, setup 0ms, import 167ms, tests 64ms, environment 0ms)
```

**All 50 requests were allowed through the naive implementation** — not just slightly over
the limit, but a complete bypass. Because all 50 `GET`s happened before any `INCR` landed,
every single one independently observed "under limit" and proceeded. Meanwhile the Lua-backed
version, run with identical concurrency and the same limit, correctly capped `allowedCount` at
exactly `10`.

### The fix: one atomic Lua script instead of two round trips

```lua
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local windowSeconds = tonumber(ARGV[2])

local count = redis.call("INCR", key)
if count == 1 then
    redis.call("EXPIRE", key, windowSeconds)
end
local resetTime = redis.call("TTL", key)

if count > limit then
    return {0, 0, resetTime}
end

return {1, limit - count, resetTime}
```

Redis executes an entire Lua script as **one indivisible unit** — it's single-threaded, and a
script in flight blocks every other client's command until it finishes. There's no window for
another request's `INCR` to land between this script's read and write, because there's no gap
at all: the read, the decision, and the write all happen inside Redis itself, in one round
trip from the application's perspective.

Note also that plain `INCR` alone is already atomic for simple counting — the race shown above
specifically comes from doing a separate `GET` *before* deciding whether to `INCR`. The token
bucket algorithm needs Lua for a different reason: its logic requires multiple *dependent*
reads and writes (current tokens, last refill time, recomputed tokens) that have no single
built-in atomic Redis command to express them — Lua is what makes that whole sequence atomic.

## API

### `GET /health`
Pings Redis, confirms connectivity.
```json
{ "status": "OK" }
```

### `POST /check?algorithm=<fixedWindow|slidingWindowLog|tokenBucket>`
Defaults to `fixedWindow` if `algorithm` is omitted.

**Request body:**
```json
{
  "key": "user-123",
  "limit": 10,
  "windowSeconds": 60
}
```

**Response:**
```json
{
  "allowed": true,
  "remaining": 9,
  "reset": 58
}
```

## Running locally

```bash
docker compose up --build
```
This starts Redis and the app together, with the app reachable at the port set by
`NODE_APP_PORT` in `.env` (mapped through `docker-compose.yml`).

To run just Redis (e.g. for running tests against a local Node process):
```bash
docker compose up -d redis
```

## Testing

```bash
npm test
```
Runs the Vitest suite, including the concurrency test described above.

## Project Status

Built and documented in stages, following an explicit phase-by-phase roadmap:

- [x] Phase 0 — Docker Compose + Redis connectivity
- [x] Phase 1 — Express server, `/health` route
- [x] Phase 2 — Fixed window counter (naive, then identified the race condition)
- [x] Phase 3 — Sliding window log (Redis sorted sets)
- [x] Phase 4 — Token bucket + atomicity via Lua; fixed window rewritten atomically;
      concurrency test proving naive vs. atomic behavior
- [ ] Phase 5 — Broader test suite (per-algorithm unit tests, integration tests on `/check`)
- [ ] Phase 6 — Config cleanup, input validation, error handling middleware, request logging
- [ ] Phase 7 (stretch) — Publishable Express middleware package
- [ ] Phase 8 (stretch) — Live stats dashboard
- [ ] Phase 9 — Load testing, final documentation pass

## What's next

Phase 5 onward — see the roadmap in this repo for the full plan, including load testing
results and scaling considerations that will be added once those phases are complete.
