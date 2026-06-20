import redisClient from '../redis/client.js';

async function checkSlidingWindowLog(key, limit, windowSeconds) {
    if (windowSeconds <= 0) {
        throw new Error('Window seconds must be greater than 0');
    }
    const now = Date.now();
    const windowStart = now - windowSeconds * 1000;

    // Remove timestamps that are outside the current window
    await redisClient.zremrangebyscore(key, "-inf", windowStart);
    const count = await redisClient.zcard(key);
    if (count >= limit) {
        return {
            allowed: false,
            remaining: 0,
            reset: await redisClient.pttl(key)
        };
    }
    await redisClient.zadd(key, now, `${now}-${Math.random()}`);
    await redisClient.expire(key, windowSeconds);

    return {
        allowed: true,
        remaining: limit - count - 1,
        reset: await redisClient.pttl(key)
    };
}

export default checkSlidingWindowLog;