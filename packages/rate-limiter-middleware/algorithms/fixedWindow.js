import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const luaScript = readFileSync(
    join(__dirname, "../scripts/fixedWindow.lua"),
    "utf-8"
);

export async function checkFixedWindow(redisClient, key, limit, windowSeconds) {
    if (windowSeconds <= 0) {
        throw new Error("windowSeconds must be greater than 0");
    }

    const result = await redisClient.eval(
        luaScript,
        1,
        key,
        limit,
        windowSeconds
    );

    return {
        allowed: result[0] === 1,
        remaining: parseInt(result[1]),
        reset: parseInt(result[2]),
    };
}