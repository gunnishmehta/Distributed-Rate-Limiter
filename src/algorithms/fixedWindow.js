import redisClient from '../redis/client.js';

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
export default checkFixedWindow;