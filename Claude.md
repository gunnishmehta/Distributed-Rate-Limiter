# Distributed Rate Limiter — Build Roadmap

A step-by-step plan to build this project incrementally, so each stage teaches one concept before you move to the next. Check off steps as you go. Don't skip ahead — each phase assumes the previous one works.

---

## Phase 0: Setup

- [ ] Create repo `distributed-rate-limiter`
- [ ] `npm init -y`
- [ ] Install core deps: `npm install express ioredis dotenv`
- [ ] Install dev deps: `npm install -D nodemon vitest`
- [ ] Create folder structure:
  ```
  rate-limiter/
  ├── docker-compose.yml
  ├── .env
  ├── src/
  │   ├── algorithms/
  │   ├── redis/
  │   │   └── scripts/
  │   ├── routes/
  │   └── server.js
  ├── tests/
  └── README.md
  ```
- [ ] Write `docker-compose.yml` with two services: `redis` (official `redis:7-alpine` image) and your `app` (built from a `Dockerfile`)
- [ ] Write a minimal `Dockerfile` for the Node app
- [ ] Confirm `docker compose up` starts Redis and you can connect to it from Node (`ioredis` ping test)

**Goal of this phase:** environment works end-to-end before any real logic exists.

---

## Phase 1: Bare Express server + Redis connection

- [ ] `src/redis/client.js` — create and export a single `ioredis` instance
- [ ] `src/server.js` — basic Express app with a `GET /health` route that pings Redis and returns `{ status: "ok", redis: "connected" }`
- [ ] Add `nodemon` script in `package.json` for dev
- [ ] Confirm `/health` works inside Docker Compose, not just locally

**Goal:** prove the service and Redis can talk to each other inside containers.

---

## Phase 2: Fixed Window Counter (naive version first, on purpose)

- [ ] `src/algorithms/fixedWindow.js` — implement using plain `GET` + `INCR` + `EXPIRE` (no atomicity yet)
- [ ] `POST /check` route wired to this algorithm
  ```
  Body: { key, limit, windowSeconds }
  Response: { allowed, remaining, resetAt }
  ```
- [ ] Manually test with `curl` or Postman — hammer the same key quickly and watch it behave
- [ ] **Write a note in your README** about the race condition: if two requests arrive in the same millisecond, the naive GET-then-INCR can let both through even when the limit is hit. Don't fix it yet — you'll fix it properly in Phase 4. The point right now is to *see* the bug exists.

**Goal:** working but flawed implementation — you need to feel the problem before the fix means anything.

---

## Phase 3: Sliding Window Log

- [ ] `src/algorithms/slidingWindowLog.js` — store request timestamps in a Redis sorted set (`ZADD`), trim out-of-window entries (`ZREMRANGEBYSCORE`), count remaining (`ZCARD`)
- [ ] Add an `algorithm` query param or body field so `/check` can pick `fixedWindow` or `slidingWindowLog`
- [ ] Write a short comparison note in README: memory cost (stores every timestamp) vs. accuracy (no boundary burst problem)

**Goal:** second algorithm, and your first taste of Redis sorted sets as a data structure choice.

---

## Phase 4: Token Bucket + Atomicity via Lua

This is the core learning phase of the whole project.

- [ ] `src/algorithms/tokenBucket.js` — implement the token bucket logic (tokens refill at a fixed rate, requests consume tokens, requests fail if bucket is empty)
- [ ] Write this one as a **Lua script** (`src/redis/scripts/tokenBucket.lua`) executed via `EVAL` — this makes the check-and-decrement atomic in Redis itself, eliminating the race condition from Phase 2
- [ ] Go back and **fix the fixed window algorithm** using the same Lua/`EVAL` approach (atomic `INCR` + `EXPIRE` in one script)
- [ ] Write a test that fires many concurrent requests at the same key (e.g., `Promise.all` with 50 calls) and confirms the count never exceeds the limit — this test should *fail* against your Phase 2 code and *pass* against your Lua-based fix
- [ ] Document in README: what a race condition looks like, why `EVAL` solves it (Redis executes Lua scripts atomically, single-threaded), and show the before/after test result

**Goal:** this is your single best interview talking point — you can explain a real race condition and a real atomic fix, not just describe the concept abstractly.

---

## Phase 5: Tests

- [ ] Set up Vitest
- [ ] Unit tests per algorithm (allowed under limit, blocked over limit, resets after window expires — you can mock time or use short windows like 2s for fast tests)
- [ ] Concurrency test from Phase 4, formalized
- [ ] Integration test hitting the actual `/check` endpoint (use `supertest` or similar)

**Goal:** confidence to refactor without breaking things, and a test suite you can point to in interviews.

---

## Phase 6: Clean up the API + config

- [ ] Move limit/window defaults into `.env` / config file, but allow override per-request
- [ ] Add input validation (reject missing `key`, non-numeric `limit`, etc.) — use `zod` or manual checks
- [ ] Add proper error handling middleware (don't let Redis errors crash the process)
- [ ] Add request logging (simple `morgan` is fine for now — you'll replace this with real observability in Project 5)

**Goal:** make it feel like a real service, not a script.

---

## Phase 7 (Stretch): npm-installable middleware package

- [ ] Extract the algorithm logic into a separate module that can be used as Express middleware directly, e.g.:
  ```js
  app.use(rateLimiter({ algorithm: 'tokenBucket', limit: 100, windowSeconds: 60 }))
  ```
- [ ] Publish locally / structure it so it *could* be published to npm (proper `package.json`, exports, README for the package itself)
- [ ] This gives you two artifacts from one project: a standalone service AND a reusable library — mention both on your resume

**Goal:** shows you can think about API design for other developers, not just end users.

---

## Phase 8 (Stretch): Live dashboard

- [ ] Simple static HTML + vanilla JS (or a tiny React app) page that polls a new `GET /stats` endpoint
- [ ] `/stats` returns current counts for active keys (scan Redis for rate-limiter keys, return their current usage)
- [ ] Auto-refresh every couple seconds, show a simple table or bar per key

**Goal:** something visual to demo quickly in an interview or portfolio walkthrough — text APIs are hard to "show" live.

---

## Phase 9: Load testing + documentation polish

- [ ] Install `autocannon` or `k6`, run a load test against `/check`
- [ ] Record results (requests/sec, latency at p50/p95/p99) in README
- [ ] Try increasing concurrent load until something breaks or degrades — note what happened
- [ ] Final README pass — should include:
  - Architecture diagram (even hand-drawn/exported from draw.io is fine)
  - The three algorithms and their tradeoffs
  - The race condition story from Phase 4
  - Load test results
  - "What I'd do differently at scale" section (e.g., Redis Cluster for sharding keys, multi-region considerations)

**Goal:** this README is what an interviewer or recruiter actually reads — treat it as part of the deliverable, not an afterthought.

---

## Suggested pace

- Phases 0–2: 1 session (get something running fast, momentum matters)
- Phase 3: quick, builds on Phase 2 patterns
- Phase 4: take your time here — this is the conceptual core, don't rush it
- Phases 5–6: 1 session
- Phases 7–9: optional but recommended if you have the time; do them after Project 2 if you're eager to move on, and circle back

When this is done, Project 2 (URL Shortener) will literally import this rate limiter as a dependency — so don't throw the code away once you're "finished."