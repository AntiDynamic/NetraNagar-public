import { Router } from "express";
import { getAirQuality, getAirQualityDebug, getAirQualityMap, getAirQualitySources, getLocalAirQualityMap, getLatestAqiCoverage } from "../services/airQualityService.js";
import { getCpcbLocalPollutantContext, getCpcbStatus, getNearbyCpcbStations } from "../services/cpcbService.js";
import { analyzeImageData, decideVerification, VerificationError } from "../services/geminiService.js";
import { createReport, listReports, listReportsByUser, updateReport, findReport, updateStatus } from "../services/reportStore.js";
import { calculateHotspotScore, findNearbyReports, priorityForHotspotScore } from "../services/hotspotService.js";
import { assessAuthenticity } from "../services/authenticityService.js";
import { CaptureValidationError, validateDroneCapture, validateLiveCameraCapture } from "../services/captureValidation.js";
import { scoreEvidence } from "../services/evidenceScoreService.js";
import { getAqiForecast, getForecastStations } from "../services/forecastService.js";
import { getStateForecasts, getStateForecastStatus } from "../services/stateForecastService.js";
import { buildLocalityIntelligence } from "../services/localityIntelligenceService.js";
import { buildLocalitySummary } from "../services/localityService.js";
import { MediaStorageUnavailableError, hydrateReportMediaUrls, hydrateReportsMediaUrls, mediaHash, storeReportMedia, storeResolutionMedia } from "../services/mediaStorageService.js";
import { enqueueSatelliteVerification } from "../services/satelliteVerificationQueue.js";
import { buildPendingSatelliteEvidence } from "../services/satelliteVerificationService.js";
import { getEarthEngineReadiness } from "../services/earthEngineService.js";
import { buildRiskAdvisor } from "../services/riskAdvisorService.js";
import { buildRankedSituations } from "../services/situationRankingService.js";
import { getOpenAqStatus } from "../services/openAqAuthService.js";
import { getOpenAqNearbyStations, validateOpenAqRadius } from "../services/openAqService.js";
import { getOpenAqNationalSnapshot, refreshOpenAqNationalSnapshot } from "../services/openAqNationalSnapshotService.js";
import { getCurrentAqiSnapshot, getCurrentAqiStatus, refreshCurrentAqiSnapshot } from "../services/currentAqiSnapshotService.js";
import { distanceMeters } from "../utils/geo.js";
import { awardResolutionPoints, getLeaderboard, getPointsHistory, getRewards } from "../services/rewardsService.js";
import { awardVerifiedContributionPoints } from "../services/rewardsService.js";
import { getSurroundingContext, getSurroundingContextStatus } from "../services/surroundingContextService.js";
import { corroborationCaptureRadiusMeters, isEligibleForCorroboration, listCorroborationMissions, missionDiscoveryRadiusMeters } from "../services/corroborationMissionService.js";
export const reportsRouter = Router();
function inferForecastStation(input, airQuality) {
    const explicit = typeof input === "string" ? input.trim() : "";
    if (explicit)
        return explicit;
    const nearest = airQuality?.nearestStation?.trim();
    if (!nearest)
        return undefined;
    return nearest.replace(/,\s*Delhi$/i, "");
}
function priorityForReport(report, hotspotScore) {
    return priorityForHotspotScore(hotspotScore, report.trustLevel);
}
function serverIdentityRequired() {
    return process.env.NODE_ENV === "production" && process.env.LOCAL_DEMO_MODE !== "true" && process.env.VITE_DEMO_BROWSER_STORAGE !== "true";
}
function requireProductionRole(role) {
    return (req, res, next) => {
        if (!serverIdentityRequired())
            return next();
        if (req.auth?.role !== role)
            return res.status(403).json({ error: "You do not have permission for this workflow action.", reasonCode: "forbidden" });
        next();
    };
}
async function recomputeReportIntelligence(report, reports) {
    const nearby = findNearbyReports(report, reports);
    const hotspotScore = calculateHotspotScore(report.gemini.severity, nearby.similarReportCount, report.airQuality, report.evidenceScore, report.forecast, report.cpcbContext, report.gemini.pollution_type, report.surroundingContext, nearby.independentNearbyReporterCount, nearby.verifiedCorroborationCount);
    const base = await updateReport(report.id, { nearby, hotspotScore, priority: priorityForReport(report, hotspotScore) });
    if (!base)
        return undefined;
    return updateReport(base.id, { riskAdvisor: buildRiskAdvisor({ report: base, nearbyReports: reports }) });
}
function appendStatusHistory(report, status, label, updatedByRole, message) {
    return [...(report.statusHistory || []), { status, label, timestamp: new Date().toISOString(), updatedByRole, message }];
}
const activeLocalityStatuses = [
    "Submitted",
    "New",
    "Assigned",
    "In Progress",
    "Manual review needed"
];
function dominantPollutionType(reports) {
    const counts = reports.reduce((acc, report) => {
        const key = report.gemini.pollution_type;
        acc[key] = (acc[key] || 0) + 1;
        return acc;
    }, {});
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
}
class ReportSubmissionError extends Error {
    status;
    reasonCode;
    constructor(status, reasonCode, message) {
        super(message);
        this.status = status;
        this.reasonCode = reasonCode;
        this.name = "ReportSubmissionError";
    }
}
function numberFromPayload(value, allowString = false) {
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    if (allowString && typeof value === "string" && value.trim()) {
        const parsed = Number(value);
        if (Number.isFinite(parsed))
            return parsed;
    }
    return undefined;
}
function textFromPayload(value) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function objectFromPayload(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
function droneInfoFromPayload(body) {
    const nested = objectFromPayload(body.droneInfo);
    const droneId = textFromPayload(body.droneId) || textFromPayload(nested?.droneId);
    const source = textFromPayload(body.droneSource) || textFromPayload(body.source) || textFromPayload(nested?.source);
    const deviceInfo = textFromPayload(body.deviceInfo) || textFromPayload(body.device) || textFromPayload(nested?.deviceInfo);
    const detectedClass = textFromPayload(body.detectedClass) || textFromPayload(nested?.detectedClass);
    const confidence = numberFromPayload(body.confidence ?? nested?.confidence, true);
    const detectedAt = textFromPayload(body.detectedAt) || textFromPayload(body.detectionDateTime) || textFromPayload(nested?.detectedAt);
    if (!droneId && !source && !deviceInfo && !detectedClass && confidence === undefined && !detectedAt)
        return undefined;
    return {
        ...(droneId ? { droneId } : {}),
        ...(source ? { source } : {}),
        ...(deviceInfo ? { deviceInfo } : {}),
        ...(detectedClass ? { detectedClass } : {}),
        ...(confidence !== undefined ? { confidence } : {}),
        ...(detectedAt ? { detectedAt } : {})
    };
}
function yoloDroneVerification(droneInfo) {
    const detectedClass = droneInfo?.detectedClass?.trim();
    const normalized = detectedClass?.toLowerCase();
    if (!detectedClass || !normalized || ["none", "no_garbage", "no garbage", "background", "not_detected"].includes(normalized)) {
        throw new ReportSubmissionError(422, "no_garbage_detected", "YOLO did not report a garbage or pollution detection.");
    }
    const confidence = droneInfo?.confidence === undefined ? 0 : Math.max(0, Math.min(100, droneInfo.confidence <= 1 ? droneInfo.confidence * 100 : droneInfo.confidence));
    const gemini = {
        is_pollution_related: true, pollution_visible: true, image_quality: "usable", image_quality_score: 100,
        pollution_type: "open_waste", confidence, evidence_strength: confidence,
        visible_evidence: [`YOLO detection: ${detectedClass}`], possible_pollutants: [],
        public_summary: `YOLO reported ${detectedClass}.`, municipal_action: "Inspect the reported location.",
        needs_manual_review: confidence < 50, trust_decision: confidence < 50 ? "needs_review" : "likely_valid",
        safety_note: "Use standard field safety precautions.", severity: "medium"
    };
    return { gemini, decision: decideVerification(gemini) };
}
async function createAnalyzedReportFromPayload(body, reportSource, authenticatedUid) {
    const allowDroneStrings = reportSource === "drone";
    const suppliedCaptureEvidence = objectFromPayload(body.captureEvidence);
    const suppliedCaptureLocation = objectFromPayload(body.captureLocation) || objectFromPayload(suppliedCaptureEvidence?.captureLocation);
    const lat = numberFromPayload(body.lat ?? body.latitude ?? suppliedCaptureLocation?.lat ?? suppliedCaptureLocation?.latitude, allowDroneStrings);
    const lng = numberFromPayload(body.lng ?? body.lon ?? body.longitude ?? suppliedCaptureLocation?.lng ?? suppliedCaptureLocation?.lon ?? suppliedCaptureLocation?.longitude, allowDroneStrings);
    const gpsAccuracy = numberFromPayload(body.gpsAccuracy ?? body.accuracyMeters ?? suppliedCaptureLocation?.gpsAccuracy ?? suppliedCaptureLocation?.accuracyMeters, allowDroneStrings);
    const areaText = textFromPayload(body.areaText);
    const imageHash = textFromPayload(body.imageHash);
    const imageBase64 = textFromPayload(body.imageBase64) || textFromPayload(body.image);
    const originalBase64Payload = textFromPayload(body.originalBase64) || textFromPayload(body.image);
    const imageMimeType = textFromPayload(body.imageMimeType) || textFromPayload(body.mimeType) || textFromPayload(body.contentType);
    const fileModifiedAt = textFromPayload(body.fileModifiedAt);
    const capturedAt = textFromPayload(body.capturedAt) || textFromPayload(body.detectedAt) || textFromPayload(body.detectionTime) || textFromPayload(body.timestamp);
    const photoCapturedAt = textFromPayload(body.photoCapturedAt) || textFromPayload(suppliedCaptureEvidence?.photoCapturedAt) || capturedAt;
    const captureMethod = body.captureMethod;
    const cameraFacingMode = body.cameraFacingMode;
    const width = numberFromPayload(body.width, allowDroneStrings);
    const height = numberFromPayload(body.height, allowDroneStrings);
    const exifAvailable = body.exifAvailable;
    const userDescription = textFromPayload(body.userDescription) || "";
    const userId = textFromPayload(body.userId);
    const corroboratesReportId = reportSource === "citizen" ? textFromPayload(body.corroboratesReportId) : undefined;
    const droneInfo = reportSource === "drone" ? droneInfoFromPayload(body) : undefined;
    if (lat === undefined || lng === undefined || !imageBase64 || !imageMimeType || (!originalBase64Payload && reportSource !== "drone")) {
        throw new ReportSubmissionError(400, "missing_required_fields", reportSource === "drone"
            ? "lat, lng, imageBase64, and imageMimeType are required"
            : "lat, lng, imageBase64, originalBase64, and imageMimeType are required");
    }
    const normalizedDroneLocation = {
        lat,
        lng,
        accuracyMeters: gpsAccuracy,
        capturedAt: textFromPayload(body.locationCapturedAt) || textFromPayload(suppliedCaptureLocation?.capturedAt) || photoCapturedAt
    };
    const captureLocation = reportSource === "drone" ? normalizedDroneLocation : body.captureLocation;
    const captureEvidence = reportSource === "drone"
        ? validateDroneCapture({
            imageMimeType,
            width,
            height,
            photoCapturedAt,
            captureLocation
        })
        : validateLiveCameraCapture({
            imageMimeType,
            width,
            height,
            captureMethod,
            cameraFacingMode,
            photoCapturedAt,
            captureLocation
        });
    const reportLat = captureEvidence.captureLocation.lat;
    const reportLng = captureEvidence.captureLocation.lng;
    const originalEvidenceBase64 = originalBase64Payload || imageBase64;
    const serverHash = mediaHash(originalEvidenceBase64);
    if (imageHash && imageHash !== serverHash) {
        throw new ReportSubmissionError(400, "hash_mismatch", "Image upload integrity check failed.");
    }
    const existingReports = await listReports();
    if (reportSource === "citizen" && serverIdentityRequired() && !authenticatedUid)
        throw new ReportSubmissionError(401, "authentication_required", "Sign in is required to submit a server-backed civic report.");
    const reportUserId = reportSource === "drone" ? `drone:${droneInfo?.droneId || "unknown"}` : authenticatedUid || userId || "anonymous";
    let corroborationTarget;
    if (corroboratesReportId) {
        if (captureEvidence.captureMethod !== "live_camera")
            throw new ReportSubmissionError(422, "corroboration_requires_live_capture", "Community verification requires a fresh live-camera capture and current location.");
        corroborationTarget = existingReports.find((item) => item.id === corroboratesReportId);
        if (!corroborationTarget || !isEligibleForCorroboration(corroborationTarget))
            throw new ReportSubmissionError(409, "corroboration_mission_unavailable", "This community verification mission is no longer active.");
        if (corroborationTarget.userId === reportUserId)
            throw new ReportSubmissionError(403, "self_corroboration", "You cannot corroborate your own report.");
        if (existingReports.some((item) => item.corroboratesReportId === corroborationTarget.id && item.userId === reportUserId))
            throw new ReportSubmissionError(409, "duplicate_corroboration", "You have already corroborated this incident.");
        if (distanceMeters(reportLat, reportLng, corroborationTarget.lat, corroborationTarget.lng) > corroborationCaptureRadiusMeters())
            throw new ReportSubmissionError(422, "corroboration_too_far", "Your current location is outside the verification area. Only verify this event if you are already nearby and it is safe.");
    }
    const duplicate = existingReports.find((item) => item.imageHash === serverHash &&
        Date.now() - new Date(item.createdAt).getTime() < 24 * 60 * 60 * 1000);
    if (duplicate) {
        // Idempotent retry: return the already-persisted report instead of
        // surfacing a noisy 409 when Capture retries the same frame.
        return duplicate;
    }
    let gemini;
    let decision;
    if (reportSource === "drone") {
        ({ gemini, decision } = yoloDroneVerification(droneInfo));
    }
    else {
        try {
            gemini = await analyzeImageData({ imageBase64, fallbackImageBase64: originalEvidenceBase64, imageMimeType, context: userDescription });
        }
        catch (error) {
            if (error instanceof VerificationError)
                throw error;
            throw new ReportSubmissionError(503, "gemini_unavailable", "AI verification is temporarily unavailable. Please retry your fresh capture shortly.");
        }
    }
    const resolvedDecision = decision || decideVerification(gemini);
    // A submitted Capture image must remain available to Officer review even
    // when Gemini cannot confidently classify it.  Keep the report, marking it
    // for review, instead of returning 422 and losing it from the queue.
    if (!resolvedDecision.accepted && reportSource !== "drone") {
        resolvedDecision.accepted = true;
        resolvedDecision.evidenceStatus = "needs_review";
        resolvedDecision.trustLevel = "Needs Review";
        resolvedDecision.reasonCode = "needs_officer_review";
    }
    if (!resolvedDecision.accepted) {
        throw new ReportSubmissionError(422, resolvedDecision.reasonCode || "not_pollution", resolvedDecision.message || "No visible pollution evidence was found.");
    }
    const reportId = `CLS-${Math.random().toString(36).slice(2, 6).toUpperCase()}-${Date.now()
        .toString()
        .slice(-4)}`;
    const mediaId = `MED-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const media = await storeReportMedia({
        reportId,
        mediaId,
        originalBase64: originalEvidenceBase64,
        thumbnailBase64: imageBase64,
        mimeType: imageMimeType,
        fileModifiedAt,
        capturedAt: captureEvidence.photoCapturedAt,
        width,
        height,
        exifAvailable: Boolean(exifAvailable),
        captureEvidence
    });
    const priorNearbyCount = existingReports.filter((item) => Date.now() - new Date(item.createdAt).getTime() < 24 * 60 * 60 * 1000 &&
        distanceMeters(reportLat, reportLng, item.lat, item.lng) <= 500).length;
    const userRecentReports = existingReports.filter((item) => item.userId === reportUserId &&
        Date.now() - new Date(item.createdAt).getTime() < 24 * 60 * 60 * 1000);
    const authenticity = assessAuthenticity({
        media,
        gemini,
        duplicateRecent: false,
        userRecentReports,
        nearbyCount: priorNearbyCount,
        locationText: areaText
    });
    const evidence = scoreEvidence({
        gemini,
        authenticity,
        nearbyCount: priorNearbyCount,
        hasPreciseLocation: Number.isFinite(reportLat) && Number.isFinite(reportLng),
        uploadedAt: media.uploadedAt,
        decision: resolvedDecision
    });
    const [airQualityResult, cpcbContextResult, forecastResult, surroundingsResult] = await Promise.allSettled([
        getAirQuality(reportLat, reportLng),
        getCpcbLocalPollutantContext(reportLat, reportLng, { radiusKm: 25 }),
        getAqiForecast({ lat: reportLat, lng: reportLng }),
        getSurroundingContext({ lat: reportLat, lng: reportLng, pollutionType: gemini.pollution_type })
    ]);
    const airQuality = airQualityResult.status === "fulfilled" ? airQualityResult.value : {
        provider: "unavailable",
        status: "unavailable",
        pollutants: {},
        warnings: [{ code: "provider_error", message: "Current air-quality providers were unavailable." }],
        rawSummary: "Air-quality context unavailable; report submission continued."
    };
    const cpcbContext = cpcbContextResult.status === "fulfilled" ? cpcbContextResult.value : undefined;
    const forecast = forecastResult.status === "fulfilled" ? forecastResult.value : undefined;
    const surroundingContext = surroundingsResult.status === "fulfilled" ? surroundingsResult.value : undefined;
    const report = await createReport({
        id: reportId,
        lat: reportLat,
        lng: reportLng,
        areaText: areaText || `${reportLat.toFixed(4)}, ${reportLng.toFixed(4)}`,
        imageHash: serverHash,
        imageUrl: media.displayUrl || media.publicUrl,
        media: [media],
        primaryMediaId: media.mediaId,
        evidenceStatus: resolvedDecision.evidenceStatus,
        authenticityScore: authenticity.authenticityScore,
        authenticityFlags: authenticity.authenticityFlags,
        evidenceScore: evidence.evidenceScore,
        trustLevel: resolvedDecision.trustLevel === "Needs Review" ? "Needs Review" : evidence.trustLevel,
        rejectionReason: gemini.rejection_reason,
        scoreBreakdown: evidence.scoreBreakdown,
        evidenceReasons: evidence.reasons,
        userDescription,
        userId: reportUserId,
        gemini,
        airQuality,
        forecast,
        cpcbContext,
        surroundingContext,
        captureEvidence,
        reportSource,
        droneInfo,
        corroboratesReportId
    });
    const nearby = findNearbyReports(report, existingReports);
    const hotspotScore = calculateHotspotScore(gemini.severity, nearby.similarReportCount, airQuality, evidence.evidenceScore, forecast, cpcbContext, gemini.pollution_type, surroundingContext, nearby.independentNearbyReporterCount, nearby.verifiedCorroborationCount);
    const locality = buildLocalitySummary({ ...report, nearby }, existingReports);
    const status = resolvedDecision.status;
    const nextTrustLevel = resolvedDecision.trustLevel === "Needs Review" ? "Needs Review" : evidence.trustLevel;
    const updated = await updateReport(report.id, {
        nearby,
        locality,
        hotspotScore,
        trustLevel: nextTrustLevel,
        priority: priorityForHotspotScore(hotspotScore, nextTrustLevel),
        status,
        corroboratesReportId,
        statusHistory: [
            reportSource === "drone"
                ? { status: "detected", label: "Drone Detection", timestamp: report.createdAt, updatedByRole: "system", message: "Drone image and GPS data received." }
                : { status: "submitted", label: "Report Submitted", timestamp: report.createdAt, updatedByRole: "citizen", message: "Report received." },
            ...(resolvedDecision.evidenceStatus === "verified" ? [{ status: "verified", label: reportSource === "drone" ? "YOLO Detection Accepted" : "Evidence Verified", timestamp: new Date().toISOString(), updatedByRole: "system", message: reportSource === "drone" ? "YOLO reported a qualifying garbage or pollution detection." : "The submitted image and location evidence have been verified." }] : [])
        ]
    });
    const reportWithRisk = updated
        ? await updateReport(updated.id, {
            riskAdvisor: buildRiskAdvisor({
                report: updated,
                nearbyReports: [...existingReports, updated]
            })
        })
        : updated;
    if (!updated) {
        console.warn(`[Reports] Post-create update failed for ${report.id}; returning initially created report.`);
    }
    if (updated && !reportWithRisk) {
        console.warn(`[Reports] Risk advisor update failed for ${updated.id}; returning updated report.`);
    }
    let responseReport = reportWithRisk || updated || report;
    if (corroborationTarget && responseReport.evidenceStatus === "verified" && responseReport.trustLevel !== "Rejected") {
        const latestTarget = await findReport(corroborationTarget.id);
        if (latestTarget) {
            const linkedTarget = await updateReport(latestTarget.id, { corroboratedByReportIds: [...new Set([...(latestTarget.corroboratedByReportIds || []), responseReport.id])] });
            if (linkedTarget)
                await recomputeReportIntelligence(linkedTarget, [...existingReports.filter((item) => item.id !== linkedTarget.id), linkedTarget, responseReport]);
        }
    }
    try {
        const verifiedAward = await awardVerifiedContributionPoints(responseReport, [...existingReports, responseReport]);
        if (verifiedAward) {
            const rewarded = await updateReport(responseReport.id, { rewards: { ...responseReport.rewards, verifiedContribution: { points: verifiedAward.transaction.points, transactionId: verifiedAward.transaction.transactionId, awardedAt: verifiedAward.transaction.createdAt } } });
            responseReport = { ...(rewarded || responseReport), rewardAwarded: { type: "verified_contribution", points: verifiedAward.transaction.points } };
        }
    }
    catch (error) {
        console.warn("[Rewards] Verified contribution award failed; report submission continued.", error);
    }
    const earthEngineEnabled = process.env.ENABLE_EARTH_ENGINE === "true";
    if (earthEngineEnabled) {
        const readiness = getEarthEngineReadiness();
        if (readiness.configured) {
            responseReport.satelliteEvidence = buildPendingSatelliteEvidence(responseReport);
            await updateReport(responseReport.id, { satelliteEvidence: responseReport.satelliteEvidence });
            void enqueueSatelliteVerification(responseReport.id, responseReport.updatedAt);
        }
        else {
            responseReport.satelliteEvidence = buildPendingSatelliteEvidence(responseReport);
            if (responseReport.satelliteEvidence) {
                const unavailable = "Google Earth Engine satellite context is unavailable in this environment.";
                responseReport.satelliteEvidence.status = "unavailable";
                responseReport.satelliteEvidence.explanation = unavailable;
                responseReport.satelliteEvidence.warnings = [unavailable];
                responseReport.satelliteEvidence.error = { code: readiness.errorCode || "EARTH_ENGINE_NOT_CONFIGURED", message: unavailable, retryable: false };
            }
            await updateReport(responseReport.id, { satelliteEvidence: responseReport.satelliteEvidence });
        }
    }
    return hydrateReportMediaUrls(responseReport);
}
function reportSubmissionStatus(error) {
    if (error instanceof ReportSubmissionError)
        return error.status;
    if (error instanceof MediaStorageUnavailableError)
        return 503;
    if (error instanceof VerificationError && ["gemini_not_configured", "gemini_unavailable", "gemini_network_failed"].includes(error.reasonCode))
        return 503;
    if (error instanceof VerificationError && error.reasonCode === "gemini_rate_limited")
        return 429;
    if (error instanceof CaptureValidationError)
        return 400;
    if (error instanceof VerificationError)
        return 422;
    return 500;
}
function reportSubmissionReasonCode(error) {
    if (error instanceof ReportSubmissionError)
        return error.reasonCode;
    if (error instanceof MediaStorageUnavailableError)
        return error.code;
    if (error instanceof CaptureValidationError || error instanceof VerificationError)
        return error.reasonCode;
    return "report_creation_failed";
}
function sendReportSubmissionError(res, error) {
    const message = error instanceof Error ? error.message : "Report verification failed.";
    res.status(reportSubmissionStatus(error)).json({
        error: error instanceof MediaStorageUnavailableError ? error.message : message,
        reasonCode: reportSubmissionReasonCode(error)
    });
}
// ── GET /api/reports — list all reports ──────────────────────────────────────
reportsRouter.get("/reports", (_req, res) => {
    void (async () => {
        res.json(await hydrateReportsMediaUrls(await listReports()));
    })();
});
// YOLO/ESP32-CAM integration feed. The POST endpoint accepts the same JSON
// payload and persists it with report media; imageBase64 may be a data URL.
reportsRouter.get("/drone-reports", (_req, res) => {
    void (async () => {
        const reports = (await listReports()).filter((report) => report.reportSource === "drone" && Boolean(report.droneInfo));
        res.json(await hydrateReportsMediaUrls(reports));
    })();
});
// ── GET /api/reports/mine?userId=xxx — reports by user ───────────────────────
reportsRouter.get("/reports/mine", (req, res) => {
    void (async () => {
        const userId = typeof req.query["userId"] === "string" ? req.query["userId"] : null;
        if (!userId) {
            res.status(400).json({ error: "userId query parameter is required" });
            return;
        }
        const mine = await hydrateReportsMediaUrls(await listReportsByUser(userId));
        res.json(mine);
    })();
});
reportsRouter.get("/leaderboard", async (req, res) => {
    const period = req.query.period === "monthly" ? "monthly" : "all";
    const locality = typeof req.query.locality === "string" ? req.query.locality.trim() : undefined;
    res.json({ period, locality: locality || null, entries: await getLeaderboard({ period, locality }) });
});
reportsRouter.get("/users/:id/rewards", async (req, res) => {
    const profile = await getRewards(req.params.id);
    if (!profile)
        return res.json({ profile: null });
    const { userId: _userId, ...publicProfile } = profile;
    res.json({ profile: publicProfile });
});
reportsRouter.get("/users/:id/points-history", async (req, res) => {
    const transactions = await getPointsHistory(req.params.id);
    res.json({ transactions: transactions.map(({ userId: _userId, ...transaction }) => transaction) });
});
// ── GET /api/status — local persistence/provider readiness ──────────────────
reportsRouter.get("/status", (_req, res) => {
    void (async () => {
        const openAq = await getOpenAqStatus(false);
        res.json({
            service: "netranagar",
            reportStore: "local_json",
            rewardStore: "local_json",
            mediaStorage: "local",
            cpcbConfigured: Boolean(process.env.DATA_GOV_API_KEY),
            openAqConfigured: openAq.configured,
            openAqAuthenticationSuccessful: openAq.authenticationSuccessful,
            currentAirQualityConfigured: Boolean(process.env.DATA_GOV_API_KEY || process.env.OPENAQ_API_KEY),
            forecastEngineConfigured: true,
            geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
            surroundingContext: getSurroundingContextStatus(),
            earthEngine: getEarthEngineReadiness(),
            ...getStateForecastStatus()
        });
    })();
});
// ── GET /api/air-quality/state-forecasts ─────────────────────────────────────
reportsRouter.get("/air-quality/state-forecasts", (req, res) => {
    void (async () => {
        try {
            const forceRefresh = req.query["forceRefresh"] === "true";
            const data = await Promise.race([
                getStateForecasts(forceRefresh),
                new Promise((resolve) => setTimeout(() => resolve(null), 8_000))
            ]);
            if (!data) {
                res.status(202).json({
                    generatedAt: new Date().toISOString(),
                    reason: "State forecasts are preparing. Please retry shortly.",
                    data: null,
                    states: []
                });
                return;
            }
            res.json(data);
        }
        catch (err) {
            console.error("[StateForecast] Error:", err);
            res.status(500).json({ error: "Failed to fetch state forecasts." });
        }
    })();
});
reportsRouter.post("/reports", (req, res) => {
    if (process.env.VITE_DEMO_BROWSER_STORAGE === "true") {
        return res.status(409).json({ error: "This Netlify demonstration stores report evidence only in browser IndexedDB.", reasonCode: "browser_demo_storage_required" });
    }
    void (async () => {
        try {
            res.status(201).json(await createAnalyzedReportFromPayload(req.body || {}, "citizen", req.auth?.uid));
        }
        catch (error) {
            sendReportSubmissionError(res, error);
        }
    })();
});
reportsRouter.post("/drone-reports", (req, res) => {
    if (process.env.VITE_DEMO_BROWSER_STORAGE === "true") {
        return res.status(409).json({ error: "This Netlify demonstration stores drone report evidence only in browser IndexedDB.", reasonCode: "browser_demo_storage_required" });
    }
    void (async () => {
        try {
            res.status(201).json(await createAnalyzedReportFromPayload(req.body || {}, "drone", req.auth?.uid));
        }
        catch (error) {
            sendReportSubmissionError(res, error);
        }
    })();
});
reportsRouter.get("/corroboration-missions", (req, res) => {
    void (async () => {
        const lat = Number(req.query.lat);
        const lng = Number(req.query.lng);
        const requestedRadius = Number(req.query.radiusKm || missionDiscoveryRadiusMeters() / 1000);
        if (!Number.isFinite(lat) || !Number.isFinite(lng))
            return res.status(400).json({ error: "lat and lng are required" });
        const userId = typeof req.query.userId === "string" ? req.query.userId : undefined;
        const radiusMeters = Math.max(100, Math.min(2, Number.isFinite(requestedRadius) ? requestedRadius : missionDiscoveryRadiusMeters() / 1000)) * 1000;
        res.json({ missions: listCorroborationMissions(await listReports(), { lat, lng, radiusMeters, userId: req.auth?.uid || userId }) });
    })();
});
reportsRouter.post("/analyze-report", async (req, res) => {
    const { reportId } = req.body || {};
    const report = await findReport(reportId);
    if (!report) {
        res.status(404).send("Report not found");
        return;
    }
    const [airQualityResult, forecastResult] = await Promise.allSettled([
        getAirQuality(report.lat, report.lng),
        getAqiForecast({ lat: report.lat, lng: report.lng })
    ]);
    const airQuality = airQualityResult.status === "fulfilled" ? airQualityResult.value : report.airQuality;
    const forecast = forecastResult.status === "fulfilled" ? forecastResult.value : report.forecast;
    const allReports = await listReports();
    const nearby = findNearbyReports(report, allReports);
    const hotspotScore = calculateHotspotScore(report.gemini.severity, nearby.similarReportCount, airQuality, report.evidenceScore, forecast, report.cpcbContext, report.gemini.pollution_type, report.surroundingContext, nearby.independentNearbyReporterCount, nearby.verifiedCorroborationCount);
    const updated = await updateReport(report.id, {
        airQuality,
        forecast,
        nearby,
        hotspotScore,
        priority: priorityForReport(report, hotspotScore),
        status: "Submitted"
    });
    const refreshed = updated
        ? await updateReport(updated.id, {
            riskAdvisor: buildRiskAdvisor({
                report: updated,
                nearbyReports: allReports
            })
        })
        : updated;
    res.json(refreshed || updated);
});
// Netlify demonstration route: analyze a compressed browser image without
// creating a report or writing any media to server-side storage.
reportsRouter.post("/demo/analyze-evidence", async (req, res) => {
    const { imageBase64, imageMimeType, context } = req.body || {};
    if (typeof imageBase64 !== "string" || typeof imageMimeType !== "string") {
        return res.status(400).json({ error: "imageBase64 and imageMimeType are required", reasonCode: "missing_required_fields" });
    }
    try {
        const gemini = await analyzeImageData({ imageBase64, imageMimeType, context: typeof context === "string" ? context : undefined });
        const decision = decideVerification(gemini);
        res.json({ gemini, decision });
    }
    catch (error) {
        const verification = error instanceof VerificationError;
        res.status(verification && error.reasonCode === "gemini_not_configured" ? 503 : verification ? 422 : 500).json({
            error: error instanceof Error ? error.message : "Demo image analysis failed.",
            reasonCode: verification ? error.reasonCode : "demo_analysis_failed"
        });
    }
});
reportsRouter.post("/debug/gemini-image", async (req, res) => {
    if (process.env.NODE_ENV === "production" || process.env.DEBUG_GEMINI_ROUTE === "false") {
        res.status(404).send("Not found");
        return;
    }
    const { imageBase64, originalBase64, imageMimeType, context } = req.body || {};
    if (!imageBase64 || !imageMimeType) {
        res.status(400).json({
            error: "imageBase64 and imageMimeType are required",
            reasonCode: "missing_required_fields"
        });
        return;
    }
    try {
        const finalGemini = await analyzeImageData({
            imageBase64,
            fallbackImageBase64: originalBase64,
            imageMimeType,
            context
        });
        const backendDecision = decideVerification(finalGemini);
        res.json({
            finalGemini,
            backendDecision,
            confidence: finalGemini.confidence,
            evidence_strength: finalGemini.evidence_strength,
            image_quality: finalGemini.image_quality,
            trust_decision: finalGemini.trust_decision,
            second_pass_used: finalGemini.second_pass_used,
            rejection_reason: finalGemini.rejection_reason,
            notes: "Development-only Gemini classifier check. No media was stored and no report was created."
        });
    }
    catch (error) {
        res.status(error instanceof VerificationError && error.reasonCode === "gemini_not_configured" ? 503 : error instanceof VerificationError ? 422 : 500).json({
            error: error instanceof Error ? error.message : "Gemini debug check failed.",
            reasonCode: error instanceof VerificationError ? error.reasonCode : "gemini_debug_failed"
        });
    }
});
reportsRouter.get("/air-quality", async (req, res) => {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (Number.isNaN(lat) || Number.isNaN(lng)) {
        res.status(400).send("lat and lng query params are required");
        return;
    }
    res.json(await getAirQuality(lat, lng));
});
reportsRouter.get("/forecast/stations", async (_req, res) => {
    res.json(await getForecastStations());
});
reportsRouter.get("/forecast", async (req, res) => {
    const lat = req.query.lat !== undefined ? Number(req.query.lat) : undefined;
    const lng = req.query.lng !== undefined ? Number(req.query.lng) : undefined;
    res.json(await getAqiForecast({
        lat: Number.isFinite(lat) ? lat : undefined,
        lng: Number.isFinite(lng) ? lng : undefined
    }));
});
reportsRouter.get("/air-quality/forecast-24h", async (req, res) => {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (Number.isNaN(lat) || Number.isNaN(lng)) {
        res.status(400).json({ error: "lat and lng query params are required" });
        return;
    }
    res.json(await getAqiForecast({ lat, lng }));
});
function pollutantQuery(value) {
    if (typeof value !== "string")
        return undefined;
    const normalized = value.toUpperCase();
    if (normalized === "ALL")
        return "all";
    if (normalized === "PM2.5" || normalized === "PM25")
        return "PM2.5";
    if (normalized === "PM10")
        return "PM10";
    if (normalized === "NO2")
        return "NO2";
    if (normalized === "SO2")
        return "SO2";
    if (normalized === "CO")
        return "CO";
    if (normalized === "OZONE" || normalized === "O3")
        return "OZONE";
    if (normalized === "NH3")
        return "NH3";
    if (normalized === "PB" || normalized === "LEAD")
        return "PB";
    return undefined;
}
reportsRouter.get("/air-quality/cpcb/status", async (_req, res) => {
    res.json(await getCpcbStatus());
});
reportsRouter.get("/air-quality/cpcb/completeness", async (_req, res) => {
    res.json(await getCpcbStatus());
});
reportsRouter.get("/air-quality/openaq/status", async (req, res) => {
    const check = req.query.check === "true";
    res.json(await getOpenAqStatus(check));
});
reportsRouter.get("/air-quality/cpcb/nearby", async (req, res) => {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        res.status(400).json({ error: "lat and lng query params are required" });
        return;
    }
    const radiusKm = req.query.radiusKm !== undefined ? Number(req.query.radiusKm) : undefined;
    const limit = req.query.limit !== undefined ? Number(req.query.limit) : undefined;
    try {
        res.json(await getNearbyCpcbStations(lat, lng, {
            radiusKm: Number.isFinite(radiusKm) ? radiusKm : undefined,
            limit: Number.isFinite(limit) ? limit : undefined,
            pollutant: pollutantQuery(req.query.pollutant)
        }));
    }
    catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : "Unable to load nearby CPCB stations.", reasonCode: "invalid_cpcb_query" });
    }
});
reportsRouter.get("/air-quality/openaq/nearby", async (req, res) => {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        res.status(400).json({ error: "lat and lng query params are required", reasonCode: "invalid_coordinates" });
        return;
    }
    const radiusKm = req.query.radiusKm !== undefined ? Number(req.query.radiusKm) : 25;
    const limit = req.query.limit !== undefined ? Number(req.query.limit) : 12;
    try {
        validateOpenAqRadius(radiusKm);
        const stations = await getOpenAqNearbyStations(lat, lng, { radiusKm, limit });
        res.json({ provider: "openaq", lat, lng, radiusKm, stations, stationCount: stations.length, generatedAt: new Date().toISOString(), sourceNote: "OpenAQ monitoring locations and latest measurements. Values are station-derived context, not exact street-level sensor data." });
    }
    catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : "Unable to load nearby OpenAQ stations.", reasonCode: "openaq_query_failed" });
    }
});
reportsRouter.get("/air-quality/cpcb/local-context", async (req, res) => {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        res.status(400).json({ error: "lat and lng query params are required" });
        return;
    }
    const radiusKm = req.query.radiusKm !== undefined ? Number(req.query.radiusKm) : undefined;
    res.json(await getCpcbLocalPollutantContext(lat, lng, {
        radiusKm: Number.isFinite(radiusKm) ? radiusKm : undefined,
        pollutant: pollutantQuery(req.query.pollutant)
    }));
});
reportsRouter.get("/locality", async (req, res) => {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        res.status(400).send("lat and lng query params are required");
        return;
    }
    const historical = req.query.historical === "true";
    res.json(buildLocalityIntelligence({
        lat,
        lng,
        historical,
        reports: await listReports()
    }));
});
reportsRouter.get("/air-quality/sources", async (req, res) => {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (Number.isNaN(lat) || Number.isNaN(lng)) {
        res.status(400).send("lat and lng query params are required");
        return;
    }
    res.json(await getAirQualitySources(lat, lng));
});
// Dev-only debug endpoint to see what DataGov actually returns
reportsRouter.get("/air-quality/cpcb/raw-page", async (req, res) => {
    if (process.env.NODE_ENV === "production")
        return res.status(403).json({ error: "Dev only" });
    try {
        const offset = Number(req.query.offset) || 0;
        const limit = Number(req.query.limit) || 10;
        const resourceId = process.env.CPCB_RESOURCE_ID || "3b01bcb8-0b14-4abf-b6f2-c1bfd384ba69";
        const apiKey = process.env.DATA_GOV_API_KEY || "";
        const url = new URL(`https://api.data.gov.in/resource/${resourceId}`);
        url.searchParams.set("api-key", apiKey);
        url.searchParams.set("format", "json");
        url.searchParams.set("limit", String(limit));
        url.searchParams.set("offset", String(offset));
        const start = Date.now();
        const response = await fetch(url);
        const duration = Date.now() - start;
        if (!response.ok) {
            return res.status(response.status).json({ error: `DataGov returned ${response.status}`, body: await response.text() });
        }
        const data = await response.json();
        const records = data.records || [];
        res.json({
            configured: Boolean(apiKey),
            resourceId,
            requestedOffset: offset,
            requestedLimit: limit,
            durationMs: duration,
            rawCount: data.count,
            rawTotal: data.total,
            rawLimit: data.limit,
            rawOffset: data.offset,
            firstRecordKeys: records.length > 0 ? Object.keys(records[0]) : [],
            recordSample: records.slice(0, 3)
        });
    }
    catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : "Failed" });
    }
});
reportsRouter.get("/air-quality/map", async (req, res) => {
    const hasLat = typeof req.query.lat === "string";
    const hasLng = typeof req.query.lng === "string";
    if (hasLat !== hasLng)
        return res.status(400).json({ error: "lat and lng must be provided together." });
    const lat = hasLat ? Number(req.query.lat) : undefined;
    const lng = hasLng ? Number(req.query.lng) : undefined;
    if ((lat !== undefined && (!Number.isFinite(lat) || lat < -90 || lat > 90)) || (lng !== undefined && (!Number.isFinite(lng) || lng < -180 || lng > 180))) {
        return res.status(400).json({ error: "lat and lng must be valid coordinates." });
    }
    res.json(await getAirQualityMap(lat === undefined || lng === undefined ? undefined : { lat, lng }));
});
reportsRouter.get("/air-quality/national-status", async (req, res) => {
    const forceRefresh = req.query.refresh === "true";
    if (forceRefresh)
        await refreshOpenAqNationalSnapshot();
    const [cpcb, map] = await Promise.all([getCpcbStatus(), getAirQualityMap()]);
    const openaq = getOpenAqNationalSnapshot().status;
    const currentAqi = getCurrentAqiStatus();
    const counts = map.providerCounts || {};
    res.json({
        generatedAt: new Date().toISOString(),
        cpcb: { configured: Boolean(process.env.DATA_GOV_API_KEY), complete: Boolean(cpcb.complete), apiReportedTotal: cpcb.apiReportedTotal, rawFetchedCount: cpcb.rawFetchedCount, uniqueFetchedCount: cpcb.uniqueFetchedCount, fetchedPageCount: cpcb.fetchedPageCount, expectedPageCount: cpcb.expectedPageCount, stationCount: cpcb.stationCount, stopReason: cpcb.stopReason, staleCacheInUse: Boolean(cpcb.staleFallback) },
        openaq: { configured: openaq.configured, authenticationSuccessful: openaq.authenticationSuccessful, metadataComplete: openaq.metadataComplete, latestSnapshotComplete: openaq.latestSnapshotComplete, providerReportedLocationCount: openaq.providerReportedLocationCount, fetchedLocationCount: openaq.fetchedLocationCount, processedLocationCount: openaq.processedLocationCount, successfulLatestCount: openaq.successfulLatestCount, failedLatestCount: openaq.failedLatestCount, staleLocationCount: openaq.staleLocationCount, queuedLocationCount: openaq.queuedLocationCount, lastRefreshAt: openaq.lastRefreshAt, nextRefreshAt: openaq.nextRefreshAt },
        merged: { physicalStationCount: map.points.length, matchedStationCount: counts.fused_measured || 0, cpcbOnlyCount: counts.cpcb_data_gov || 0, openAqOnlyCount: counts.openaq || 0, lowConfidenceMatchCount: 0 },
        pollutants: map.metricCoverage,
        aqi: map.aqiCoverage,
        currentAqi,
        nationalMapComplete: Boolean(map.completeness?.nationalMapComplete),
        warnings: map.warnings?.map((warning) => warning.message) || []
    });
});
reportsRouter.get("/air-quality/aqi-status", async (req, res) => {
    // Keep polling nonblocking. The national OpenAQ sync is intentionally a
    // background job; waiting for hundreds of provider requests here would make
    // the frontend unable to observe progress.
    const initialNational = getOpenAqNationalSnapshot();
    if (req.query.refresh === "true" && initialNational.stations.length > 0)
        void refreshOpenAqNationalSnapshot();
    const national = getOpenAqNationalSnapshot();
    if (req.query.refresh === "true") {
        void refreshCurrentAqiSnapshot(national.stations);
    }
    else {
        getCurrentAqiSnapshot(national.stations);
    }
    const current = getCurrentAqiStatus();
    const cachedCoverage = getLatestAqiCoverage();
    const coverage = cachedCoverage
        ? { ...cachedCoverage, providerReported: cachedCoverage.providerReportedEligibleStations, rollingValidated: current.successfulValidatedStations, indicative: cachedCoverage.indicativeEligibleStations, pending: current.queuedStations, unavailable: cachedCoverage.unavailableStations, totalPhysicalStations: cachedCoverage.totalPhysicalStations }
        : { providerReported: 0, rollingValidated: current.successfulValidatedStations, indicative: 0, pending: current.queuedStations, unavailable: 0, totalPhysicalStations: current.totalPhysicalStations };
    const warnings = [...new Set([...(national.status.refreshing ? ["OpenAQ national station synchronization is still running."] : []), ...current.warnings])];
    res.json({ generatedAt: new Date().toISOString(), snapshot: current, coverage, reasons: current.reasons, warnings });
});
reportsRouter.get("/air-quality/audit/station/:physicalStationId", async (req, res) => {
    if (process.env.NODE_ENV === "production")
        return res.status(404).json({ error: "Not found" });
    const map = await getAirQualityMap();
    const point = map.points.find((candidate) => candidate.physicalStationId === req.params.physicalStationId || candidate.id === req.params.physicalStationId);
    if (!point)
        return res.status(404).json({ error: "Station not found" });
    res.json({ id: point.id, physicalStationId: point.physicalStationId, name: point.name, provider: point.provider, coordinates: { lat: point.lat, lng: point.lng }, metricDetails: point.metricDetails, aqi: point.aqiStatus, station: point.station, attribution: point.attribution });
});
reportsRouter.get("/air-quality/local-map", async (req, res) => {
    const region = typeof req.query.region === "string" ? req.query.region : "pune_pcmc";
    res.json(await getLocalAirQualityMap(region));
});
reportsRouter.get("/air-quality/debug", async (req, res) => {
    if (process.env.NODE_ENV === "production") {
        res.status(404).send("Not found");
        return;
    }
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (Number.isNaN(lat) || Number.isNaN(lng)) {
        res.status(400).send("lat and lng query params are required");
        return;
    }
    res.json(await getAirQualityDebug(lat, lng));
});
reportsRouter.patch("/reports/:id/status", (req, res) => {
    void (async () => {
        const status = req.body?.status;
        if (!status) {
            res.status(400).send("status is required");
            return;
        }
        const report = await updateStatus(req.params.id, status);
        if (!report) {
            res.status(404).send("Report not found");
            return;
        }
        res.json(report);
    })();
});
reportsRouter.patch("/reports/:id/action", (req, res) => {
    void (async () => {
        const report = await findReport(req.params.id);
        if (!report) {
            res.status(404).send("Report not found");
            return;
        }
        const now = new Date().toISOString();
        const { status, assignedTo, assignedDepartment, actionTaken, notes } = req.body || {};
        const updated = await updateReport(report.id, {
            status: status || report.status,
            assignedTo,
            assignedDepartment,
            actionTaken,
            actionLog: [
                ...(report.actionLog ?? []),
                {
                    type: assignedTo || assignedDepartment ? "assigned" : "status_changed",
                    at: now,
                    note: [status, assignedDepartment, assignedTo, actionTaken, notes].filter(Boolean).join(" · ") || undefined
                }
            ],
            statusHistory: appendStatusHistory(report, assignedTo || assignedDepartment ? "assigned" : "acknowledged", assignedTo || assignedDepartment ? "Assigned to Municipal Team" : "Officer Acknowledged", "officer", notes)
        });
        res.json(updated);
    })();
});
reportsRouter.post("/reports/:id/resolve", (req, res) => {
    res.status(410).json({
        error: "Direct resolution is no longer supported. Municipal cleanup proof and Officer approval are required.",
        reasonCode: "legacy_resolution_route_disabled"
    });
    return;
    void (async () => {
        const report = await findReport(req.params.id);
        if (!report) {
            res.status(404).json({ error: "Report not found", reasonCode: "not_found" });
            return;
        }
        const { afterImageBase64, imageMimeType, actionTaken, notes, resolvedBy } = req.body || {};
        if (!afterImageBase64 || !imageMimeType || !actionTaken) {
            res.status(400).json({
                error: "afterImageBase64, imageMimeType, and actionTaken are required",
                reasonCode: "missing_required_fields"
            });
            return;
        }
        const afterMedia = await storeResolutionMedia({
            reportId: report.id,
            imageBase64: afterImageBase64,
            mimeType: imageMimeType
        });
        const resolvedAt = new Date().toISOString();
        const updated = await updateReport(report.id, {
            status: "Resolved",
            priority: "resolved",
            resolvedAt,
            actionTaken,
            resolutionProof: {
                beforeMediaId: report.primaryMediaId,
                afterMedia,
                actionTaken,
                resolvedBy,
                resolvedAt,
                notes
            },
            actionLog: [
                ...(report.actionLog ?? []),
                { type: "resolution_proof_uploaded", at: resolvedAt, note: actionTaken },
                { type: "resolved", at: resolvedAt, note: notes || actionTaken }
            ]
        });
        res.json(updated);
    })();
});
// Municipal workflow: a municipal field team may provide progress and cleanup evidence, but this
// route never resolves a citizen report. Officer approval remains required.
reportsRouter.patch("/reports/:id/ngo-progress", requireProductionRole("municipal"), async (req, res) => {
    const report = await findReport(String(req.params.id));
    if (!report)
        return res.status(404).json({ error: "Report not found" });
    const status = req.body?.status;
    if (!['Accepted', 'Cleanup In Progress'].includes(status))
        return res.status(400).json({ error: "Invalid municipal progress status" });
    const now = new Date().toISOString();
    const ngoName = typeof req.body?.ngoName === "string" ? req.body.ngoName : report.ngoAssignment?.ngoName || "Demo Municipal Team";
    const accepted = status === "Accepted";
    res.json(await updateReport(report.id, { status: accepted ? "Accepted" : "In Progress", ngoAssignment: { ngoName, assignedAt: report.ngoAssignment?.assignedAt || now, status }, actionLog: [...(report.actionLog || []), { type: "ngo_progress_updated", at: now, note: status }], statusHistory: appendStatusHistory(report, accepted ? "accepted" : "cleanup_in_progress", accepted ? "Accepted" : "Cleanup In Progress", "municipal", status) }));
});
reportsRouter.post("/reports/:id/ngo-cleanup-proof", requireProductionRole("municipal"), async (req, res) => {
    if (process.env.VITE_DEMO_BROWSER_STORAGE === "true") {
        return res.status(409).json({ error: "This Netlify demonstration stores cleanup proof only in browser IndexedDB.", reasonCode: "browser_demo_storage_required" });
    }
    const report = await findReport(String(req.params.id));
    if (!report)
        return res.status(404).json({ error: "Report not found" });
    const { afterImageBase64, imageMimeType, uploaderId, locality, lat, lng, gpsAccuracy, actionTaken, note } = req.body || {};
    if (!afterImageBase64 || !imageMimeType || !uploaderId || !actionTaken)
        return res.status(400).json({ error: "afterImageBase64, imageMimeType, uploaderId and actionTaken are required" });
    if (report.cleanupProof && report.status !== "In Progress")
        return res.status(409).json({ error: "A cleanup proof has already been submitted for this report" });
    const afterMedia = await storeResolutionMedia({ reportId: report.id, imageBase64: afterImageBase64, mimeType: imageMimeType });
    const now = new Date().toISOString();
    // The comparison fields are explicitly preliminary demo values; no claim of
    // official resolution is made without an officer review.
    const cleanupProof = { afterMedia, submittedAt: now, uploaderId, locality, lat: Number(lat), lng: Number(lng), gpsAccuracy: Number(gpsAccuracy), actionTaken, note, cleanupPercentage: 0, locationMatch: Number.isFinite(Number(lat)) && Number.isFinite(Number(lng)), aiConfidence: 0, remainingPollution: "Officer review required", summary: "Cleanup proof received; officer approval is pending." };
    res.json(await updateReport(report.id, { status: "Cleanup Proof Submitted", ngoAssignment: { ngoName: report.ngoAssignment?.ngoName || "Demo Municipal Team", assignedAt: report.ngoAssignment?.assignedAt || now, status: "Cleanup Proof Submitted" }, cleanupProof, actionLog: [...(report.actionLog || []), { type: "ngo_cleanup_proof_submitted", at: now, note: actionTaken }], statusHistory: appendStatusHistory(report, "cleanup_proof_submitted", "Cleanup Proof Submitted", "municipal", actionTaken) }));
});
// Publicly documented resolution workflow aliases. Municipal uploads use
// the same non-resolving proof path; officer approval is handled separately.
reportsRouter.get("/ngo/assigned-reports", async (_req, res) => {
    const reports = await listReports();
    res.json(await hydrateReportsMediaUrls(reports.filter((report) => report.ngoAssignment || report.assignedDepartment === "Sanitation")));
});
reportsRouter.patch("/ngo/reports/:id/status", async (req, res) => {
    req.url = `/reports/${req.params.id}/ngo-progress`;
    return reportsRouter.handle(req, res);
});
reportsRouter.patch("/municipal/reports/:id/status", async (req, res) => {
    req.url = `/reports/${req.params.id}/ngo-progress`;
    return reportsRouter.handle(req, res);
});
reportsRouter.post("/reports/:id/resolution-proof", async (req, res) => {
    req.url = `/reports/${req.params.id}/ngo-cleanup-proof`;
    return reportsRouter.handle(req, res);
});
reportsRouter.get("/reports/:id/resolution", async (req, res) => {
    const report = await findReport(String(req.params.id));
    if (!report)
        return res.status(404).json({ error: "Report not found" });
    res.json({ reportId: report.id, resolution: report.cleanupProof || report.resolutionProof || null });
});
reportsRouter.patch("/reports/:id/resolution-status", requireProductionRole("officer"), async (req, res) => {
    const report = await findReport(String(req.params.id));
    if (!report)
        return res.status(404).json({ error: "Report not found" });
    const status = req.body?.status;
    if (!["Resolved", "Declined"].includes(status))
        return res.status(400).json({ error: "Resolution status must be Resolved or Declined" });
    if (!report.cleanupProof)
        return res.status(400).json({ error: "A municipal cleanup proof is required before approval" });
    if (status === "Declined") {
        const now = new Date().toISOString();
        return res.json(await updateReport(report.id, {
            status: "In Progress",
            actionLog: [...(report.actionLog || []), { type: "status_changed", at: now, note: "Officer declined municipal cleanup proof; resubmission required." }],
            statusHistory: appendStatusHistory(report, "cleanup_proof_declined", "Cleanup Proof Declined", "officer", "Municipal cleanup proof needs correction and resubmission.")
        }));
    }
    if (report.status === "Resolved")
        return res.json(report);
    const now = new Date().toISOString();
    const officerId = req.auth?.uid || (serverIdentityRequired() ? "Officer" : typeof req.body?.officerId === "string" ? req.body.officerId : "Officer");
    const resolved = await updateReport(report.id, { status: "Resolved", priority: "resolved", resolvedAt: now, resolutionProof: { beforeMediaId: report.primaryMediaId, afterMedia: report.cleanupProof.afterMedia, actionTaken: report.cleanupProof.actionTaken || report.cleanupProof.note || "Municipal cleanup proof approved", resolvedBy: officerId, resolvedAt: now, notes: report.cleanupProof.note }, actionLog: [...(report.actionLog || []), { type: "resolved", at: now, note: "Officer approved municipal cleanup proof" }], statusHistory: appendStatusHistory(report, "resolved", "Resolved", "officer") });
    if (!resolved)
        return res.status(500).json({ error: "Unable to finalize report resolution" });
    // `resolved.priority` is deliberately set to "resolved" for the workflow UI.
    // Preserve the earlier priority so a qualifying high-priority case receives its bonus.
    const award = await awardResolutionPoints(resolved, await listReports(), report.priority);
    if (!award)
        return res.json(resolved);
    const rewarded = await updateReport(resolved.id, {
        reward: { points: award.transaction.points, transactionId: award.transaction.transactionId, reason: award.transaction.reason, awardedAt: award.transaction.createdAt },
        rewards: { ...resolved.rewards, resolutionImpact: { points: award.transaction.points, transactionId: award.transaction.transactionId, awardedAt: award.transaction.createdAt } }
    });
    res.json(rewarded || resolved);
});
// ─── Situation routes ─────────────────────────────────────────────────────────
reportsRouter.get("/situations", (req, res) => {
    void (async () => {
        const reports = await hydrateReportsMediaUrls(await listReports());
        let situations = buildRankedSituations(reports);
        const priority = typeof req.query.priority === "string" ? req.query.priority : undefined;
        const lat = req.query.lat !== undefined ? Number(req.query.lat) : undefined;
        const lng = req.query.lng !== undefined ? Number(req.query.lng) : undefined;
        const radiusMeters = req.query.radiusMeters !== undefined ? Number(req.query.radiusMeters) : undefined;
        const limit = req.query.limit !== undefined ? Math.min(100, Number(req.query.limit)) : 20;
        if (priority) {
            situations = situations.filter((s) => s.priority === priority);
        }
        if (lat !== undefined && lng !== undefined && radiusMeters !== undefined &&
            Number.isFinite(lat) && Number.isFinite(lng) && Number.isFinite(radiusMeters)) {
            situations = situations.filter((s) => distanceMeters(lat, lng, s.centerLat, s.centerLng) <= radiusMeters);
        }
        res.json({
            generatedAt: new Date().toISOString(),
            totalSituations: situations.length,
            situations: situations.slice(0, limit)
        });
    })();
});
reportsRouter.get("/situations/:id", (req, res) => {
    void (async () => {
        const reports = await hydrateReportsMediaUrls(await listReports());
        const situations = buildRankedSituations(reports);
        const situation = situations.find((s) => s.id === req.params.id);
        if (!situation) {
            res.status(404).json({ error: "Situation not found", reasonCode: "not_found" });
            return;
        }
        const linked = reports.filter((r) => situation.reportIds.includes(r.id));
        res.json({ situation, reports: linked });
    })();
});
// Suppress unused import warning for activeLocalityStatuses and dominantPollutionType
void activeLocalityStatuses;
void dominantPollutionType;
