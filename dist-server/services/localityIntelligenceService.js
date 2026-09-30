import { distanceMeters } from "../utils/geo.js";
const activeStatuses = new Set(["Submitted", "New", "Assigned", "In Progress", "Manual review needed"]);
export function buildLocalityIntelligence(input) {
    const nearby = input.reports
        .map((report) => ({ report, distance: distanceMeters(input.lat, input.lng, report.lat, report.lng) }))
        .filter((item) => item.distance <= 500)
        .filter((item) => input.historical || !["Resolved", "Rejected", "False Report"].includes(item.report.status));
    const active = nearby.filter((item) => activeStatuses.has(item.report.status));
    const dominant = active.reduce((acc, item) => {
        const type = item.report.gemini.pollution_type;
        acc[type] = (acc[type] || 0) + 1;
        return acc;
    }, {});
    const dominantPollutionType = Object.entries(dominant).sort((a, b) => b[1] - a[1])[0]?.[0];
    const averageEvidenceScore = Math.round(nearby.reduce((sum, item) => sum + item.report.evidenceScore, 0) / Math.max(1, nearby.length));
    const maxHotspotScore = Math.max(0, ...nearby.map((item) => item.report.hotspotScore || 0));
    const readable = dominantPollutionType?.replace(/_/g, " ") || "pollution";
    return {
        lat: input.lat,
        lng: input.lng,
        radiusMeters: 500,
        reportCount: nearby.length,
        activeReportCount: active.length,
        activeHotspotCount: active.filter((item) => item.report.hotspotScore >= 58).length,
        averageEvidenceScore,
        maxHotspotScore,
        dominantPollutionType,
        nearby_150m_count: active.filter((item) => item.distance <= 150).length,
        nearby_250m_count: active.filter((item) => item.distance <= 250).length,
        nearby_500m_count: active.length,
        recentReports: active
            .map((item) => item.report)
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
            .slice(0, 8),
        recommendation: active.length
            ? `Repeated ${readable} reports found within 500m. Prioritize local inspection and source reduction.`
            : "No active citizen hotspot reports within 500m. Continue monitoring this locality."
    };
}
