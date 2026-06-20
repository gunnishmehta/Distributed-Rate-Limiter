import { describe, it, expect } from "vitest";
import checkTokenBucketWithLua from "../src/algorithms/tokenBucket.js";

import redisClient from "../src/redis/client.js";

describe("token bucket unit tests", () => {
    it("allows requests while tokens are available", async () => {
        const key = `test:tb:under:${Date.now()}`;
        const limit = 5;

        const result = await checkTokenBucketWithLua(key, limit, 60);

        expect(result.allowed).toBe(true);
        expect(result.tokens).toBeCloseTo(limit - 1, 1);

        await redisClient.del(`tokenBucket:${key}`);
    });

    it("blocks requests once the bucket is empty", async () => {
        const key = `test:tb:over:${Date.now()}`;
        const limit = 3;

        for (let i = 0; i < limit; i++) {
            await checkTokenBucketWithLua(key, limit, 60);
        }

        const result = await checkTokenBucketWithLua(key, limit, 60);

        expect(result.allowed).toBe(false);

        await redisClient.del(`tokenBucket:${key}`);
    });

    it("refills tokens over time and allows requests again", async () => {
        const key = `test:tb:refill:${Date.now()}`;
        const limit = 1;
        const windowSeconds = 1; // refill rate: 1 token per second

        await checkTokenBucketWithLua(key, limit, windowSeconds);

        const blocked = await checkTokenBucketWithLua(key, limit, windowSeconds);
        expect(blocked.allowed).toBe(false);

        // wait long enough for at least one full token to refill
        await new Promise((resolve) => setTimeout(resolve, windowSeconds * 1000 + 200));

        const afterRefill = await checkTokenBucketWithLua(key, limit, windowSeconds);
        expect(afterRefill.allowed).toBe(true);

        await redisClient.del(`tokenBucket:${key}`);
    });
});
