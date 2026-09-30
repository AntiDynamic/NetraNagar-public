import { Router } from "express";
import { checkEarthEngineConnection, getEarthEngineReadiness } from "../services/earthEngineService.js";
import { enqueueSatelliteVerification } from "../services/satelliteVerificationQueue.js";
import { buildPendingSatelliteEvidence } from "../services/satelliteVerificationService.js";
import { findReport, updateReport } from "../services/reportStore.js";
import { aiDebugLimiter } from "../middleware/rateLimits.js";
export const satelliteRouter = Router();
// This local hackathon stack has no identity provider. Do not expose this
// operation as a public production administration endpoint without adding one.
const requireOfficerOrAdmin = (_req, res, next) => {
    if (process.env.NODE_ENV === "production" && process.env.ALLOW_UNAUTHENTICATED_OFFICER_ACTIONS !== "true") {
        res.status(503).json({ error: "Officer actions require an identity provider in production." });
        return;
    }
    next();
};
satelliteRouter.get("/satellite/status", async (req, res) => {
    const check = req.query.check === "true";
    const status = check ? await checkEarthEngineConnection() : getEarthEngineReadiness();
    res.json({ provider: "earth_engine", ...status });
});
satelliteRouter.get("/satellite/report/:reportId", async (req, res) => {
    const report = await findReport(String(req.params.reportId));
    if (!report) {
        res.status(404).json({ error: "Report not found" });
        return;
    }
    res.json({ reportId: report.id, satelliteEvidence: report.satelliteEvidence || null });
});
satelliteRouter.post("/satellite/verify-report/:id", aiDebugLimiter, requireOfficerOrAdmin, async (req, res) => {
    try {
        const report = await findReport(String(req.params.id));
        if (!report) {
            res.status(404).json({ error: "Report not found" });
            return;
        }
        const current = report.satelliteEvidence;
        if (current && ["pending", "processing"].includes(current.status)) {
            res.status(202).json({ message: "Earth Engine context is already queued.", satelliteEvidence: current });
            return;
        }
        const readiness = getEarthEngineReadiness();
        if (!readiness.configured) {
            const unavailable = buildPendingSatelliteEvidence(report);
            if (unavailable) {
                unavailable.status = "unavailable";
                unavailable.explanation = "Google Earth Engine context is not configured.";
                unavailable.warnings = [unavailable.explanation];
                unavailable.error = { code: readiness.errorCode, message: unavailable.explanation, retryable: false };
                await updateReport(report.id, { satelliteEvidence: unavailable });
            }
            res.status(503).json({ error: "Google Earth Engine context is not configured.", satelliteEvidence: unavailable || null });
            return;
        }
        const pending = buildPendingSatelliteEvidence(report);
        if (pending)
            await updateReport(report.id, { satelliteEvidence: pending });
        const job = await enqueueSatelliteVerification(report.id, report.updatedAt);
        res.status(202).json({ message: "Google Earth Engine context queued.", jobId: job.jobId, satelliteEvidence: pending || null });
    }
    catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : "Could not queue Earth Engine context." });
    }
});
