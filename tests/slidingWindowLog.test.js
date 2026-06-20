import { describe, it, expect } from "vitest";
import checkSlidingWindowLog from "../src/algorithms/slidingWindowLog.js";

import redisClient from "../src/redis/client.js";

describe("sliding window log unit tests", () => {
    it("allows requests under the limit", async () => {
        const key = `test:swl:under:${Date.now()}`;
        const limit = 5;

        const result = await checkSlidingWindowLog(key, limit, 60);

        expect(result.allowed).toBe(true);
        expect(result.remaining).toBe(limit - 1);

        await redisClient.del(key);
    });

    it("blocks requests once the limit is exceeded", async () => {
        const key = `test:swl:over:${Date.now()}`;
        const limit = 3;

        for (let i = 0; i < limit; i++) {
            await checkSlidingWindowLog(key, limit, 60);
        }

        const result = await checkSlidingWindowLog(key, limit, 60);

        expect(result.allowed).toBe(false);
        expect(result.remaining).toBe(0);

        await redisClient.del(key);
    });

    it("allows requests again once old entries slide out of the window", async () => {
        const key = `test:swl:reset:${Date.now()}`;
        const limit = 1;
        const windowSeconds = 1;

        await checkSlidingWindowLog(key, limit, windowSeconds);

        const blocked = await checkSlidingWindowLog(key, limit, windowSeconds);
        expect(blocked.allowed).toBe(false);

        // wait past the window so ZREMRANGEBYSCORE evicts the old timestamp
        await new Promise((resolve) => setTimeout(resolve, windowSeconds * 1000 + 200));

        const afterSlide = await checkSlidingWindowLog(key, limit, windowSeconds);
        expect(afterSlide.allowed).toBe(true);

        await redisClient.del(key);
    });
});
