import Redis from "ioredis";
import config from "../config.js";

const redisClient = new Redis({
    host: config.redisHost,
    port: config.redisPort,
});

redisClient.on("error", (err) => {
    console.error("Redis client error:", err.message);
});

export default redisClient;
