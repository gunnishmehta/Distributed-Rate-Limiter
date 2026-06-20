import { describe, it, expect } from "vitest";
import request from "supertest";

import app from "../src/app.js";
import redisClient from "../src/redis/client.js";

describe("POST /check integration", () => {
    it("returns allowed: true for a fresh key under the limit (default algorithm)", async () => {
        const key = `test:integration:fw:${Date.now()}`;

        const response = await request(app)
            .post("/check")
            .send({ key, limit: 5, windowSeconds: 60 });

        expect(response.status).toBe(200);
        expect(response.body.allowed).toBe(true);
        expect(response.body.remaining).toBe(4);

        await redisClient.del(key);
    });

    it("returns allowed: false once the limit is exceeded", async () => {
        const key = `test:integration:fw:over:${Date.now()}`;
        const limit = 2;

        for (let i = 0; i < limit; i++) {
            await request(app).post("/check").send({ key, limit, windowSeconds: 60 });
        }

        const response = await request(app)
            .post("/check")
            .send({ key, limit, windowSeconds: 60 });

        expect(response.status).toBe(200);
        expect(response.body.allowed).toBe(false);

        await redisClient.del(key);
    });

    it("routes to slidingWindowLog when algorithm=slidingWindowLog", async () => {
        const key = `test:integration:swl:${Date.now()}`;

        const response = await request(app)
            .post("/check?algorithm=slidingWindowLog")
            .send({ key, limit: 5, windowSeconds: 60 });

        expect(response.status).toBe(200);
        expect(response.body.allowed).toBe(true);
        expect(response.body.remaining).toBe(4);

        await redisClient.del(key);
    });

    it("routes to tokenBucket when algorithm=tokenBucket", async () => {
        const key = `test:integration:tb:${Date.now()}`;

        const response = await request(app)
            .post("/check?algorithm=tokenBucket")
            .send({ key, limit: 5, windowSeconds: 60 });

        expect(response.status).toBe(200);
        expect(response.body.allowed).toBe(true);
        expect(response.body.tokens).toBeCloseTo(4, 1);

        await redisClient.del(`tokenBucket:${key}`);
    });

    it("GET /health reports Redis connectivity", async () => {
        const response = await request(app).get("/health");

        expect(response.status).toBe(200);
        expect(response.body.status).toBe("OK");
    });
});