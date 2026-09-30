import { distanceMeters } from "../utils/geo.js";
const EXPIRY_MS = 6 * 60 * 60 * 1000;
const DEFAULT_DISCOVERY_RADIUS_METERS = 1500;
const ACTIVE_STATUSES = new Set(["Submitted", "New", "Assigned", "Accepted", "In Progress", "Cleanup In Progress", "Manual review needed"]);
export function isDemoReport(report) { return report.id.startsWith("demo-") || report.id.startsWith("browser-demo-"); }
export function missionExpiry(report) { return new Date(new Date(report.createdAt).getTime() + EXPIRY_MS).toISOString(); }
export function missionDiscoveryRadiusMeters() { return DEFAULT_DISCOVERY_RADIUS_METERS; }
export function corroborationCaptureRadiusMeters() { const configured = Number(process.env.CORROBORATION_CAPTURE_RADIUS_METERS || 500); return Number.isFinite(configured) ? Math.max(100, Math.min(1000, configured)) : 500; }
export function isEligibleForCorroboration(report, now = Date.now()) {
    return report.reportSource !== "drone" && !isDemoReport(report) && ACTIVE_STATUSES.has(report.status) && report.evidenceStatus !== "rejected" && report.trustLevel !== "Rejected" && now < new Date(report.createdAt).getTime() + EXPIRY_MS && (report.corroboratedByReportIds?.length || 0) < 3;
}
export function independentConfirmationCount(target, reports) {
    return reports.filter((report) => report.corroboratesReportId === target.id && report.reportSource !== "drone" && report.evidenceStatus === "verified" && report.trustLevel !== "Rejected" && report.userId !== target.userId).reduce((users, report) => users.add(report.userId), new Set()).size;
}
export function listCorroborationMissions(reports, input) {
    const now = Date.now();
    return reports.filter((report) => isEligibleForCorroboration(report, now) && report.userId !== input.userId && distanceMeters(input.lat, input.lng, report.lat, report.lng) <= input.radiusMeters)
        .map((report) => ({
        id: `corroborate-${report.id}`, targetReportId: report.id, status: "open", createdAt: report.createdAt, expiresAt: missionExpiry(report), lat: report.lat, lng: report.lng,
        areaText: report.areaText, pollutionType: report.gemini.pollution_type, severity: report.gemini.severity, priority: report.priority,
        distanceFromUserMeters: Math.round(distanceMeters(input.lat, input.lng, report.lat, report.lng)), existingIndependentConfirmations: independentConfirmationCount(report, reports),
        reason: "Community verification needed: independent, recent evidence can improve situation confidence. If you are already nearby and it is safe, confirm whether it is still active."
    })).filter((mission) => mission.existingIndependentConfirmations < 3).sort((a, b) => (a.distanceFromUserMeters || 0) - (b.distanceFromUserMeters || 0));
}
