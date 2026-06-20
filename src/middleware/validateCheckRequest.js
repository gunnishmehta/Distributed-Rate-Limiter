import { checkBodySchema, algorithmQuerySchema } from "../validation/checkSchema.js";

export function validateCheckRequest(req, res, next) {
    const bodyResult = checkBodySchema.safeParse(req.body);
    if (!bodyResult.success) {
        return res.status(400).json({
            status: "Error",
            message: "Invalid request body",
            errors: bodyResult.error.issues,
        });
    }

    const algorithmResult = algorithmQuerySchema.safeParse(req.query.algorithm);
    if (!algorithmResult.success) {
        return res.status(400).json({
            status: "Error",
            message: "Invalid algorithm",
            errors: algorithmResult.error.issues,
        });
    }

    req.body = bodyResult.data;
    req.algorithm = algorithmResult.data;
    next();
}
