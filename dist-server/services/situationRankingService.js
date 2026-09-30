import { distanceMeters } from "../utils/geo.js";
// ─── Active statuses that count toward situation ranking ──────────────────────
const ACTIVE_STATUSES = new Set([
    "Submitted",
    "New",
    "Assigned",
    "In Progress",
    "Manual review needed"
]);
// ─── Scoring tables ───────────────────────────────────────────────────────────
function reportVolumeScore(count) {
    if (count >= 6)
        return 100;
    if (count >= 4)
        return 80;
    if (count === 3)
        return 65;
    if (count === 2)
        return 45;
    return 25;
}
const BASE_PUBLIC_IMPACT = {
    garbage_burning: 90,
    industrial_smoke: 90,
    sewage_overflow: 85,
    water_pollution: 80,
    stagnant_water: 75,
    vehicle_smoke: 75,
    construction_dust: 70,
    road_dust: 65,
    open_waste: 65,
    illegal_dumping: 65,
    unclear: 40,
    not_pollution: 0
};
const SEVERITY_MULTIPLIER = {
    low: 0.5,
    medium: 0.7,
    high: 0.9,
    severe: 1.0
};
function publicImpactScore(type, severity) {
    return (BASE_PUBLIC_IMPACT[type] ?? 40) * (SEVERITY_MULTIPLIER[severity] ?? 0.7);
}
function evidenceScoreForCluster(reports) {
    const scores = reports.map((r) => r.evidenceScore ?? 50);
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    const max = Math.max(...scores);
    return 0.7 * avg + 0.3 * max;
}
function recencyScore(latestAt) {
    const ageHours = (Date.now() - new Date(latestAt).getTime()) / (1000 * 60 * 60);
    if (ageHours < 1)
        return 100;
    if (ageHours < 6)
        return 85;
    if (ageHours < 24)
        return 70;
    if (ageHours < 168)
        return 45;
    return 20;
}
function unresolvedScore(unresolvedCount, total) {
    if (total === 0)
        return 0;
    return (unresolvedCount / total) * 100;
}
function hotspotScoreForCluster(reports) {
    if (!reports.length)
        return 0;
    return reports.reduce((sum, r) => sum + (r.hotspotScore ?? 0), 0) / reports.length;
}
function aqiSupportScore(reports) {
    const aqis = reports
        .map((r) => r.airQuality?.aqi)
        .filter((a) => typeof a === "number");
    if (!aqis.length)
        return 0;
    const maxAqi = Math.max(...aqis);
    if (maxAqi >= 300)
        return 100;
    if (maxAqi >= 200)
        return 75;
    if (maxAqi >= 100)
        return 50;
    return 25;
}
function computeSituationScore(breakdown) {
    return (0.25 * breakdown.reportVolumeScore +
        0.20 * breakdown.publicImpactScore +
        0.20 * breakdown.evidenceScore +
        0.15 * breakdown.recencyScore +
        0.10 * breakdown.unresolvedScore +
        0.07 * breakdown.hotspotScore +
        0.03 * breakdown.aqiSupportScore);
}
function priorityFromScore(score) {
    if (score >= 80)
        return "critical";
    if (score >= 65)
        return "high";
    if (score >= 45)
        return "moderate";
    return "low";
}
// ─── Dominant type / severity ─────────────────────────────────────────────────
function dominantType(reports) {
    const counts = new Map();
    for (const r of reports) {
        const t = r.gemini.pollution_type;
        counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unclear";
}
function dominantSeverity(reports) {
    const order = ["severe", "high", "medium", "low"];
    for (const s of order) {
        if (reports.some((r) => r.gemini.severity === s))
            return s;
    }
    return "low";
}
function cleanReportAreaText(report) {
    const text = report.areaText?.trim();
    if (text &&
        !/^default map center$/i.test(text) &&
        !/^location not set$/i.test(text)) {
        return text;
    }
    if (Number.isFinite(report.lat) && Number.isFinite(report.lng)) {
        return `${report.lat.toFixed(4)}, ${report.lng.toFixed(4)}`;
    }
    return "Location needs confirmation";
}
// ─── Place label ──────────────────────────────────────────────────────────────
function placeLabel(reports) {
    const counts = new Map();
    for (const r of reports) {
        const t = cleanReportAreaText(r);
        if (t)
            counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    if (counts.size > 0) {
        return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    }
    return "Location needs confirmation";
}
// ─── Short description generator ─────────────────────────────────────────────
function shortDescription(reports, type, place, recencyH) {
    const n = reports.length;
    const typeLabel = type.replace(/_/g, " ");
    if (recencyH < 24) {
        return `${n} ${typeLabel} report${n > 1 ? "s" : ""} near ${place} in the last ${recencyH < 1 ? "hour" : Math.round(recencyH) + " hours"}.`;
    }
    if (n >= 3) {
        return `Repeated ${typeLabel} reports detected within 250m of ${place}.`;
    }
    return `${n} ${typeLabel} report${n > 1 ? "s" : ""} filed near ${place} with supporting evidence.`;
}
// ─── Effects and recommended actions ─────────────────────────────────────────
const EFFECTS_MAP = {
    garbage_burning: ["Smoke exposure possible", "Eye/throat irritation risk for nearby people"],
    industrial_smoke: ["Industrial air emission exposure possible", "Prolonged exposure may cause respiratory discomfort"],
    road_dust: ["Dust exposure possible", "Visibility and breathing discomfort may increase"],
    construction_dust: ["Construction dust exposure possible", "Nearby roads may accumulate fine dust"],
    sewage_overflow: ["Sanitation concern", "Bad odor and contamination exposure possible"],
    stagnant_water: ["Mosquito breeding risk possible", "Bad odor or contamination exposure possible"],
    open_waste: ["Waste accumulation hotspot", "Odor or pest issue possible"],
    illegal_dumping: ["Waste accumulation hotspot", "Odor or pest issue possible"],
    vehicle_smoke: ["Vehicle emission exposure possible"],
    water_pollution: ["Water source contamination possible", "Aquatic environment impact possible"],
    unclear: ["Pollution type unclear — needs field verification"],
    not_pollution: []
};
const ACTIONS_MAP = {
    garbage_burning: ["Stop active burning", "Clear waste pile", "Increase waste collection frequency"],
    industrial_smoke: ["Inspect industrial site", "Verify emission compliance", "Notify environment department"],
    road_dust: ["Street sweeping", "Water sprinkling", "Remove loose debris"],
    construction_dust: ["Inspect site", "Cover construction material", "Use dust barriers and water sprinkling"],
    sewage_overflow: ["Inspect drainage", "Clear blockage", "Disinfect and clean affected stretch"],
    stagnant_water: ["Drain stagnant water", "Clear blockage", "Clean and disinfect area"],
    open_waste: ["Clear waste", "Add collection point or bin", "Monitor repeated dumping"],
    illegal_dumping: ["Clear waste", "Add collection point or bin", "Monitor repeated dumping"],
    vehicle_smoke: ["Check high-smoke vehicle zone", "Reduce idling", "Traffic enforcement check"],
    water_pollution: ["Sample water source", "Identify discharge point", "Notify water authority"],
    unclear: ["Dispatch field officer for on-site assessment"],
    not_pollution: []
};
// ─── Status summary ───────────────────────────────────────────────────────────
function statusSummary(reports, unresolved) {
    const total = reports.length;
    if (unresolved === 0)
        return "All reports resolved.";
    if (unresolved === total)
        return `${total} unresolved report${total > 1 ? "s" : ""} — pending officer action.`;
    return `${unresolved} of ${total} reports still unresolved.`;
}
// ─── Clustering (greedy 150m) ─────────────────────────────────────────────────
function clusterReports(activeReports, radiusMeters = 150) {
    const sorted = [...activeReports].sort((a, b) => {
        const scoreDiff = (b.hotspotScore ?? 0) - (a.hotspotScore ?? 0);
        if (scoreDiff !== 0)
            return scoreDiff;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
    const visited = new Set();
    const clusters = [];
    for (const seed of sorted) {
        if (visited.has(seed.id))
            continue;
        visited.add(seed.id);
        const cluster = [seed];
        for (const candidate of sorted) {
            if (visited.has(candidate.id))
                continue;
            if (distanceMeters(seed.lat, seed.lng, candidate.lat, candidate.lng) <= radiusMeters) {
                visited.add(candidate.id);
                cluster.push(candidate);
            }
        }
        clusters.push(cluster);
    }
    return clusters;
}
// ─── Build one situation from a cluster ───────────────────────────────────────
function buildSituation(cluster, id) {
    const centerLat = cluster.reduce((s, r) => s + r.lat, 0) / cluster.length;
    const centerLng = cluster.reduce((s, r) => s + r.lng, 0) / cluster.length;
    const type = dominantType(cluster);
    const severity = dominantSeverity(cluster);
    const place = placeLabel(cluster);
    const sorted = [...cluster].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const latestAt = sorted[0].createdAt;
    const firstAt = sorted[sorted.length - 1].createdAt;
    const unresolved = cluster.filter((r) => r.status !== "Resolved" && r.status !== "Rejected" && r.status !== "False Report");
    const ageHours = (Date.now() - new Date(latestAt).getTime()) / (1000 * 60 * 60);
    const photoUrls = sorted
        .map((r) => r.media?.[0]?.displayUrl || r.media?.[0]?.publicUrl || r.imageUrl || "")
        .filter((u) => Boolean(u))
        .slice(0, 4);
    const breakdown = {
        reportVolumeScore: reportVolumeScore(cluster.length),
        publicImpactScore: Math.round(publicImpactScore(type, severity)),
        evidenceScore: Math.round(evidenceScoreForCluster(cluster)),
        recencyScore: recencyScore(latestAt),
        unresolvedScore: Math.round(unresolvedScore(unresolved.length, cluster.length)),
        hotspotScore: Math.round(hotspotScoreForCluster(cluster)),
        aqiSupportScore: aqiSupportScore(cluster)
    };
    let score = Math.round(computeSituationScore(breakdown));
    score = Math.min(100, Math.max(0, score));
    return {
        id,
        rank: 0, // assigned later
        priority: priorityFromScore(score),
        situationScore: score,
        centerLat,
        centerLng,
        radiusMeters: 150,
        placeLabel: place,
        shortDescription: shortDescription(cluster, type, place, ageHours),
        reportCount: cluster.length,
        activeReportCount: unresolved.length,
        unresolvedCount: unresolved.length,
        dominantPollutionType: type,
        dominantSeverity: severity,
        latestReportAt: latestAt,
        firstReportAt: firstAt,
        reportIds: cluster.map((r) => r.id),
        photoUrls,
        scoreBreakdown: breakdown,
        effects: EFFECTS_MAP[type] ?? [],
        recommendedActions: ACTIONS_MAP[type] ?? [],
        statusSummary: statusSummary(cluster, unresolved.length)
    };
}
// ─── Public API ───────────────────────────────────────────────────────────────
export function buildRankedSituations(reports) {
    const active = reports.filter((r) => ACTIVE_STATUSES.has(r.status));
    const clusters = clusterReports(active);
    const situations = clusters.map((cluster, i) => buildSituation(cluster, `SIT-${String(i + 1).padStart(3, "0")}`));
    situations.sort((a, b) => {
        const scoreDiff = b.situationScore - a.situationScore;
        if (scoreDiff !== 0)
            return scoreDiff;
        const countDiff = b.activeReportCount - a.activeReportCount;
        if (countDiff !== 0)
            return countDiff;
        return new Date(b.latestReportAt).getTime() - new Date(a.latestReportAt).getTime();
    });
    situations.forEach((s, i) => {
        s.rank = i + 1;
    });
    return situations;
}
