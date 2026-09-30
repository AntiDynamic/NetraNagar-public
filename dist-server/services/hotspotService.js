import { distanceMeters } from "../utils/geo.js";
export function findNearbyReports(report, reports) {
    const nearby = reports.filter((candidate) => candidate.id !== report.id &&
        Date.now() - new Date(candidate.createdAt).getTime() < 24 * 60 * 60 * 1000 &&
        distanceMeters(report.lat, report.lng, candidate.lat, candidate.lng) <= 500);
    return {
        similarReportCount: nearby.length,
        nearbyReportIds: nearby.slice(0, 8).map((item) => item.id),
        independentNearbyReporterCount: new Set(nearby.filter((item) => item.userId !== report.userId && item.reportSource !== "drone").map((item) => item.userId)).size,
        verifiedCorroborationCount: new Set(reports.filter((candidate) => candidate.corroboratesReportId === report.id && candidate.evidenceStatus === "verified" && candidate.trustLevel !== "Rejected" && candidate.reportSource !== "drone" && candidate.userId !== report.userId).map((candidate) => candidate.userId)).size
    };
}
export function calculateHotspotScore(severity, nearbyCount, airQuality, evidenceScore = 50, forecast, cpcbContext, pollutionType, surroundingContext, independentNearbyReporterCount, verifiedCorroborationCount = 0) {
    const pollutionSeverityScore = { low: 25, medium: 50, high: 78, severe: 100 }[severity];
    const nearbyEvidenceDensityScore = Math.min(100, (independentNearbyReporterCount ?? nearbyCount) * 35);
    const verifiedCorroborationScore = Math.min(100, verifiedCorroborationCount * 50);
    const currentAqiSeverityScore = airQuality.aqi !== undefined && airQuality.aqi !== null
        ? aqiSeverityScore(airQuality.aqi)
        : Object.keys(airQuality.pollutants || {}).length > 0
            ? 58
            : (airQuality.category || "").toLowerCase().includes("unavailable")
                ? 35
                : 58;
    const forecastSpikeScore = forecastScore(forecast?.spikeRisk);
    const cpcbSupport = cpcbSupportScore(cpcbContext, pollutionType) * (100 / 15);
    const environmentalSeverity = currentAqiSeverityScore * .6 + pollutionSeverityScore * .4;
    // Weights: evidence 25, environmental severity 20, forecast 15, nearby
    // independent evidence 5, explicit verified corroboration 10, sensor support
    // 5, and community exposure 20. Nearby evidence is not corroboration.
    // If surroundings are unavailable, known dimensions are renormalized rather
    // than treating unavailable context as zero risk.
    const dimensions = [
        { weight: 25, value: evidenceScore }, { weight: 20, value: environmentalSeverity },
        { weight: 15, value: forecastSpikeScore }, { weight: 5, value: nearbyEvidenceDensityScore }, { weight: 10, value: verifiedCorroborationScore }, { weight: 5, value: cpcbSupport },
        ...(surroundingContext && surroundingContext.status !== "unavailable" ? [{ weight: 20, value: surroundingContext.communityExposureScore }] : [])
    ];
    const totalWeight = dimensions.reduce((sum, item) => sum + item.weight, 0);
    return Math.min(100, Math.round(dimensions.reduce((sum, item) => sum + item.weight * item.value, 0) / totalWeight));
}
function aqiSeverityScore(aqi) {
    if (aqi <= 50)
        return 15;
    if (aqi <= 100)
        return 30;
    if (aqi <= 200)
        return 55;
    if (aqi <= 300)
        return 75;
    if (aqi <= 400)
        return 90;
    return 100;
}
function forecastScore(risk) {
    if (risk === "severe")
        return 100;
    if (risk === "high")
        return 100;
    if (risk === "medium")
        return 65;
    if (risk === "low")
        return 30;
    return 40;
}
function pollutantSeverity(value) {
    if (!Number.isFinite(value))
        return 0;
    if (value >= 250)
        return 100;
    if (value >= 150)
        return 75;
    if (value >= 90)
        return 55;
    if (value >= 50)
        return 35;
    return 15;
}
function cpcbSupportScore(context, pollutionType) {
    if (!context || !pollutionType)
        return 0;
    const pollutantGroups = {
        garbage_burning: ["PM2.5", "PM10", "SO2"],
        open_waste: ["PM2.5", "PM10", "SO2"],
        industrial_smoke: ["PM2.5", "PM10", "SO2", "NO2"],
        construction_dust: ["PM10", "PM2.5"],
        road_dust: ["PM10", "PM2.5"],
        vehicle_smoke: ["NO2", "CO", "PM2.5"]
    };
    const values = (pollutantGroups[pollutionType] || []).map((pollutant) => context.pollutants[pollutant]?.idwEstimate);
    const support = Math.max(0, ...values.map((value) => pollutantSeverity(value)));
    return Math.min(15, support * 0.15);
}
export function priorityForHotspotScore(hotspotScore, trustLevel) {
    if (trustLevel === "Rejected" || trustLevel === "Needs Review")
        return "watch";
    return hotspotScore > 78 ? "severe" : hotspotScore > 58 ? "high" : "watch";
}
