import { requestSentinelHub } from "./sentinelHubClient.js";
export function bboxAroundPoint(lat, lng, radiusMeters) {
    const safeLat = Math.max(-89.9, Math.min(89.9, lat));
    const cos = Math.max(0.01, Math.cos((safeLat * Math.PI) / 180));
    const latDelta = radiusMeters / 111320;
    const lngDelta = radiusMeters / (111320 * cos);
    return [lng - lngDelta, safeLat - latDelta, lng + lngDelta, safeLat + latDelta];
}
function validFeature(feature) {
    return Boolean(feature.id && Array.isArray(feature.bbox) && feature.bbox.length === 4 && typeof feature.properties?.datetime === "string" && !Number.isNaN(new Date(feature.properties.datetime).getTime()));
}
function temporalOffsetHours(acquisitionTime, reportTime) {
    return (new Date(acquisitionTime).getTime() - new Date(reportTime).getTime()) / 3600000;
}
function roleForOffset(offset) {
    return offset < -24 ? "baseline" : offset > 24 ? "follow_up" : "near_report";
}
async function catalogPage(input) {
    const body = {
        collections: ["sentinel-2-l2a"],
        bbox: input.bbox,
        datetime: `${input.from.toISOString()}/${input.to.toISOString()}`,
        limit: input.limit,
        fields: { include: ["id", "bbox", "properties.datetime", "properties.eo:cloud_cover"] }
    };
    if (input.next !== undefined)
        body.next = input.next;
    const { data } = await requestSentinelHub("/api/v1/catalog/1.0.0/search", {
        method: "POST", headers: { Accept: "application/geo+json" }, body: JSON.stringify(body)
    });
    return { features: Array.isArray(data.features) ? data.features : [], next: data.context?.next };
}
async function searchWindow(input) {
    const features = [];
    let next;
    for (let page = 0; page < input.maxPages && features.length < input.maxCandidates; page++) {
        const result = await catalogPage({ bbox: input.bbox, from: input.from, to: input.to, limit: Math.min(100, input.maxCandidates - features.length), next });
        features.push(...result.features);
        if (result.next === undefined || result.features.length === 0)
            break;
        next = result.next;
    }
    const seen = new Set();
    return features.filter(validFeature).filter(feature => {
        if (seen.has(feature.id))
            return false;
        seen.add(feature.id);
        const cloud = feature.properties["eo:cloud_cover"];
        return cloud === undefined || (Number.isFinite(cloud) && cloud <= input.maxCloudCover);
    }).map(feature => {
        const offset = temporalOffsetHours(feature.properties.datetime, input.reportTime);
        const scene = {
            collection: "sentinel-2-l2a",
            sceneId: feature.id,
            acquisitionTime: feature.properties.datetime,
            cloudCover: feature.properties["eo:cloud_cover"] ?? undefined,
            bbox: feature.bbox,
            source: "catalog",
            temporalOffsetHours: offset,
            relation: roleForOffset(offset)
        };
        return scene;
    });
}
function sortCandidates(scenes) {
    return [...scenes].sort((a, b) => {
        const cloudA = a.cloudCover ?? Number.POSITIVE_INFINITY;
        const cloudB = b.cloudCover ?? Number.POSITIVE_INFINITY;
        if (cloudA !== cloudB)
            return cloudA - cloudB;
        return Math.abs(a.temporalOffsetHours ?? 0) - Math.abs(b.temporalOffsetHours ?? 0);
    });
}
export async function searchSentinel2Scenes(params) {
    const bbox = bboxAroundPoint(params.lat, params.lng, params.radiusMeters);
    const reportTime = new Date(params.createdAt);
    const maxPages = Math.max(1, Math.min(10, Number(process.env.SENTINEL_HUB_MAX_CATALOG_PAGES || 10)));
    const maxCandidates = Math.max(1, Math.min(40, params.limit ?? Number(process.env.SENTINEL_HUB_MAX_CANDIDATES || 40)));
    const primary = await searchWindow({ bbox, from: new Date(reportTime.getTime() - params.primaryWindowDays * 86400000), to: new Date(reportTime.getTime() + params.primaryWindowDays * 86400000), reportTime: reportTime.toISOString(), maxCloudCover: params.maxCloudCover, maxPages, maxCandidates });
    const fallbackNeeded = primary.length === 0;
    let scenes = primary;
    let timeWindowUsed = "primary";
    if (fallbackNeeded) {
        const fallback = await searchWindow({ bbox, from: new Date(reportTime.getTime() - params.fallbackLookbackDays * 86400000), to: new Date(reportTime.getTime() + 86400000), reportTime: reportTime.toISOString(), maxCloudCover: params.maxCloudCover, maxPages, maxCandidates });
        scenes = fallback;
        timeWindowUsed = "fallback";
    }
    scenes = sortCandidates(scenes).slice(0, maxCandidates);
    return {
        scenes,
        selectedScene: scenes.find(scene => scene.relation === "near_report") ?? scenes[0],
        reason: scenes.length ? `Found ${scenes.length} catalog candidate(s) under the tile cloud limit.` : "No Sentinel-2 L2A scene met the catalog metadata and cloud constraints.",
        timeWindowUsed,
        reportBbox: bbox
    };
}
export async function searchSentinel2SceneRoles(params) {
    const bbox = bboxAroundPoint(params.lat, params.lng, params.radiusMeters);
    const event = new Date(params.eventTime);
    const maxPages = Math.max(1, Math.min(10, Number(process.env.SENTINEL_HUB_MAX_CATALOG_PAGES || 10)));
    const maxCandidates = Math.max(1, Math.min(40, Number(process.env.SENTINEL_HUB_MAX_CANDIDATES || 40)));
    const common = { bbox, reportTime: event.toISOString(), maxCloudCover: params.maxCloudCover, maxPages, maxCandidates };
    const [near, baseline, followUp] = await Promise.all([
        searchWindow({ ...common, from: new Date(event.getTime() - params.nearWindowDays * 86400000), to: new Date(event.getTime() + params.nearWindowDays * 86400000) }),
        searchWindow({ ...common, from: new Date(event.getTime() - params.baselineLookbackDays * 86400000), to: new Date(event.getTime() - 7 * 86400000) }),
        searchWindow({ ...common, from: new Date(event.getTime() + 86400000), to: new Date(event.getTime() + params.followupDays * 86400000) })
    ]);
    const pick = (items, relation) => sortCandidates(items.map(item => ({ ...item, relation })))[0];
    return { reportBbox: bbox, nearReport: pick(near.filter(item => Math.abs(item.temporalOffsetHours ?? 999) <= params.nearWindowDays * 24), "near_report"), baseline: pick(baseline, "baseline"), followUp: pick(followUp, "follow_up"), candidates: [...near, ...baseline, ...followUp].slice(0, maxCandidates) };
}
export { temporalOffsetHours };
