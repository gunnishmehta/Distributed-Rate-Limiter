# rate-limiter-middleware

Express middleware for distributed rate limiting, backed by Redis. Three algorithms included:
`fixedWindow`, `slidingWindowLog`, and `tokenBucket` — all implemented as atomic Redis Lua
scripts, so concurrent requests can't race past the limit.

This package does **not** create its own Redis connection. You pass in your own client
(e.g. an `ioredis` instance) — the middleware just calls methods on it.

## Install

```bash
npm install rate-limiter-middleware
```

(Or, while developing locally against this monorepo: `npm install ../packages/rate-limiter-middleware`.)

## Usage

```js
import express from "express";
import Redis from "ioredis";
import { rateLimiter } from "rate-limiter-middleware";

const app = express();
const redisClient = new Redis(); // your own connection, your own lifecycle

app.use(
  rateLimiter({
    redisClient,
    algorithm: "tokenBucket", // "fixedWindow" | "slidingWindowLog" | "tokenBucket"
    limit: 100,
    windowSeconds: 60,
  })
);
```

## Options

| Option | Required | Default | Description |
|---|---|---|---|
| `redisClient` | yes | — | Any client exposing `eval`, `zadd`, `zremrangebyscore`, `zcard`, `pttl`, `expire` (an `ioredis` instance satisfies all of these). |
| `limit` | yes | — | Max requests allowed per window. |
| `windowSeconds` | yes | — | Window length in seconds (or refill period, for `tokenBucket`). |
| `algorithm` | no | `"fixedWindow"` | One of `"fixedWindow"`, `"slidingWindowLog"`, `"tokenBucket"`. |
| `keyGenerator` | no | `(req) => req.ip` | Function deriving the rate-limit key from the request — e.g. by API key, user ID, or route. |
| `onRejected` | no | sends `429` JSON | Custom handler `(req, res, result) => {}` called instead of the default response when a request is blocked. |

## Default rejection response

```json
{
  "status": "Error",
  "message": "Too many requests",
  "allowed": false,
  "remaining": 0
}
```
(`reset` is also included for `fixedWindow`/`slidingWindowLog`; `tokenBucket` includes `tokens` instead.)

## Why algorithm choice matters

- **`fixedWindow`** — cheapest, but allows short bursts right at window boundaries.
- **`slidingWindowLog`** — perfectly accurate, costs more memory per key under high limits.
- **`tokenBucket`** — allows natural bursts after idle periods, caps sustained throughput to
  the refill rate; best fit for most API quota use cases.

See the [main project README](../../Readme.md) for the full writeup of how each algorithm
works and the race-condition story behind why these are Lua-backed.