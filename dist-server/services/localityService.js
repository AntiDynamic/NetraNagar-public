import { distanceMeters } from "../utils/geo.js";
function gridId(lat, lng, meters = 250) {
    const latStep = meters / 111_320;
    const lngStep = meters / (111_320 * Math.max(0.25, Math.cos((lat * Math.PI) / 180)));
    const latCell = Math.round(lat / latStep);
    const lngCell = Math.round(lng / lngStep);
    return `${meters}m:${latCell}:${lngCell}`;
}
function localityMode(areaText) {
    const lower = areaText.toLowerCase();
    if (lower.includes("ajmera") || lower.includes("pimpri"))
        return "Ajmera Road, Pimpri, Pune";
    if (lower.includes("delhi"))
        return "Delhi station/locality";
    return areaText || "Local hotspot";
}
export function buildLocalitySummary(report, allReports) {
    const related = allReports
        .filter((candidate) => candidate.id !== report.id)
        .map((candidate) => ({
        report: candidate,
        distance: distanceMeters(report.lat, report.lng, candidate.lat, candidate.lng)
    }))
        .filter((candidate) => candidate.distance <= 500);
    return {
        locality_id: gridId(report.lat, report.lng, 250),
        locality_name: localityMode(report.areaText),
        nearby_150m_count: related.filter((item) => item.distance <= 150).length,
        nearby_250m_count: related.filter((item) => item.distance <= 250).length,
        nearby_500m_count: related.length,
        relatedReportIds: related.slice(0, 12).map((item) => item.report.id),
        relatedMedia: related.flatMap((item) => item.report.media || []).slice(0, 24)
    };
}
