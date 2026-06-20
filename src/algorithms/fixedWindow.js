import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import redisClient from "../redis/client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const luaScript = readFileSync(
    join(__dirname, "../redis/scripts/fixedWindow.lua"),
    "utf-8"
);

async function checkFixedWindow(key, limit, windowSeconds) {
    if (windowSeconds <= 0) {
        throw new Error('Window seconds must be greater than 0');
    }

    const count = await redisClient.incr(key);
    if (count === 1) {
        await redisClient.expire(key, windowSeconds);
    }
    if (count > limit) {
        return {
            allowed: false,
            remaining: 0,
            reset: await redisClient.ttl(key)
        };
    }

    return {
        allowed: true,
        remaining: limit - count,
        reset: await redisClient.ttl(key)
    };
}

async function checkFixedWindowTrulyNaive(key, limit, windowSeconds) {
    const current = await redisClient.get(key);
    const count = current ? parseInt(current) : 0;

    if (count >= limit) {
        return { allowed: false };
    }

    // simulate a tiny gap where another request could interleave
    await new Promise(resolve => setTimeout(resolve, 5));

    await redisClient.incr(key);
    if (count === 0) {
        await redisClient.expire(key, windowSeconds);
    }
    return { allowed: true };
}


async function checkFixedWindowWithLua(key, limit, windowSeconds){
    if(windowSeconds <= 0){
        throw new Error('Window seconds must be greater than 0');
    }

    const result = await redisClient.eval(
        luaScript,
        1,
        key,
        limit,
        windowSeconds
    )
    return {allowed: result[0] === 1, remaining: parseInt(result[1]), reset: parseInt(result[2])};
}

export {checkFixedWindowTrulyNaive};
export default checkFixedWindowWithLua;