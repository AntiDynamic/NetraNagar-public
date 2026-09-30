import rateLimit from "express-rate-limit";
function numberFromEnv(name, fallback) {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}
function limitMessage(message) {
    return {
        error: message,
        reasonCode: "rate_limited"
    };
}
const production = process.env.NODE_ENV === "production";
export const generalApiLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: numberFromEnv("API_RATE_LIMIT_PER_HOUR", production ? 300 : 500),
    // Map, forecast and report-list reads are cached/idempotent. Limiting them
    // makes a single dashboard load throttle itself while background data is
    // refreshing; retain limits for state-changing API calls instead.
    skip: (req) => req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS",
    standardHeaders: true,
    legacyHeaders: false,
    message: limitMessage("Too many requests. Please wait and try again.")
});
export const reportSubmissionLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: numberFromEnv("REPORT_RATE_LIMIT_PER_HOUR", production ? 30 : 60),
    standardHeaders: true,
    legacyHeaders: false,
    message: limitMessage("Too many report submissions. Please wait and try again.")
});
export const aiDebugLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: numberFromEnv("AI_RATE_LIMIT_PER_HOUR", 30),
    standardHeaders: true,
    legacyHeaders: false,
    message: limitMessage("Too many AI checks. Please wait and try again.")
});
