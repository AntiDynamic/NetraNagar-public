import { findReport, updateReport } from "./reportStore.js";
import { classifySatelliteEventSuitability } from "./satelliteSuitability.js";
import { EarthEngineProviderError, earthEngineRadiusMeters, getEarthEngineNo2Context, getEarthEngineReadiness } from "./earthEngineService.js";
function reportLocation(report) {
    const capture = report.captureEvidence?.captureLocation;
    if (capture && Number.isFinite(capture.lat) && Number.isFinite(capture.lng))
        return { lat: capture.lat, lng: capture.lng, source: "frozen_capture_gps" };
    if (Number.isFinite(report.lat) && Number.isFinite(report.lng))
        return { lat: report.lat, lng: report.lng, source: "legacy_report_coordinates" };
    return undefined;
}
function eventTime(report) {
    const captureTime = report.captureEvidence?.photoCapturedAt;
    return captureTime && Number.isFinite(Date.parse(captureTime)) ? { value: captureTime, source: "photo_capture_time" } : { value: report.createdAt, source: "report_created_time" };
}
function assessment(suitability, reason, no2) {
    const observable = no2 !== undefined;
    return {
        result: observable ? "inconclusive" : "not_observable", confidence: 0, source: "deterministic",
        observability: observable ? "partially_observable" : "not_observable", eventSuitability: suitability.suitability,
        citizenPhotoSignals: [], satelliteSignals: observable ? [`Earth Engine returned a local Sentinel-5P NO₂ mean of ${no2.toExponential(2)} mol/m².`] : [],
        surfaceChangeSignals: [], contradictorySignals: [], temporalConsistency: "weak", spatialContext: "unclear", explanation: reason,
        limitations: ["Earth Engine satellite context is regional atmospheric context, not proof of the citizen incident.", "Sentinel-5P resolution and overpass timing cannot verify a small street-level event.", "The citizen photo remains the primary evidence."]
    };
}
function baseEvidence(input) {
    const suitability = classifySatelliteEventSuitability(input.report.gemini?.pollution_type || "unclear");
    const event = eventTime(input.report);
    const contextAssessment = assessment(suitability, input.reason, input.no2);
    return {
        provider: "earth_engine", status: input.status,
        reportLocation: { lat: input.location.lat, lng: input.location.lng, source: input.location.source, aoiRadiusMeters: earthEngineRadiusMeters() },
        eventTime: { photoCapturedAt: event.value, source: event.source }, eventSuitability: { level: suitability.suitability, reason: suitability.reason },
        observability: { status: input.no2 === undefined ? "provider_unavailable" : "partially_observable", score: input.no2 === undefined ? 0 : 50, reasons: [input.reason] },
        assessment: contextAssessment, evidenceContributionPoints: 0, decisionEffect: "none",
        attribution: "Contains modified Copernicus Sentinel-5P data processed with Google Earth Engine.",
        warnings: ["Satellite context is supporting environmental context only; it does not change evidence trust."], checkedAt: new Date().toISOString(), scenes: {}, products: {},
        metrics: input.no2 === undefined ? [] : [{ name: "aerosol_optical_thickness", value: input.no2, unit: "mol/m²", interpretation: "Sentinel-5P tropospheric NO₂ mean over the bounded local area." }],
        explanation: input.reason, limitations: contextAssessment.limitations, error: input.error
    };
}
export function buildPendingSatelliteEvidence(report) {
    const location = reportLocation(report);
    return location ? { ...baseEvidence({ report, location, status: "pending", reason: "Google Earth Engine satellite context is queued." }), requestedAt: new Date().toISOString() } : undefined;
}
export async function verifyReportWithSatellite(reportId) {
    const report = await findReport(reportId);
    if (!report)
        return { success: false, retryable: false };
    return verifyReportObjectWithSatellite(report, { persist: true });
}
export async function verifyReportObjectWithSatellite(report, options = {}) {
    const location = reportLocation(report);
    if (!location)
        return { success: false, report, retryable: false };
    const persist = options.persist ?? true;
    const save = async (evidence) => { if (persist)
        await updateReport(report.id, { satelliteEvidence: evidence }); return evidence; };
    await save({ ...baseEvidence({ report, location, status: "processing", reason: "Google Earth Engine satellite context is processing." }), requestedAt: new Date().toISOString() });
    const readiness = getEarthEngineReadiness();
    if (!readiness.configured) {
        const evidence = await save(baseEvidence({ report, location, status: "unavailable", reason: "Google Earth Engine satellite context is not configured.", error: { code: readiness.errorCode, message: "Google Earth Engine satellite context is not configured.", retryable: false } }));
        return { success: true, report: { ...report, satelliteEvidence: evidence }, evidence, retryable: false };
    }
    try {
        const no2 = await getEarthEngineNo2Context(location.lat, location.lng);
        const evidence = await save({ ...baseEvidence({ report, location, status: "ready", reason: "Google Earth Engine returned local Sentinel-5P atmospheric context.", no2: no2.meanNo2 }), completedAt: new Date().toISOString() });
        return { success: true, report: { ...report, satelliteEvidence: evidence }, evidence, retryable: false };
    }
    catch (error) {
        const providerError = error instanceof EarthEngineProviderError ? error : undefined;
        const message = error instanceof Error ? error.message : "Google Earth Engine satellite context failed.";
        const evidence = await save(baseEvidence({ report, location, status: providerError && !providerError.retryable ? "unavailable" : "failed", reason: message, error: { code: providerError?.code || "EARTH_ENGINE_PROCESSING_FAILED", message, retryable: providerError?.retryable ?? true } }));
        return { success: false, report: { ...report, satelliteEvidence: evidence }, evidence, retryable: providerError?.retryable ?? true };
    }
}
export function satelliteContributionPoints() { return 0; }
