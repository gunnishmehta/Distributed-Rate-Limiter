import { describe, it, expect } from "vitest";
import checkFixedWindowWithLua from "../src/algorithms/fixedWindow.js";

import redisClient from "../src/redis/client.js";

describe("fixed window unit tests", () => {
    it("allows requests under the limit", async () => {
        const key = `test:fw:under:${Date.now()}`;
        const limit = 5;

        const result = await checkFixedWindowWithLua(key, limit, 60);

        expect(result.allowed).toBe(true);
        expect(result.remaining).toBe(limit - 1);

        await redisClient.del(key);
    });

    it("blocks requests once the limit is exceeded", async () => {
        const key = `test:fw:over:${Date.now()}`;
        const limit = 3;

        for (let i = 0; i < limit; i++) {
            await checkFixedWindowWithLua(key, limit, 60);
        }

        const result = await checkFixedWindowWithLua(key, limit, 60);

        expect(result.allowed).toBe(false);
        expect(result.remaining).toBe(0);

        await redisClient.del(key);
    });

    it("resets after the window expires", async () => {
        const key = `test:fw:reset:${Date.now()}`;
        const limit = 1;
        const windowSeconds = 1;

        await checkFixedWindowWithLua(key, limit, windowSeconds);

        const blocked = await checkFixedWindowWithLua(key, limit, windowSeconds);
        expect(blocked.allowed).toBe(false);

        await new Promise((resolve) => setTimeout(resolve, windowSeconds * 1000 + 200));

        const afterReset = await checkFixedWindowWithLua(key, limit, windowSeconds);
        expect(afterReset.allowed).toBe(true);

        await redisClient.del(key);
    });
});
