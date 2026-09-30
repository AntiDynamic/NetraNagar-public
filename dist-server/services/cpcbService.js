import crypto from "node:crypto";
import { calculateIndianAqi } from "../airQuality/aqi.js";
import { POLLUTANT_ORDER, canonicalUnit, normalizePollutant } from "../airQuality/pollutants.js";
import { freshnessFromAge, parseCpcbNumber, parseCpcbTimestamp } from "../airQuality/parsing.js";
import { distanceMeters } from "../utils/geo.js";
const CACHE_TTL_FALLBACK_MINUTES = 60;
let recordCache = null;
let fetchRecordsPromise = null;
function stringValue(value) {
    return typeof value === "string" && value.trim() ? value.trim() : value === undefined || value === null ? undefined : String(value).trim() || undefined;
}
function numberValue(value) {
    const parsed = parseCpcbNumber(value);
    return parsed.status === "valid" ? parsed.value : undefined;
}
function pageLimit() {
    const value = Number(process.env.CPCB_PAGE_LIMIT || "1000");
    return Number.isFinite(value) ? Math.max(100, Math.min(5000, Math.floor(value))) : 1000;
}
function hardMaxPages() {
    const value = Number(process.env.CPCB_HARD_MAX_PAGES || "1000");
    return Number.isFinite(value) ? Math.max(10, Math.min(1000, Math.floor(value))) : 1000;
}
function cacheTtlMs() {
    const value = Number(process.env.CPCB_CACHE_TTL_MINUTES || String(CACHE_TTL_FALLBACK_MINUTES));
    return (Number.isFinite(value) ? Math.max(5, value) : CACHE_TTL_FALLBACK_MINUTES) * 60_000;
}
function resourceId() {
    return process.env.CPCB_RESOURCE_ID || "3b01bcb8-0b14-4abf-b6f2-c1bfd384ba69";
}
export function normalizeCpcbPollutant(value) {
    return normalizePollutant(value);
}
function validCoordinates(record) {
    const lat = numberValue(record.latitude);
    const lng = numberValue(record.longitude);
    return lat !== undefined && lng !== undefined && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 ? { lat, lng } : undefined;
}
function recordIdentity(record) {
    return [record.station, record.city, record.state, record.latitude, record.longitude, record.pollutant_id, record.last_update, record.pollutant_avg ?? record.avg_value, record.pollutant_min ?? record.min_value, record.pollutant_max ?? record.max_value].map((value) => String(value ?? "").trim().toLowerCase()).join("|");
}
function pageSignature(records) {
    return crypto.createHash("sha256").update(records.map(recordIdentity).join("\n")).digest("hex");
}
export function classifyCpcbRow(record, now = new Date()) {
    const pollutant = normalizeCpcbPollutant(record.pollutant_id);
    const coordinates = validCoordinates(record);
    const average = parseCpcbNumber(record.pollutant_avg ?? record.avg_value);
    const maximum = parseCpcbNumber(record.pollutant_max ?? record.max_value);
    const minimum = parseCpcbNumber(record.pollutant_min ?? record.min_value);
    const timestamp = parseCpcbTimestamp(record.last_update, now);
    let classification;
    if (!coordinates)
        classification = "invalid_coordinates";
    else if (!pollutant)
        classification = "invalid_pollutant";
    else if (!timestamp.valid)
        classification = timestamp.reason === "missing_timestamp" ? "invalid_timestamp" : "invalid_timestamp";
    else if (average.status === "valid")
        classification = "valid_average";
    else if (maximum.status === "valid")
        classification = "valid_maximum_only";
    else if (minimum.status === "valid")
        classification = "valid_minimum_only";
    else if ([average, maximum, minimum].some((value) => value.status === "invalid"))
        classification = "invalid_numeric_value";
    else
        classification = "missing_value";
    return { record, pollutant, lat: coordinates?.lat, lng: coordinates?.lng, station: stringValue(record.station), city: stringValue(record.city), state: stringValue(record.state), average, maximum, minimum, timestamp, classification, identity: recordIdentity(record), unit: stringValue(record.pollutant_unit ?? record.unit) || (pollutant ? canonicalUnit(pollutant) : "") };
}
export function cpcbMeasurementEligibility(row, now = new Date()) {
    const reasons = [];
    const value = row.average.value;
    const freshness = freshnessFromAge(row.timestamp.ageHours);
    if (!row.pollutant)
        reasons.push("unsupported_pollutant");
    if (!row.timestamp.valid)
        reasons.push("invalid_timestamp");
    if (value === undefined || !Number.isFinite(value))
        reasons.push("missing_value");
    if (row.average.status === "invalid")
        reasons.push("invalid_numeric_value");
    if (row.classification === "valid_maximum_only")
        reasons.push("maximum_only");
    if (row.classification === "valid_minimum_only")
        reasons.push("minimum_only");
    if (freshness === "stale")
        reasons.push("stale_measurement");
    if (freshness === "expired")
        reasons.push("expired_measurement");
    if (!row.unit || !row.pollutant)
        reasons.push("incompatible_unit");
    const current = reasons.length === 0 && (freshness === "fresh" || freshness === "usable") && row.classification === "valid_average";
    return {
        displayAsCurrentMeasurement: current,
        usableForLocalContext: current,
        usableForClusterStatistic: current,
        usableForAqi: false,
        reasons: reasons.length ? reasons : ["cpcb_average_period_unverified"]
    };
}
async function fetchPage(offset, limit) {
    const url = new URL(`https://api.data.gov.in/resource/${resourceId()}`);
    url.searchParams.set("api-key", process.env.DATA_GOV_API_KEY || "");
    url.searchParams.set("format", "json");
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));
    let lastError = { message: "CPCB request failed" };
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
            if (!response.ok) {
                lastError = { status: response.status, message: `CPCB/data.gov.in returned ${response.status}`, body: await response.text() };
                if (![408, 429, 500, 502, 503, 504].includes(response.status))
                    throw lastError;
                const retryAfter = Number(response.headers.get("retry-after"));
                const waitMs = Number.isFinite(retryAfter) ? Math.min(10_000, Math.max(250, retryAfter * 1000)) : Math.min(8_000, 500 * 2 ** attempt);
                await new Promise((resolve) => setTimeout(resolve, waitMs));
                continue;
            }
            const json = await response.json();
            const data = json;
            const records = Array.isArray(data.records) ? data.records.filter((record) => Boolean(record && typeof record === "object")) : [];
            const total = numberValue(data.total);
            const effectiveLimit = numberValue(data.limit);
            return { records, total, limit: effectiveLimit };
        }
        catch (error) {
            if (attempt === 2)
                throw error;
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, Math.min(8_000, 500 * 2 ** attempt)));
        }
    }
    throw lastError;
}
export async function fetchCpcbRecords() {
    const loaded = await fetchCpcbDataset();
    return loaded.records;
}
export async function fetchCpcbDataset() {
    if (recordCache && recordCache.expires > Date.now())
        return { records: recordCache.records, metadata: recordCache.metadata };
    if (fetchRecordsPromise)
        return fetchRecordsPromise;
    fetchRecordsPromise = (async () => {
        const requestedPageLimit = pageLimit();
        const seenRecordIds = new Set();
        const seenPages = new Set();
        const records = [];
        let offset = 0;
        let fetchedPageCount = 0;
        let rawFetchedCount = 0;
        let duplicateRecordCount = 0;
        let apiReportedTotal;
        let effectivePageLimit = requestedPageLimit;
        let stopReason = "provider_error";
        let complete = false;
        let expectedPageCount;
        let repeatedPageCount = 0;
        let lastSuccessfulFetchAt;
        try {
            while (fetchedPageCount < hardMaxPages()) {
                const page = await fetchPage(offset, requestedPageLimit);
                fetchedPageCount += 1;
                rawFetchedCount += page.records.length;
                apiReportedTotal ??= page.total;
                effectivePageLimit = page.limit || page.records.length || effectivePageLimit;
                if (apiReportedTotal !== undefined && effectivePageLimit > 0)
                    expectedPageCount = Math.ceil(apiReportedTotal / effectivePageLimit);
                if (!page.records.length) {
                    stopReason = apiReportedTotal !== undefined && records.length < apiReportedTotal ? "empty_page_after_total" : "api_total_reached";
                    complete = apiReportedTotal === undefined || records.length >= apiReportedTotal;
                    break;
                }
                const signature = pageSignature(page.records);
                if (seenPages.has(signature)) {
                    repeatedPageCount += 1;
                    stopReason = "repeated_page_before_total";
                    complete = apiReportedTotal !== undefined && records.length >= apiReportedTotal;
                    break;
                }
                seenPages.add(signature);
                for (const record of page.records) {
                    const id = recordIdentity(record);
                    if (seenRecordIds.has(id))
                        duplicateRecordCount += 1;
                    else {
                        seenRecordIds.add(id);
                        records.push(record);
                    }
                }
                offset += Math.max(1, effectivePageLimit);
                lastSuccessfulFetchAt = new Date().toISOString();
                if (apiReportedTotal !== undefined && records.length >= apiReportedTotal) {
                    stopReason = "api_total_reached";
                    complete = true;
                    break;
                }
                if (apiReportedTotal === undefined && page.records.length < effectivePageLimit) {
                    stopReason = "short_final_page";
                    complete = true;
                    break;
                }
            }
            if (!complete && fetchedPageCount >= hardMaxPages())
                stopReason = "hard_safety_cap_reached";
        }
        catch (error) {
            const stale = recordCache;
            if (stale) {
                const metadata = { ...stale.metadata, staleFallback: true, warning: "Using the last successful CPCB snapshot because the latest refresh failed." };
                recordCache = { ...stale, metadata };
                return { records: stale.records, metadata };
            }
            throw error;
        }
        finally {
            fetchRecordsPromise = null;
        }
        const expires = Date.now() + cacheTtlMs();
        const metadata = { requestedPageLimit, effectivePageLimit, apiReportedTotal, rawFetchedCount, uniqueFetchedCount: records.length, duplicateRecordCount, fetchedPageCount, firstOffset: 0, lastOffset: Math.max(0, offset - effectivePageLimit), stopReason, complete, generatedAt: new Date().toISOString(), cacheExpiresAt: new Date(expires).toISOString(), expectedPageCount, repeatedPageCount, lastSuccessfulFetchAt, warning: complete ? undefined : "The CPCB dataset may be incomplete because pagination stopped before the reported total." };
        recordCache = { expires, records, metadata };
        return { records, metadata };
    })();
    return fetchRecordsPromise;
}
function stationKey(row) {
    return [row.station?.toLowerCase() || "", row.city?.toLowerCase() || "", row.state?.toLowerCase() || "", row.lat?.toFixed(5) || "", row.lng?.toFixed(5) || ""].join("|");
}
function selectRow(rows, pollutant) {
    const candidates = rows.filter((row) => row.pollutant === pollutant && row.timestamp.valid);
    const sortCandidates = (kind) => candidates.filter((row) => row[kind].status === "valid").sort((a, b) => (b.timestamp.parsedAt || "").localeCompare(a.timestamp.parsedAt || "") || a.identity.localeCompare(b.identity));
    const average = sortCandidates("average")[0];
    const maximum = sortCandidates("maximum")[0];
    const minimum = sortCandidates("minimum")[0];
    return average ? { row: average, value: average.average.value, kind: "average", reason: "newest_valid_average" } : maximum ? { row: maximum, value: maximum.maximum.value, kind: "maximum", reason: "newest_maximum_only" } : minimum ? { row: minimum, value: minimum.minimum.value, kind: "minimum", reason: "newest_minimum_only" } : undefined;
}
function readingFor(rows, pollutant) {
    const selected = selectRow(rows, pollutant);
    const invalid = rows.some((row) => row.pollutant === pollutant && row.classification === "invalid_numeric_value");
    if (!selected)
        return { pollutant, unit: canonicalUnit(pollutant), status: invalid ? "invalid" : "source_missing", usableForCurrentFusion: false, usableForAqi: false, qualityFlags: [invalid ? "invalid_source_value" : "station_did_not_report_pollutant"] };
    const parsed = selected.row.timestamp;
    const freshness = freshnessFromAge(parsed.ageHours);
    const eligibility = cpcbMeasurementEligibility(selected.row);
    const currentUsable = eligibility.displayAsCurrentMeasurement;
    const status = selected.kind === "maximum" ? "maximum_only" : selected.kind === "minimum" ? "minimum_only" : freshness === "expired" ? "expired" : freshness === "stale" ? "stale" : parsed.valid ? "available" : "timestamp_unknown";
    const reasons = eligibility.reasons.filter((reason) => reason !== "cpcb_average_period_unverified");
    return { pollutant, min: selected.row.minimum.value, max: selected.row.maximum.value, avg: selected.row.average.value, value: selected.value, unit: selected.row.unit || canonicalUnit(pollutant), rawPollutantId: stringValue(selected.row.record.pollutant_id), valueKind: selected.kind, measuredAt: parsed.parsedAt, lastUpdate: parsed.parsedAt, ageHours: parsed.ageHours, freshness, status, usableForCurrentFusion: currentUsable, usableForAqi: false, aggregationPeriod: "unknown", aggregationPeriodVerified: false, eligibility, selectionReason: selected.reason, exclusionReason: currentUsable ? "cpcb_average_period_unverified" : reasons.join(",") || "unknown_aggregation_period", qualityFlags: reasons.length ? reasons : ["cpcb_average_period_unverified"] };
}
function stationPoint(rows, origin) {
    const first = rows.find((row) => row.lat !== undefined && row.lng !== undefined && row.station);
    if (!first || first.lat === undefined || first.lng === undefined || !first.station)
        return null;
    const pollutants = Object.fromEntries(POLLUTANT_ORDER.map((pollutant) => [pollutant, readingFor(rows, pollutant)]));
    const validDates = Object.values(pollutants).map((reading) => reading?.measuredAt).filter((date) => Boolean(date)).sort().reverse();
    const aqiReadings = POLLUTANT_ORDER.flatMap((pollutant) => { const reading = pollutants[pollutant]; return reading?.usableForAqi && reading.value !== undefined ? [{ pollutant, value: reading.value }] : []; });
    const aqi = calculateIndianAqi(aqiReadings);
    const latestAge = Math.min(...Object.values(pollutants).map((reading) => reading?.ageHours).filter((age) => Number.isFinite(age)));
    const freshness = freshnessFromAge(Number.isFinite(latestAge) ? latestAge : undefined);
    return { id: `cpcb:${stationKey(first)}`, station: first.station, city: first.city, state: first.state, lat: first.lat, lng: first.lng, distanceMeters: origin ? Math.round(distanceMeters(origin.lat, origin.lng, first.lat, first.lng)) : undefined, lastUpdate: validDates[0], pollutants, dominantPollutant: aqi.dominantPollutant, aqi: aqi.aqi, category: aqi.category, freshness, freshnessLabel: freshness === "fresh" ? "Updated within 3h" : freshness === "usable" ? "Updated within 12h" : freshness === "stale" ? "Stale CPCB station reading" : freshness === "expired" ? "Expired CPCB station reading" : "Update time unavailable" };
}
async function allStationPoints(origin) {
    const dataset = await fetchCpcbDataset();
    const grouped = new Map();
    dataset.records.map((record) => classifyCpcbRow(record)).filter((row) => row.station && row.lat !== undefined && row.lng !== undefined && row.pollutant).forEach((row) => grouped.set(stationKey(row), [...(grouped.get(stationKey(row)) || []), row]));
    return { points: [...grouped.values()].flatMap((rows) => { const point = stationPoint(rows, origin); return point ? [point] : []; }), metadata: dataset.metadata };
}
export async function getNearbyCpcbStations(lat, lng, options = {}) {
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180)
        throw new Error("lat and lng must be finite coordinates.");
    const radiusKm = options.radiusKm ?? 25;
    if (!Number.isFinite(radiusKm) || radiusKm <= 0 || radiusKm > 100)
        throw new Error("radiusKm must be finite, positive, and no greater than 100 km.");
    const limit = Math.max(1, Math.min(50, Math.floor(options.limit ?? 8)));
    if (!process.env.DATA_GOV_API_KEY)
        return { provider: "cpcb_data_gov", lat, lng, radiusKm, stations: [], stationCount: 0, generatedAt: new Date().toISOString(), sourceNote: "DATA_GOV_API_KEY is not configured." };
    let points = [];
    let metadata;
    try {
        const loaded = await allStationPoints({ lat, lng });
        points = loaded.points;
        metadata = loaded.metadata;
    }
    catch (error) {
        return { provider: "cpcb_data_gov", lat, lng, radiusKm, stations: [], stationCount: 0, generatedAt: new Date().toISOString(), sourceNote: error instanceof Error ? `CPCB station refresh failed: ${error.message}` : "CPCB station refresh failed." };
    }
    const pollutant = options.pollutant || "all";
    const stations = points.filter((station) => (station.distanceMeters ?? Infinity) <= radiusKm * 1000).filter((station) => pollutant === "all" || station.pollutants[pollutant]?.usableForCurrentFusion === true).sort((a, b) => (a.distanceMeters ?? Infinity) - (b.distanceMeters ?? Infinity)).slice(0, limit);
    return { provider: "cpcb_data_gov", lat, lng, radiusKm, stations, stationCount: stations.length, generatedAt: new Date().toISOString(), sourceNote: "CPCB/data.gov.in provides official monitoring-station pollutant readings. This is station-derived context, not exact street-level sensor data.", warning: metadata?.warning };
}
export async function getCpcbLocalPollutantContext(lat, lng, options = {}) {
    const nearby = await getNearbyCpcbStations(lat, lng, { radiusKm: options.radiusKm ?? 25, limit: 50, pollutant: "all" });
    const selected = options.pollutant && options.pollutant !== "all" ? [options.pollutant] : POLLUTANT_ORDER;
    const pollutants = Object.fromEntries(selected.map((pollutant) => {
        const readings = nearby.stations.flatMap((station) => { const reading = station.pollutants[pollutant]; return reading?.usableForCurrentFusion && reading.value !== undefined ? [{ station, reading }] : []; });
        const values = readings.map((item) => item.reading.value).filter(Number.isFinite);
        const nearest = readings[0];
        if (!nearest || !values.length)
            return [pollutant, { unit: canonicalUnit(pollutant), nearbyStationCount: 0, confidence: "unavailable", freshnessSummary: `No fresh or usable station reading within ${nearby.radiusKm} km.` }];
        const weighted = readings.reduce((acc, item) => { const distanceKm = Math.max((item.station.distanceMeters || 0) / 1000, 0.5); const weight = 1 / distanceKm ** 2; return { sum: acc.sum + item.reading.value * weight, weight: acc.weight + weight }; }, { sum: 0, weight: 0 });
        const high = readings.filter((item) => (item.station.distanceMeters || Infinity) <= 10_000).length >= 3;
        const medium = readings.filter((item) => (item.station.distanceMeters || Infinity) <= 25_000).length >= 2;
        return [pollutant, { unit: nearest.reading.unit, nearestValue: nearest.reading.value, nearestStation: nearest.station.station, nearestDistanceMeters: nearest.station.distanceMeters, nearbyStationCount: readings.length, minNearby: Math.min(...values), maxNearby: Math.max(...values), avgNearby: values.reduce((sum, value) => sum + value, 0) / values.length, idwEstimate: weighted.sum / weighted.weight, confidence: high ? "high" : medium ? "medium" : "low", freshnessSummary: readings.map((item) => item.reading.freshness || "unknown").join(", ") }];
    }));
    return { provider: "cpcb_station_context", lat, lng, radiusKm: nearby.radiusKm, generatedAt: new Date().toISOString(), pollutants, nearestStations: nearby.stations.slice(0, 8), sourceNote: "Station-derived local pollutant context from CPCB/data.gov.in. This is not a street-level sensor reading." };
}
export async function getCpcbStatus() {
    if (!process.env.DATA_GOV_API_KEY)
        return { configured: false, recordCount: 0, usableRecordCount: 0, stationCount: 0, pollutantsAvailable: [], complete: false, reason: "DATA_GOV_API_KEY is not configured." };
    try {
        const dataset = await fetchCpcbDataset();
        const classified = dataset.records.map((record) => classifyCpcbRow(record));
        const usable = classified.filter((row) => cpcbMeasurementEligibility(row).displayAsCurrentMeasurement);
        const stations = new Set(usable.map(stationKey));
        const updates = classified.flatMap((row) => row.timestamp.parsedAt ? [row.timestamp.parsedAt] : []).sort();
        return { configured: true, recordCount: dataset.metadata.rawFetchedCount, usableRecordCount: usable.length, stationCount: stations.size, pollutantsAvailable: [...new Set(usable.flatMap((row) => row.pollutant ? [row.pollutant] : []))], latestUpdate: updates.at(-1), oldestUpdate: updates[0], ...dataset.metadata, cacheExpiresAt: dataset.metadata.cacheExpiresAt, reason: dataset.metadata.warning || "CPCB station records are refreshed from DataGov/CPCB and labeled by pollutant-level freshness." };
    }
    catch (error) {
        return { configured: true, recordCount: 0, usableRecordCount: 0, stationCount: 0, pollutantsAvailable: [], complete: false, reason: error instanceof Error ? error.message : "CPCB dataset refresh failed." };
    }
}
export async function getCpcbAirQualityWithDebug(lat, lng) {
    if (!process.env.DATA_GOV_API_KEY)
        return { debug: { configured: false, usable: false, reason: "DATA_GOV_API_KEY is not configured." } };
    try {
        const nearby = await getNearbyCpcbStations(lat, lng, { radiusKm: 25, limit: 1 });
        const station = nearby.stations[0];
        if (!station)
            return { debug: { configured: true, usable: false, reason: "No CPCB station within 25 km.", recordCount: (await fetchCpcbDataset()).records.length } };
        const readings = Object.fromEntries(POLLUTANT_ORDER.map((pollutant) => [pollutant, station.pollutants[pollutant]]));
        const aqi = calculateIndianAqi(POLLUTANT_ORDER.flatMap((pollutant) => { const reading = station.pollutants[pollutant]; return reading?.usableForAqi && reading.value !== undefined ? [{ pollutant, value: reading.value }] : []; }));
        const value = { provider: "cpcb_data_gov", status: "available", aqi: aqi.aqi, category: aqi.category || "Estimated Indian AQI unavailable", dominantPollutant: aqi.dominantPollutant, pollutants: readings, readings: readings, nearestStation: `${station.station}, ${station.city || station.state || "India"}`, nearestStationDistanceMeters: station.distanceMeters, lastUpdate: station.lastUpdate, rawSummary: "CPCB/data.gov.in official monitoring-station readings. Estimated Indian AQI is calculated only from eligible pollutant averages.", sourceNote: "Station-level reading, not exact street-level AQI." };
        return { value, debug: { configured: true, usable: true, reason: "CPCB/data.gov.in official monitoring-station reading.", nearestStation: station.station, recordCount: (await fetchCpcbDataset()).records.length, usableRecordCount: station ? Object.values(station.pollutants).filter((reading) => reading?.value !== undefined).length : 0 } };
    }
    catch (error) {
        return { debug: { configured: true, usable: false, reason: error instanceof Error ? error.message : "CPCB request failed." } };
    }
}
export async function getCpcbAirQuality(lat, lng) {
    return (await getCpcbAirQualityWithDebug(lat, lng)).value;
}
export async function getCpcbMapPoints() {
    if (!process.env.DATA_GOV_API_KEY)
        return { points: [], reason: "DATA_GOV_API_KEY is not configured.", complete: false };
    const { points, metadata } = await allStationPoints();
    const mapPoints = points.map((station) => {
        const metrics = Object.fromEntries(Object.entries(station.pollutants).flatMap(([pollutant, reading]) => reading?.value === undefined || !reading.usableForCurrentFusion ? [] : [[pollutant, reading.value]]));
        const units = Object.fromEntries(Object.entries(station.pollutants).flatMap(([pollutant, reading]) => reading?.value === undefined || !reading.usableForCurrentFusion ? [] : [[pollutant, reading.unit]]));
        const availability = Object.values(station.pollutants).filter((reading) => reading?.value !== undefined && reading.usableForCurrentFusion).length;
        if (station.aqi !== undefined)
            metrics.aqi = station.aqi;
        units.aqi = "AQI";
        return { id: station.id, physicalStationId: station.id, provider: "cpcb_data_gov", sourceLabel: "CPCB official monitoring station", label: station.station, name: station.station, city: station.city, state: station.state, lat: station.lat, lng: station.lng, metrics, units, aqi: station.aqi, aqiQuality: "unavailable", category: station.category, lastUpdate: station.lastUpdate, dominantPollutant: station.dominantPollutant, cpcbStation: station, availability: { available: availability, supported: POLLUTANT_ORDER.length, label: `${availability} of ${POLLUTANT_ORDER.length} current eligible pollutants available` }, note: "Station-derived context, not exact street-level sensor data." };
    });
    return { points: mapPoints, reason: metadata.warning || `CPCB returned ${mapPoints.length} official monitoring stations.`, complete: metadata.complete, metadata };
}
export function clearCpcbCache() {
    recordCache = null;
    fetchRecordsPromise = null;
}
