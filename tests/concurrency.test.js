import { describe, it, expect, beforeEach } from "vitest";
import { checkFixedWindowTrulyNaive } from "../src/algorithms/fixedWindow.js";
import checkFixedWindowWithLua from "../src/algorithms/fixedWindow.js";
import redisClient from "../src/redis/client.js";

describe("fixed window concurrency", () => {
  it("naive INCR+EXPIRE lets the count exceed the limit under concurrency", async () => {
    const key = `test:naive:${Date.now()}`;
    const limit = 10;

    const results = await Promise.all(
      Array.from({ length: 50 }, () => checkFixedWindowTrulyNaive(key, limit, 5))
    );

    const allowedCount = results.filter(r => r.allowed).length;
    console.log("naive allowedCount:", allowedCount); // expect > 10 sometimes

    await redisClient.del(key);
    expect(allowedCount).toBeLessThanOrEqual(limit); // likely to FAIL — that's the point
  });

  it("Lua-based atomic version never lets the count exceed the limit", async () => {
    const key = `test:lua:${Date.now()}`;
    const limit = 10;

    const results = await Promise.all(
      Array.from({ length: 50 }, () => checkFixedWindowWithLua(key, limit, 5))
    );

    const allowedCount = results.filter(r => r.allowed).length;

    await redisClient.del(key);
    expect(allowedCount).toBeLessThanOrEqual(limit); // should PASS
  });
});
