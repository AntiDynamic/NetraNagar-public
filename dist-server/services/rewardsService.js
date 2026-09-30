import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { distanceMeters } from "../utils/geo.js";
// Local development uses a JSON store rather than a database transaction. Serialize
// awards so two Officer approval requests cannot both create a transaction for one report.
let awardQueue = Promise.resolve();
const DEMO_LEADERBOARD = [
    { displayName: "Asha P.", locality: "Pune", totalPoints: 680, resolvedReports: 5, validReports: 7, rank: 1, badges: ["Clean City Champion"], isDemo: true },
    { displayName: "Rahul K.", locality: "Pimpri", totalPoints: 430, resolvedReports: 3, validReports: 4, rank: 2, badges: ["Locality Contributor"], isDemo: true },
    { displayName: "Meera S.", locality: "Pune", totalPoints: 275, resolvedReports: 2, validReports: 3, rank: 3, badges: ["First Resolved Cleanup"], isDemo: true }
];
function rewardsFile() { return process.env.REWARDS_FILE || path.join(process.cwd(), "storage", "rewards.json"); }
async function readStore() {
    try {
        return JSON.parse(await readFile(rewardsFile(), "utf8"));
    }
    catch {
        return { profiles: [], transactions: [] };
    }
}
async function writeStore(store) {
    await mkdir(path.dirname(rewardsFile()), { recursive: true });
    await writeFile(rewardsFile(), JSON.stringify(store, null, 2), "utf8");
}
function isDemoReport(report) {
    return report.id.startsWith("demo-") || Boolean(report.isDemo);
}
function localityFor(report) {
    const locality = report.locality?.locality_name || report.areaText || "Locality not shared";
    return locality.split(",").slice(-2).join(",").trim().slice(0, 80) || "Locality not shared";
}
function nameFor(userId) { return `Citizen ${userId.slice(-4).toUpperCase()}`; }
function badgesFor(profile) {
    const badges = [];
    if (profile.validReports >= 1)
        badges.push("First Report");
    if (profile.resolvedReports >= 1)
        badges.push("First Resolved Cleanup");
    if (profile.resolvedReports >= 5)
        badges.push("5 Resolved Reports", "Clean City Champion");
    if (profile.resolvedReports >= 2)
        badges.push("Locality Contributor");
    return badges;
}
function ranked(profiles) {
    return [...profiles].sort((a, b) => b.totalPoints - a.totalPoints || b.resolvedReports - a.resolvedReports || a.displayName.localeCompare(b.displayName)).map((profile, index) => ({ ...profile, rank: index + 1 }));
}
export async function awardResolutionPoints(report, reports, priorityBeforeResolution = report.priority) {
    let result = null;
    const next = awardQueue.then(async () => { result = await awardResolutionPointsInternal(report, reports, priorityBeforeResolution); });
    awardQueue = next.catch(() => undefined);
    await next;
    return result;
}
async function awardResolutionPointsInternal(report, reports, priorityBeforeResolution) {
    if (isDemoReport(report) || report.status !== "Resolved" || report.evidenceStatus !== "verified" || report.trustLevel === "Rejected")
        return null;
    const store = await readStore();
    if (report.rewards?.resolutionImpact || report.reward || store.transactions.some((transaction) => transaction.reportId === report.id && (transaction.type || "resolution_impact") === "resolution_impact"))
        return null;
    const createdAt = new Date(report.createdAt).getTime();
    const sameUserRepeat = reports.some((other) => other.id !== report.id && other.userId === report.userId && Math.abs(createdAt - new Date(other.createdAt).getTime()) < 86_400_000 && distanceMeters(report.lat, report.lng, other.lat, other.lng) <= 100);
    if (sameUserRepeat)
        return null;
    const nearby = reports.filter((other) => other.id !== report.id && distanceMeters(report.lat, report.lng, other.lat, other.lng) <= 500);
    const newHotspot = nearby.length === 0;
    const corroborated = nearby.some((other) => other.userId !== report.userId);
    const recurring = report.nearby.similarReportCount > 0 || nearby.length > 0;
    const highPriority = priorityBeforeResolution === "high" || priorityBeforeResolution === "severe" || report.hotspotScore >= 70;
    const parts = [
        ...(newHotspot ? ["First valid report at a new hotspot: 50"] : []),
        "Cleanup successfully resolved: 100",
        ...(highPriority ? ["High-priority hotspot resolved: 30"] : []),
        ...(corroborated ? ["Another citizen confirmed the hotspot: 20"] : []),
        ...(recurring && !newHotspot ? ["Valid recurring hotspot report: 25"] : [])
    ];
    const points = parts.reduce((sum, part) => sum + Number(part.match(/(\d+)$/)?.[1] || 0), 0);
    if (!points)
        return null;
    const now = new Date().toISOString();
    const transaction = { transactionId: `RWD-resolution-${report.id}-${Date.now()}`, userId: report.userId, reportId: report.id, points, reason: parts.join("; "), createdAt: now, type: "resolution_impact" };
    const existing = store.profiles.find((profile) => profile.userId === report.userId);
    const validReports = reports.filter((item) => item.userId === report.userId && item.evidenceStatus === "verified" && !isDemoReport(item)).length;
    const resolvedReports = reports.filter((item) => item.userId === report.userId && item.status === "Resolved" && !isDemoReport(item)).length;
    const profile = {
        userId: report.userId, displayName: existing?.displayName || nameFor(report.userId), locality: localityFor(report),
        totalPoints: (existing?.totalPoints || 0) + points, resolvedReports, validReports, rank: 0,
        badges: [], lastPointsAwardedAt: now
    };
    profile.badges = badgesFor(profile);
    store.profiles = ranked([...store.profiles.filter((item) => item.userId !== report.userId), profile]);
    store.transactions.push(transaction);
    await writeStore(store);
    return { transaction, profile: store.profiles.find((item) => item.userId === report.userId) };
}
export async function awardVerifiedContributionPoints(report, reports) {
    let result = null;
    const next = awardQueue.then(async () => {
        if (isDemoReport(report) || report.reportSource === "drone" || report.evidenceStatus !== "verified" || report.trustLevel === "Rejected")
            return;
        const store = await readStore();
        if (report.rewards?.verifiedContribution || store.transactions.some((transaction) => transaction.reportId === report.id && transaction.type === "verified_contribution"))
            return;
        const createdAt = new Date(report.createdAt).getTime();
        const repeat = reports.some((other) => other.id !== report.id && other.userId === report.userId && Math.abs(createdAt - new Date(other.createdAt).getTime()) < 86_400_000 && distanceMeters(report.lat, report.lng, other.lat, other.lng) <= 100);
        if (repeat)
            return;
        const now = new Date().toISOString();
        const transaction = { transactionId: `RWD-verified-${report.id}-${Date.now()}`, userId: report.userId, reportId: report.id, points: 10, reason: "Verified civic contribution", createdAt: now, type: "verified_contribution" };
        const existing = store.profiles.find((profile) => profile.userId === report.userId);
        const validReports = reports.filter((item) => item.userId === report.userId && item.evidenceStatus === "verified" && !isDemoReport(item)).length;
        const resolvedReports = reports.filter((item) => item.userId === report.userId && item.status === "Resolved" && !isDemoReport(item)).length;
        const profile = { userId: report.userId, displayName: existing?.displayName || nameFor(report.userId), locality: localityFor(report), totalPoints: (existing?.totalPoints || 0) + 10, resolvedReports, validReports, rank: 0, badges: [], lastPointsAwardedAt: now };
        profile.badges = badgesFor(profile);
        store.profiles = ranked([...store.profiles.filter((item) => item.userId !== report.userId), profile]);
        store.transactions.push(transaction);
        await writeStore(store);
        result = { transaction, profile: store.profiles.find((item) => item.userId === report.userId) };
    });
    awardQueue = next.catch(() => undefined);
    await next;
    return result;
}
export async function getRewards(userId) {
    const store = await readStore();
    return store.profiles.find((profile) => profile.userId === userId) || null;
}
export async function getPointsHistory(userId) {
    const store = await readStore();
    return store.transactions.filter((transaction) => transaction.userId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export async function getLeaderboard(options = {}) {
    const store = await readStore();
    const monthly = options.period === "monthly";
    const start = new Date();
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
    const monthlyTotals = new Map();
    if (monthly)
        for (const transaction of store.transactions)
            if (new Date(transaction.createdAt) >= start)
                monthlyTotals.set(transaction.userId, (monthlyTotals.get(transaction.userId) || 0) + transaction.points);
    const localityFilter = options.locality?.toLowerCase();
    const profiles = store.profiles.map((profile) => monthly ? { ...profile, totalPoints: monthlyTotals.get(profile.userId) || 0 } : profile).filter((profile) => !localityFilter || profile.locality.toLowerCase() === localityFilter);
    const real = ranked(profiles).map(({ userId: _userId, ...entry }) => entry);
    const demo = localityFilter ? DEMO_LEADERBOARD.filter((entry) => entry.locality.toLowerCase() === localityFilter) : DEMO_LEADERBOARD;
    return [...demo, ...real].sort((a, b) => b.totalPoints - a.totalPoints || b.resolvedReports - a.resolvedReports).map((entry, index) => ({ ...entry, rank: index + 1 }));
}
