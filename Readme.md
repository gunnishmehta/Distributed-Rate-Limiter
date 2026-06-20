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

## Architecture

```
                        ┌─────────────────────┐
   HTTP request         │   Express app.js     │
  ───────────────────▶  │                       │
   POST /check           │  morgan (logging)     │
   ?algorithm=...        │  express.json()       │
                        │  validateCheckRequest  │  ← zod: reject bad input early,
                        │   (zod)                │     apply config defaults
                        │  route → algorithm fn  │
                        │  errorHandler          │  ← centralized, catches everything
                        └──────────┬────────────┘
                                   │
                                   ▼
                  ┌────────────────────────────────┐
                  │   src/algorithms/*.js            │
                  │   (fixedWindow / slidingWindowLog │
                  │    / tokenBucket)                 │
                  └──────────────┬─────────────────┘
                                 │  one atomic round trip
                                 ▼
                  ┌────────────────────────────────┐
                  │   Redis (single instance)        │
                  │   EVAL <lua script>               │ ← INCR/EXPIRE/TTL,
                  │   (single-threaded, single        │   ZADD/ZREMRANGEBYSCORE/ZCARD,
                  │    ioredis connection)             │   or HGETALL/HSET, all atomic
                  └────────────────────────────────┘

   Separately, the same algorithm logic (Lua-backed only) is packaged as a
   standalone, installable Express middleware — see "Standalone Middleware
   Package" below. It takes its own injected Redis client; it does not share
   a connection with the service above.
```

Two artifacts, one Redis-backed core: a runnable HTTP service (`src/`) and a reusable
middleware library (`packages/rate-limiter-middleware/`), both built on the same
atomic-via-Lua algorithms.

## Project Structure

```
.
├── docker-compose.yml          # redis + node-app services
├── Dockerfile
├── .env                        # REDIS_HOST, REDIS_PORT, NODE_APP_PORT, DEFAULT_LIMIT,
│                                 DEFAULT_WINDOW_SECONDS
├── src/
│   ├── server.js                 # entry point: imports app.js, calls app.listen
│   ├── app.js                     # Express app + routes (no listen) — importable by tests
│   ├── config.js                  # centralized env reads with defaults
│   ├── redis/
│   │   ├── client.js               # single shared ioredis instance (+ error handler)
│   │   └── scripts/
│   │       ├── fixedWindow.lua      # atomic fixed window (INCR + EXPIRE + TTL)
│   │       └── tokenBucket.lua      # atomic token bucket (read-refill-consume)
│   ├── algorithms/
│   │   ├── fixedWindow.js          # naive, "truly naive", and Lua-backed versions
│   │   ├── slidingWindowLog.js     # Redis sorted-set (ZADD/ZREMRANGEBYSCORE/ZCARD) based
│   │   └── tokenBucket.js          # plain-JS and Lua-backed versions
│   ├── middleware/
│   │   ├── validateCheckRequest.js  # zod validation for POST /check
│   │   └── errorHandler.js          # centralized error-handling middleware
│   └── validation/
│       └── checkSchema.js          # zod schemas (request body, algorithm enum)
├── packages/
│   └── rate-limiter-middleware/   # standalone, installable Express middleware
│       ├── package.json
│       ├── index.js                 # rateLimiter(options) factory
│       ├── algorithms/               # Lua-backed only (no naive/demo versions)
│       ├── scripts/
│       └── README.md
└── tests/
    ├── concurrency.test.js        # proves the race condition, and proves the fix
    ├── fixedWindow.test.js         # per-algorithm unit tests
    ├── slidingWindowLog.test.js
    ├── tokenBucket.test.js
    └── check.integration.test.js  # real HTTP requests via supertest
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

The suite covers four layers:

- **Per-algorithm unit tests** (`tests/fixedWindow.test.js`, `slidingWindowLog.test.js`,
  `tokenBucket.test.js`) — for each algorithm: allowed while under the limit, blocked once
  over it, and allowed again after the window/refill recovers.
- **Concurrency test** (`tests/concurrency.test.js`) — the naive-vs-atomic proof described
  above.
- **Integration tests** (`tests/check.integration.test.js`) — real HTTP requests against the
  Express app via `supertest`, covering algorithm routing through the `?algorithm=` query
  param and the `/health` route.

```
 Test Files  1 failed | 4 passed (5)
      Tests  1 failed | 15 passed (16)
