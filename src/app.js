import "dotenv/config";
import express from "express";
import morgan from "morgan";

import redisClient from "./redis/client.js";
import { validateCheckRequest } from "./middleware/validateCheckRequest.js";
import { errorHandler } from "./middleware/errorHandler.js";

import checkFixedWindowWithLua from "./algorithms/fixedWindow.js";
import checkSlidingWindowLog from "./algorithms/slidingWindowLog.js";
import checkTokenBucketWithLua from "./algorithms/tokenBucket.js";

const app = express();
app.use(morgan("dev"));
app.use(express.json());

app.get("/", async (req, res) => {
    res.json({ message: "Hello, World!" });
});

app.get("/health", async (req, res) => {
    await redisClient.ping();
    res.json({ status: "OK" });
});

app.post("/check", validateCheckRequest, async (req, res) => {
    const { key, limit, windowSeconds } = req.body;

    let result;
    if (req.algorithm === "slidingWindowLog") {
        result = await checkSlidingWindowLog(key, limit, windowSeconds);
    } else if (req.algorithm === "tokenBucket") {
        result = await checkTokenBucketWithLua(key, limit, windowSeconds);
    } else {
        result = await checkFixedWindowWithLua(key, limit, windowSeconds);
    }
    res.json(result);
});

app.use(errorHandler);

export default app;
