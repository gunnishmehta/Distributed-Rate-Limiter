import { z } from "zod";
import config from "../config.js";

export const checkBodySchema = z.object({
    key: z.string().min(1, "key is required"),
    limit: z.coerce.number().int().positive().optional().default(config.defaultLimit),
    windowSeconds: z.coerce.number().positive().optional().default(config.defaultWindowSeconds),
});

export const algorithmQuerySchema = z
    .enum(["fixedWindow", "slidingWindowLog", "tokenBucket"])
    .optional()
    .default("fixedWindow");