```

The one failing test is the naive concurrency test from the section above — it's expected to
fail and is left failing on purpose, as a visible, running proof that the bug it documents is
real (rather than being silently skipped or asserted away).

## Load Testing

Load tested locally with `autocannon` against `POST /check` (fixed window algorithm, app and
Redis both running via Docker Compose on the same machine as the load generator).

### Baseline (limit high enough that requests are essentially always allowed)

| Concurrency | Avg req/sec | p50 latency | p99 latency | Max latency | Errors |
|---|---|---|---|---|---|
| 50 | 5,016.9 | 8ms | 32ms | 562ms | 0 |
| 200 | 5,688.3 | 33ms | 45ms | 2,049ms | 0 |
| 500 | 5,254.1 | 68ms | 114ms | 9,986ms | **14 timeouts** |

### Rejection path (limit low enough that nearly all requests are blocked, c=50)

| Avg req/sec | p50 latency | p99 latency | Max latency |
|---|---|---|---|
| 5,308.7 | 8ms | 17ms | 316ms |

### Findings

- **Allowing and rejecting a request cost essentially the same.** p50 latency was identical
  (8ms) whether the Lua script allowed or rejected — both paths do the same fundamental work:
  one atomic round trip to Redis. There's no cheap shortcut for either branch.
- **Throughput hit a hard ceiling around ~5,000-5,700 req/sec, independent of concurrency.**
  50, 200, and 500 concurrent connections all converged on roughly the same throughput.
  Quadrupling concurrency from 50 → 200 only bought a 13% throughput increase — the extra
  concurrency was absorbed almost entirely as *added latency* (p50 went from 8ms to 33ms,
  closely tracking Little's Law: `concurrency ≈ throughput × latency`).
- **The actual breaking point was between c=200 and c=500.** At `c=500`, 14 out of ~53,000
  requests (~0.026%) timed out outright, and max latency spiked to nearly 10 seconds. Below
  that, the system degraded gracefully (slower, not broken); at that point it started actually
  dropping requests.
- **The likely bottleneck is the single Redis connection, not Node/Express.** Every request
  does exactly one `EVAL` call over `ioredis`'s single TCP connection to a single-threaded
  Redis instance. However much HTTP concurrency Node accepts, it all funnels through that one
  pipe — which is consistent with throughput plateauing regardless of concurrency.

### Caveat

The load generator and the system under test ran on the same machine. At high concurrency,
some of the measured degradation may reflect local CPU/network contention between the test
client and the server, not purely the server's own limits. A more rigorous test would run
`autocannon` from a separate machine.

## What I'd Do Differently at Scale

- **Multiple Redis connections / a connection pool**, instead of a single shared `ioredis`
  instance, to remove the single-pipe bottleneck the load test pointed at directly.
- **Redis Cluster, sharded by rate-limit key**, so no single Redis node has to serialize every
  request across the whole service — each key's traffic would only contend with other keys
  hashed to the same shard.
- **Horizontal scaling of the Node service itself.** Since all rate-limit state lives in
  Redis and the app holds no in-process state, running multiple Node instances behind a load
  balancer is safe by construction — this would help if Node/Express were the bottleneck, but
  the load test suggests Redis would need addressing first.
- **A fail-open vs. fail-closed decision for Redis outages.** Right now, if Redis is
  unreachable, requests fail loudly (`500`, via the centralized error handler) rather than
  picking a deliberate fallback. At scale, you'd want to explicitly decide: should a Redis
  outage block all traffic (fail-closed, safer but riskier for availability), or let requests
  through unmetered (fail-open, safer for availability but loses rate limiting exactly when
  load is high)?
- **Multi-region considerations.** A single Redis instance is a single point of failure and a
  latency penalty for geographically distant clients. Real multi-region rate limiting needs
  either regional Redis instances with relaxed global accuracy, or a globally consistent store
  accepting higher latency per check.
- **Consistent response shapes across algorithms.** `tokenBucket` currently returns
  `{ allowed, tokens }` while the other two return `{ allowed, remaining, reset }` — fine for
  a learning project, but worth unifying before treating this as a real shared library.
- **Real observability** (structured logs, metrics, tracing) instead of `morgan` — explicitly
  deferred per the roadmap to a future project, but the natural next step after this one.

## Standalone Middleware Package

Alongside the service itself, the rate-limiting logic is also packaged as a reusable,
installable Express middleware — `packages/rate-limiter-middleware/`. Unlike the service,
which owns its own Redis connection and config, the package takes a Redis client as input
and exposes a single factory function:

```js
import { rateLimiter } from "rate-limiter-middleware";

app.use(
  rateLimiter({
    redisClient,            // any client exposing eval/zadd/zremrangebyscore/zcard/pttl/expire
    algorithm: "tokenBucket", // "fixedWindow" | "slidingWindowLog" | "tokenBucket"
    limit: 100,
    windowSeconds: 60,
  })
);
```

It ships only the atomic, Lua-backed version of each algorithm (the naive/demonstration
versions used to prove the race condition stay in the main service, where that story lives).
See [packages/rate-limiter-middleware/README.md](packages/rate-limiter-middleware/README.md)
for full usage docs (`keyGenerator`, `onRejected`, response shapes).

It was verified as genuinely installable end-to-end: built with `npm pack` into a real
`.tgz`, installed into a completely separate project folder with `npm install <tarball>`,
and exercised there with its own Express app and Redis client — confirming requests were
correctly allowed and then blocked with `429` once the limit was hit, independent of this
repo entirely.

The main service intentionally keeps its own separate copy of the algorithm logic rather than
importing from the package — per the roadmap, the goal here was two distinct artifacts from
one project (a standalone service *and* a reusable library), not a single shared
implementation.

## Project Status

Built and documented in stages, following an explicit phase-by-phase roadmap:

- [x] Phase 0 — Docker Compose + Redis connectivity
- [x] Phase 1 — Express server, `/health` route
- [x] Phase 2 — Fixed window counter (naive, then identified the race condition)
- [x] Phase 3 — Sliding window log (Redis sorted sets)
- [x] Phase 4 — Token bucket + atomicity via Lua; fixed window rewritten atomically;
      concurrency test proving naive vs. atomic behavior
- [x] Phase 5 — Broader test suite (per-algorithm unit tests, integration tests on `/check`)
- [x] Phase 6 — Config defaults, input validation (zod), centralized error handling,
      request logging (morgan)
- [x] Phase 7 (stretch) — Publishable Express middleware package
- [ ] Phase 8 (stretch) — Live stats dashboard
- [x] Phase 9 — Load testing, final documentation pass

## What's next

Phase 8 (stretch) — a live dashboard polling Redis for active rate-limiter keys — is the one
remaining item, deliberately left for later since it's marked optional in the roadmap.
