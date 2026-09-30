import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
console.info("[ReportStore] Using local JSON storage.");
const defaultGemini = {
    is_pollution_related: true,
    pollution_visible: false,
    image_quality: "usable",
    image_quality_score: 50,
    pollution_type: "unclear",
    confidence: 50,
    severity: "medium",
    evidence_strength: 35,
    visible_evidence: ["submitted report"],
    rejection_reason: undefined,
    possible_pollutants: ["PM2.5", "PM10"],
    public_summary: "The report is queued for analysis.",
    municipal_action: "Verify manually if AI analysis is unavailable.",
    needs_manual_review: true,
    trust_decision: "needs_review",
    safety_note: "Do not go near fire or heavy smoke."
};
const defaultAir = {
    provider: "unavailable",
    category: "AQI unavailable, pollutant readings pending",
    pollutants: {},
    rawSummary: "Air quality will be attached after provider lookup."
};
const reports = new Map();
function localReportFile() {
    return path.join(process.cwd(), "storage", "reports.json");
}
async function readLocalReports() {
    try {
        return JSON.parse(await readFile(localReportFile(), "utf8"));
    }
    catch {
        return [];
    }
}
async function writeLocalReports(next) {
    await mkdir(path.dirname(localReportFile()), { recursive: true });
    await writeFile(localReportFile(), JSON.stringify(next, null, 2), "utf8");
}
function sortedMemoryReports() {
    return Array.from(reports.values()).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}
function mergeReports(primary, fallback) {
    const merged = new Map();
    for (const report of fallback) {
        merged.set(report.id, report);
    }
    for (const report of primary) {
        merged.set(report.id, report);
    }
    return Array.from(merged.values()).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}
export async function listReports() {
    return mergeReports(await readLocalReports(), sortedMemoryReports());
}
export async function findReport(id) {
    return (await readLocalReports()).find((report) => report.id === id) || reports.get(id);
}
export async function listReportsByUser(userId) {
    const all = await listReports();
    return all.filter((r) => r.userId === userId);
}
export async function createReport(input) {
    const id = input.id || `CLS-${Math.random().toString(36).slice(2, 6).toUpperCase()}-${Date.now()
        .toString()
        .slice(-4)}`;
    const now = new Date().toISOString();
    const report = {
        id,
        createdAt: now,
        updatedAt: now,
        userId: input.userId,
        status: input.gemini ? "Submitted" : "Analyzing",
        lat: input.lat,
        lng: input.lng,
        areaText: input.areaText,
        media: input.media || [],
        primaryMediaId: input.primaryMediaId,
        evidenceStatus: input.evidenceStatus || "stored",
        authenticityScore: input.authenticityScore ?? 0,
        authenticityFlags: input.authenticityFlags || [],
        evidenceScore: input.evidenceScore ?? 0,
        trustLevel: input.trustLevel || "Needs Review",
        rejectionReason: input.rejectionReason,
        scoreBreakdown: input.scoreBreakdown,
        evidenceReasons: input.evidenceReasons || [],
        locality: input.locality,
        actionLog: [
            { type: "report_created", at: now },
            ...(input.media?.length ? [{ type: "media_uploaded", at: now }] : []),
            ...(input.gemini ? [{ type: "gemini_verified", at: now }] : []),
            ...(input.evidenceScore !== undefined ? [{ type: "evidence_scored", at: now }] : [])
        ],
        imageUrl: input.imageUrl,
        imageHash: input.imageHash,
        userDescription: input.userDescription,
        gemini: input.gemini || defaultGemini,
        airQuality: input.airQuality || defaultAir,
        forecast: input.forecast,
        cpcbContext: input.cpcbContext,
        surroundingContext: input.surroundingContext,
        captureEvidence: input.captureEvidence,
        corroboratesReportId: input.corroboratesReportId,
        nearby: { similarReportCount: 0, nearbyReportIds: [] },
        hotspotScore: 0,
        priority: "watch",
        reportSource: input.reportSource,
        droneInfo: input.droneInfo
    };
    const stored = await readLocalReports();
    await writeLocalReports([...stored.filter((item) => item.id !== report.id), report]);
    reports.set(report.id, report);
    return report;
}
export async function updateReport(id, patch) {
    const stored = await readLocalReports();
    const existing = stored.find((report) => report.id === id) || reports.get(id);
    if (!existing) {
        console.warn(`[ReportStore] updateReport could not find report ${id}.`);
        return undefined;
    }
    const next = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    await writeLocalReports([...stored.filter((report) => report.id !== id), next]);
    reports.set(id, next);
    return next;
}
export async function updateStatus(id, status) {
    const existing = await findReport(id);
    const now = new Date().toISOString();
    const patch = {
        status,
        priority: status === "Resolved" ? "resolved" : undefined,
        resolvedAt: status === "Resolved" ? now : undefined,
        actionLog: [
            ...(existing?.actionLog || []),
            { type: status === "Resolved" ? "resolved" : "status_changed", at: now, note: status }
        ]
    };
    return updateReport(id, patch);
}
