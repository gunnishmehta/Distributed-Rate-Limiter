import "dotenv/config";

const config = {
    redisHost: process.env.REDIS_HOST || "localhost",
    redisPort: Number(process.env.REDIS_PORT) || 6379,
    port: Number(process.env.NODE_APP_PORT) || 3000,
    defaultLimit: Number(process.env.DEFAULT_LIMIT) || 10,
    defaultWindowSeconds: Number(process.env.DEFAULT_WINDOW_SECONDS) || 60,
};

export default config;
