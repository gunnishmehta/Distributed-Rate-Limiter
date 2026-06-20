import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import redisClient from "../redis/client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const luaScript = readFileSync(
    join(__dirname, "../redis/scripts/tokenBucket.lua"),
    "utf-8"
);


async function checkTokenBucket(key, limit, windowSeconds) {
    if (windowSeconds <= 0) {
        throw new Error("windowSeconds must be greater than 0");
    }
    const bucketKey = `tokenBucket:${key}`;
    const now = Date.now();
    const bucketData = await redisClient.hgetall(bucketKey);
    const tokens = bucketData.tokens ? parseFloat(bucketData.tokens) : limit;
    const lastRefill = bucketData.lastRefill ? parseInt(bucketData.lastRefill) : now;

    const elapsed = (now - lastRefill) / 1000;
    const refillTokens = elapsed * (limit / windowSeconds);
    const newTokens = Math.min(tokens + refillTokens, limit);

    if (newTokens >= 1) {
        await redisClient.hmset(bucketKey, {
            tokens: newTokens - 1,
            lastRefill: now
        })
        return { allowed: true, tokens: newTokens - 1 };
    } else {
        await redisClient.hmset(bucketKey, {
            tokens: newTokens,
            lastRefill: now
        })
        return { allowed: false, tokens: newTokens };
    }
}

async function checkTokenBucketWithLua(key, limit, windowSeconds) {
    if (windowSeconds <= 0) {
        throw new Error("windowSeconds must be greater than 0");
    }
    const bucketKey = `tokenBucket:${key}`;
    const now = Date.now();
    const result = await redisClient.eval(
        luaScript,
        1,              // Number of keys
        bucketKey,      // KEYS[1]
        limit,          // ARGV[1]
        windowSeconds,  // ARGV[2]
        now             // ARGV[3]
    )
    return { allowed: result[0] === 1, tokens: parseFloat(result[1]) };

}

export default checkTokenBucketWithLua;