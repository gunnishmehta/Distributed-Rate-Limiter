import "dotenv/config";
import express from "express";

import redisClient from "./redis/client.js";

import checkFixedWindowWithLua from "./algorithms/fixedWindow.js";
import checkSlidingWindowLog from "./algorithms/slidingWindowLog.js";
import checkTokenBucketWithLua from "./algorithms/tokenBucket.js";

const app = express();
app.use(express.json());

app.get("/", async (req, res) => {
    res.json({ message: "Hello, World!" });
});

app.get("/health", async (req, res) => {
    try{
        await redisClient.ping();
        res.json({ status: "OK" });
    }catch (error) {
        res.status(500).json({ status: "Error", message: error.message });
    }
});

app.post("/check", async (req, res) => {
    const {key, limit, windowSeconds} = req.body;
    const algorithm = req.query.algorithm;
    try{
        let result;
        if (algorithm === "slidingWindowLog") {
            result = await checkSlidingWindowLog(key, limit, Number(windowSeconds));
        } else if (algorithm === "tokenBucket") {
            result = await checkTokenBucketWithLua(key, limit, Number(windowSeconds));
        } else {
            result = await checkFixedWindowWithLua(key, limit, Number(windowSeconds));
        }
        res.json(result);
    }catch (error) {
        res.status(500).json({ status: "Error", message: error.message });
    }
});

app.listen(process.env.NODE_APP_PORT, () => {
    console.log(`Server is running on port ${process.env.NODE_APP_PORT}`);
});