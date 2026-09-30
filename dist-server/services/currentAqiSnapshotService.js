import { isCompatibleUnit, normalizePollutant } from "../airQuality/pollutants.js";
import { calculateRollingIndianAqi } from "../airQuality/aqi.js";
import { buildRollingWindow } from "../airQuality/hourlySeries.js";
import { getOpenAqHourlyHistory } from "./openAqService.js";
const results = new Map();
let refreshPromise;
let refreshTimer;
const stationRegistry = new Map();
const cycleProcessed = new Set();
let queue = [];
let cursor = 0;
let status = {
    complete: false,
    refreshing: false,
    queuedStations: 0,
    processedStations: 0,
    successfulValidatedStations: 0,
    successfulIndicativeStations: 0,
    failedStations: 0,
    totalPhysicalStations: 0,
    reasons: { insufficientHistory: 0, insufficientCoverage: 0, insufficientPollutants: 0, incompatibleUnits: 0, unsupportedSensors: 0, providerErrors: 0 },
    warnings: []
};
function boundedInt(name, fallback, minimum, maximum) {
    const value = Number(process.env[name] || fallback);
    return Math.max(minimum, Math.min(maximum, Number.isFinite(value) ? Math.floor(value) : fallback));
}
function stationKey(station) { return String(station.locationId); }
function sensorCandidates(station) {
    const grouped = new Map();
    for (const sensor of station.sensors) {
        const pollutant = normalizePollutant(sensor.parameter?.name || sensor.name);
        const unit = sensor.parameter?.units;
        if (!pollutant || !unit || !isCompatibleUnit(pollutant, unit))
            continue;
        grouped.set(pollutant, [...(grouped.get(pollutant) || []), sensor]);
    }
    return grouped;
}
function orderedStations(stations, priorityIds = new Set()) {
    return [...stations].sort((a, b) => {
        const aPriority = priorityIds.has(a.locationId) ? 0 : 1;
        const bPriority = priorityIds.has(b.locationId) ? 0 : 1;
        const aFresh = a.freshness === "fresh" || a.freshness === "usable" ? 0 : 1;
        const bFresh = b.freshness === "fresh" || b.freshness === "usable" ? 0 : 1;
        return aPriority - bPriority || aFresh - bFresh || (b.readings ? Object.keys(b.readings).length : 0) - (a.readings ? Object.keys(a.readings).length : 0) || a.locationId - b.locationId;
    });
}
function toResult(aqi, windows, selections, stationId) {
    if (aqi.aqi === undefined || !aqi.category || !aqi.dominantPollutant)
        return undefined;
    const subIndices = Object.fromEntries(Object.entries(aqi.subIndices).flatMap(([pollutant, subIndex]) => {
        const window = windows.find((candidate) => candidate.pollutant === pollutant);
        if (!window || subIndex === undefined || window.rollingConcentration === undefined)
            return [];
        const selection = selections.find((candidate) => candidate.pollutant === pollutant);
        return [[pollutant, { concentration: window.rollingConcentration, subIndex, averagingHours: window.averagingHours, observedSlots: window.observedHourlySlots, expectedSlots: window.expectedHourlySlots, interpolatedSlots: window.interpolatedHourlySlots, missingSlots: window.missingHourlySlots, coveragePercent: window.coveragePercent, sourceProvider: "openaq", sensorId: selection?.selectedSensorId, stationId, windowStart: window.windowStart, windowEnd: window.windowEnd }]];
    }));
    return { value: aqi.aqi, category: aqi.category, dominantPollutant: aqi.dominantPollutant, quality: "rolling_validated", calculationType: "rolling_history_calculated", isOfficial: false, averagingPeriodsVerified: true, coverageValidated: true, subIndices, calculationTrace: { windows, sensorSelections: selections, aqi }, warnings: aqi.warnings || [] };
}
async function processStation(station, requestBudget) {
    const existing = results.get(station.locationId);
    const base = { physicalStationId: station.id, locationId: station.locationId, stationName: station.name, lat: station.lat, lng: station.lng };
    const candidates = sensorCandidates(station);
    if (!candidates.size)
        return { ...base, status: "unsupported_sensors", warnings: ["unsupported_sensors"] };
    if (requestBudget.remaining <= 0)
        return { ...base, status: "pending", warnings: ["request_budget_exhausted"] };
    const windows = [];
    const rollingReadings = [];
    const selections = [];
    let budgetExhausted = false;
    for (const [pollutant, sensors] of candidates.entries()) {
        const latestSensor = station.readings[pollutant]?.sensorId;
        const ordered = [...sensors].sort((a, b) => Number(b.id === latestSensor) - Number(a.id === latestSensor) || a.id - b.id);
        const selection = { pollutant, selectedSensorId: ordered[0]?.id, candidateSensorIds: ordered.map((sensor) => sensor.id), selectionReason: latestSensor === ordered[0]?.id ? "latest_supported_sensor_preferred" : "deterministic_lowest_supported_sensor", rejectedCandidates: ordered.slice(1).map((sensor) => ({ sensorId: sensor.id, reason: "not_selected_for_station_consistency" })) };
        selections.push(selection);
        if (requestBudget.remaining <= 0 || !ordered[0]) {
            budgetExhausted = requestBudget.remaining <= 0;
            break;
        }
        requestBudget.remaining -= 1;
        try {
            const history = await getOpenAqHourlyHistory(ordered[0].id, pollutant, { days: boundedInt("CURRENT_AQI_HISTORY_DAYS", 2, 2, 7), limit: 500 });
            const window = buildRollingWindow(pollutant, history, { maxAgeHours: boundedInt("CURRENT_AQI_MAX_AGE_HOURS", 12, 1, 48), maxInterpolatedGapHours: 2 });
            windows.push(window);
            if (window.valid && window.rollingConcentration !== undefined)
                rollingReadings.push({ pollutant, value: window.rollingConcentration, averagingHours: window.averagingHours, stationId: station.id, source: "openaq", coverage: { averagingHours: window.averagingHours, observedHourlySlots: window.observedHourlySlots + window.interpolatedHourlySlots, expectedHourlySlots: window.expectedHourlySlots } });
        }
        catch {
            selection.rejectedCandidates.push({ sensorId: ordered[0].id, reason: "history_request_failed" });
        }
    }
    if (budgetExhausted)
        return { ...base, status: "pending", warnings: ["request_budget_exhausted"] };
    const aqi = calculateRollingIndianAqi(rollingReadings);
    const validated = toResult(aqi, windows, selections, station.id);
    if (validated) {
        const now = new Date();
        const next = new Date(now.getTime() + boundedInt("CURRENT_AQI_CACHE_TTL_MINUTES", 30, 5, 180) * 60_000).toISOString();
        return { ...base, validated, selected: validated, status: "validated_available", lastCalculatedAt: now.toISOString(), nextRefreshAt: next, warnings: validated.warnings };
    }
    const warningSet = new Set([...(aqi.warnings || []), ...windows.flatMap((window) => window.invalidReasons)]);
    const stationStatus = candidates.size < 3 ? "insufficient_pollutants" : warningSet.has("insufficient_hourly_coverage") || warningSet.has("long_or_unfillable_gap") || warningSet.has("stale_or_expired_history") ? "insufficient_coverage" : "insufficient_history";
    if (existing?.validated)
        return { ...existing, status: stationStatus, warnings: [...new Set([...existing.warnings, "refresh_incomplete_using_previous_snapshot"])] };
    return { ...base, status: stationStatus, warnings: [...warningSet] };
}
function ensureQueue(stations, priorityLocationIds = []) {
    for (const station of stations)
        stationRegistry.set(station.locationId, station);
    const registered = orderedStations([...stationRegistry.values()], new Set(priorityLocationIds));
    const queuedIds = new Set(queue.map(stationKey));
    const additions = registered.filter((station) => !queuedIds.has(stationKey(station)));
    if (additions.length)
        queue.push(...additions);
    const due = Boolean(status.complete && status.nextRefreshAt && Date.parse(status.nextRefreshAt) <= Date.now());
    if (due && !status.refreshing) {
        queue = registered;
        cursor = 0;
        cycleProcessed.clear();
        status = { ...status, complete: false, processedStations: 0, queuedStations: queue.length, startedAt: new Date().toISOString() };
    }
    const hasNewStations = additions.length > 0;
    if (hasNewStations) {
        const startingNewCycle = status.complete || !status.startedAt;
        if (startingNewCycle)
            cycleProcessed.clear();
        status = { ...status, totalPhysicalStations: registered.length, queuedStations: Math.max(0, queue.length - cursor), complete: false, processedStations: startingNewCycle ? 0 : status.processedStations, startedAt: startingNewCycle ? new Date().toISOString() : status.startedAt };
    }
    else if (!status.totalPhysicalStations) {
        status = { ...status, totalPhysicalStations: registered.length, queuedStations: Math.max(0, queue.length - cursor) };
    }
}
async function runRefresh() {
    if (!queue.length) {
        status = { ...status, complete: false, refreshing: false, queuedStations: 0, warnings: ["no_open_aq_station_history_candidates"] };
        return;
    }
    const concurrency = boundedInt("CURRENT_AQI_SYNC_CONCURRENCY", 2, 2, 3);
    const batchSize = boundedInt("CURRENT_AQI_REFRESH_BATCH_SIZE", 20, 1, 50);
    const maxRequests = boundedInt("CURRENT_AQI_MAX_REQUESTS_PER_RUN", 100, 1, 300);
    const requestBudget = { remaining: maxRequests };
    status = { ...status, refreshing: true, warnings: [] };
    while (cursor < queue.length && requestBudget.remaining > 0) {
        const batchEnd = Math.min(cursor + batchSize, queue.length);
        while (cursor < batchEnd && requestBudget.remaining > 0) {
            const group = queue.slice(cursor, Math.min(cursor + concurrency, batchEnd));
            const processed = await Promise.all(group.map(async (station) => {
                try {
                    return await processStation(station, requestBudget);
                }
                catch (error) {
                    return { physicalStationId: station.id, locationId: station.locationId, stationName: station.name, lat: station.lat, lng: station.lng, status: "failed", warnings: [error instanceof Error ? error.message : "provider_error"] };
                }
            }));
            let advanced = 0;
            for (const result of processed) {
                if (result.status === "pending" && result.warnings.includes("request_budget_exhausted"))
                    break;
                results.set(result.locationId, result);
                cycleProcessed.add(result.locationId);
                advanced += 1;
            }
            cursor += advanced;
            if (!advanced)
                break;
            const completed = [...results.values()];
            status = { ...status, totalPhysicalStations: stationRegistry.size, processedStations: cycleProcessed.size, queuedStations: Math.max(0, queue.length - cursor), successfulValidatedStations: completed.filter((result) => result.status === "validated_available").length, successfulIndicativeStations: completed.filter((result) => result.selected?.quality === "indicative").length, failedStations: completed.filter((result) => result.status === "failed").length, reasons: reasonCounts(completed) };
        }
    }
    if (cursor >= queue.length) {
        const now = new Date();
        status = { ...status, complete: true, refreshing: false, queuedStations: 0, lastCompletedAt: now.toISOString(), nextRefreshAt: new Date(now.getTime() + boundedInt("CURRENT_AQI_CACHE_TTL_MINUTES", 30, 5, 180) * 60_000).toISOString() };
    }
    else {
        status = { ...status, refreshing: true, queuedStations: Math.max(0, queue.length - cursor), warnings: ["aqi_history_processing_pending"] };
        refreshTimer = setTimeout(() => { refreshTimer = undefined; void startRefresh(); }, 250);
    }
}
function reasonCounts(items) {
    return {
        insufficientHistory: items.filter((item) => item.status === "insufficient_history").length,
        insufficientCoverage: items.filter((item) => item.status === "insufficient_coverage").length,
        insufficientPollutants: items.filter((item) => item.status === "insufficient_pollutants").length,
        incompatibleUnits: items.filter((item) => item.warnings.some((warning) => warning.includes("incompatible"))).length,
        unsupportedSensors: items.filter((item) => item.status === "unsupported_sensors").length,
        providerErrors: items.filter((item) => item.status === "failed").length
    };
}
function startRefresh() {
    if (refreshPromise)
        return refreshPromise;
    refreshPromise = runRefresh().catch((error) => {
        status = { ...status, refreshing: false, failedStations: status.failedStations + 1, warnings: [error instanceof Error ? error.message : "provider_error"] };
    }).finally(() => { refreshPromise = undefined; });
    return refreshPromise;
}
export function getCurrentAqiSnapshot(stations, priorityLocationIds) {
    ensureQueue(stations, priorityLocationIds);
    const due = !status.refreshing && (!status.nextRefreshAt || Date.parse(status.nextRefreshAt) <= Date.now());
    if (queue.length && due && !refreshTimer)
        void startRefresh();
    return { byLocationId: new Map([...results.entries()]), status: getCurrentAqiStatus() };
}
export async function refreshCurrentAqiSnapshot(stations, priorityLocationIds) {
    ensureQueue(stations, priorityLocationIds);
    await startRefresh();
}
export function getCurrentAqiStatus() {
    return { ...status, reasons: { ...status.reasons }, warnings: [...status.warnings] };
}
export function resetCurrentAqiSnapshot() {
    if (refreshTimer)
        clearTimeout(refreshTimer);
    results.clear();
    stationRegistry.clear();
    cycleProcessed.clear();
    queue = [];
    cursor = 0;
    status = { complete: false, refreshing: false, queuedStations: 0, processedStations: 0, successfulValidatedStations: 0, successfulIndicativeStations: 0, failedStations: 0, totalPhysicalStations: 0, reasons: { insufficientHistory: 0, insufficientCoverage: 0, insufficientPollutants: 0, incompatibleUnits: 0, unsupportedSensors: 0, providerErrors: 0 }, warnings: [] };
}
