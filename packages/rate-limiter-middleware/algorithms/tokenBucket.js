import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const luaScript = readFileSync(
    join(__dirname, "../scripts/tokenBucket.lua"),
    "utf-8"
);

export async function checkTokenBucket(redisClient, key, limit, windowSeconds) {
    if (windowSeconds <= 0) {
        throw new Error("windowSeconds must be greater than 0");
    }

    const bucketKey = `tokenBucket:${key}`;
    const now = Date.now();

    const result = await redisClient.eval(
        luaScript,
        1,
        bucketKey,
        limit,
        windowSeconds,
        now
    );

    return { allowed: result[0] === 1, tokens: parseFloat(result[1]) };
}