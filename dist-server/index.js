// Reload trigger for dotenv update
import "./configureEnv.js";
import cors from "cors";
import express from "express";
import path from "node:path";
import { reportsRouter } from "./routes/reports.js";
import { satelliteRouter } from "./routes/satellite.js";
import { validateEnv } from "./utils/env.js";
import { aiDebugLimiter, generalApiLimiter, reportSubmissionLimiter } from "./middleware/rateLimits.js";
import { localMediaRoot } from "./services/mediaStorageService.js";
export const app = express();
validateEnv();
const port = Number(process.env.PORT || 8080);
const browserStorageDemo = process.env.VITE_DEMO_BROWSER_STORAGE === "true";
// Netlify forwards the client address through one proxy. This prevents all
// visitors being counted as the serverless function's internal address.
app.set("trust proxy", 1);
app.use(cors({ origin: true }));
app.use(express.json({ limit: "50mb" }));
if (!browserStorageDemo)
    app.use("/media", express.static(localMediaRoot(), { immutable: true, maxAge: "1d" }));
app.get("/media/*", (_req, res) => {
    res.status(404).json({ error: browserStorageDemo ? "Browser demo evidence is stored in IndexedDB and is not served by this API." : "Media file not found.", reasonCode: "media_not_found" });
});
app.use("/api/reports", (req, res, next) => {
    if (req.method === "POST" && req.path === "/")
        return reportSubmissionLimiter(req, res, next);
    return next();
});
app.use("/api/analyze-report", reportSubmissionLimiter);
app.use("/api/debug/gemini-image", aiDebugLimiter);
app.use("/api", generalApiLimiter);
app.get("/api/health", (_req, res) => {
    res.json({ ok: true, service: "netranagar" });
});
app.use("/api", reportsRouter);
app.use("/api", satelliteRouter);
app.use(express.static(path.join(process.cwd(), "dist")));
app.use((req, res, next) => {
    if (req.originalUrl.startsWith("/api/")) {
        console.log(`[404] ${req.method} ${req.originalUrl}`);
        res.status(404).json({ error: "Not Found" });
    }
    else {
        res.sendFile(path.join(process.cwd(), "dist", "index.html"));
    }
});
// Serverless platforms import `app` and own the HTTP listener themselves.
// Keep the listener only for the local standalone server (`npm start`).
if (process.env.NODE_ENV !== "test" && process.env.VERCEL !== "1") {
    app.listen(port, "0.0.0.0", () => {
        console.log(`NetraNagar API listening on port ${port} (0.0.0.0)`);
    });
}
