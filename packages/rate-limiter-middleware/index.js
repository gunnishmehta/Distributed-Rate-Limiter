import { checkFixedWindow } from "./algorithms/fixedWindow.js";
import { checkSlidingWindowLog } from "./algorithms/slidingWindowLog.js";
import { checkTokenBucket } from "./algorithms/tokenBucket.js";

const algorithms = {
    fixedWindow: checkFixedWindow,
    slidingWindowLog: checkSlidingWindowLog,
    tokenBucket: checkTokenBucket,
};

export function rateLimiter(options = {}) {
    const {
        redisClient,
        algorithm = "fixedWindow",
        limit,
        windowSeconds,
        keyGenerator = (req) => req.ip,
        onRejected,
    } = options;

    if (!redisClient) {
        throw new Error("rateLimiter() requires a redisClient option");
    }
    if (!limit || !windowSeconds) {
        throw new Error("rateLimiter() requires both limit and windowSeconds options");
    }

    const checkFn = algorithms[algorithm];
    if (!checkFn) {
        throw new Error(
            `Unknown algorithm "${algorithm}". Expected one of: ${Object.keys(algorithms).join(", ")}`
        );
    }

    return async function rateLimiterMiddleware(req, res, next) {
        try {
            const key = keyGenerator(req);
            const result = await checkFn(redisClient, key, limit, windowSeconds);

            if (result.allowed) {
                return next();
            }

            if (onRejected) {
                return onRejected(req, res, result);
            }

            return res.status(429).json({
                status: "Error",
                message: "Too many requests",
                ...result,
            });
        } catch (err) {
            next(err);
        }
    };
}

export default rateLimiter;