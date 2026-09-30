import { calculateIndicativeCpcbAqi } from "../airQuality/aqi.js";
import { POLLUTANT_ORDER } from "../airQuality/pollutants.js";
import { getCpcbAirQualityWithDebug, getCpcbMapPoints, getNearbyCpcbStations } from "./cpcbService.js";
import { getOpenAqNearbyStations } from "./openAqService.js";
import { getOpenAqNationalSnapshot } from "./openAqNationalSnapshotService.js";
import { distanceMeters } from "../utils/geo.js";
import { matchPhysicalStations } from "./stationMatchingService.js";
import { getCurrentAqiSnapshot } from "./currentAqiSnapshotService.js";
import { loadAirQualityMapCache, saveAirQualityMapCache } from "./airQualityMapCache.js";
import { getOpenMeteoAirQuality, getOpenMeteoNationalAirQuality } from "./openMeteoAirQualityService.js";
import { getLocalAqiDataset } from "./localAqiDataset.js";
const CACHE_TTL_MS = Math.max(1, Number(process.env.AQI_CURRENT_CACHE_TTL_MINUTES || 10)) * 60_000;
const currentCache = new Map();
let lastSuccessfulMap = loadAirQualityMapCache();
let latestAqiCoverage;
function coordinateKey(lat, lng) { return `${lat.toFixed(3)}:${lng.toFixed(3)}`; }
function cpcbStationToStation(station) {
    const pollutants = Object.fromEntries(Object.entries(station.pollutants).map(([pollutant, reading]) => [pollutant, reading ? { ...reading, provider: "cpcb_data_gov", station: station.station, stationId: station.id } : reading]));
    return { id: station.id, name: station.station, provider: "cpcb_data_gov", lat: station.lat, lng: station.lng, city: station.city, state: station.state, distanceMeters: station.distanceMeters, lastUpdate: station.lastUpdate, freshness: station.freshness === "same_day" ? "usable" : station.freshness, pollutants, sourceReadings: { cpcb: pollutants } };
}
function openAqStationToStation(station) {
    const pollutants = Object.fromEntries(Object.entries(station.readings).map(([pollutant, reading]) => [pollutant, reading ? { ...reading, station: station.name, stationId: station.id, provider: "openaq", aggregationPeriod: "unknown", aggregationPeriodVerified: false, usableForCurrentFusion: reading.freshness === "fresh" || reading.freshness === "usable", usableForAqi: false } : reading]));
    return { id: station.id, name: station.name, provider: "openaq", lat: station.lat, lng: station.lng, city: station.locality, distanceMeters: station.distanceMeters, lastUpdate: station.lastUpdate, freshness: station.freshness, attribution: station.attribution, license: station.license, pollutants, sourceReadings: { openaq: pollutants } };
}
function matches(cpcb, openAq) {
    const distance = distanceMeters(cpcb.lat, cpcb.lng, openAq.lat, openAq.lng);
    return Boolean(matchPhysicalStations(cpcb, openAq, distance));
}
function mergeStations(cpcbStations, openAqStations) {
    const merged = [...cpcbStations];
    for (const openAq of openAqStations) {
        const matchedEntry = merged.map((station) => ({ station, match: matchPhysicalStations(station, openAq, distanceMeters(station.lat, station.lng, openAq.lat, openAq.lng)) })).find((entry) => entry.match);
        const match = matchedEntry?.station;
        if (!match)
            merged.push(openAq);
        else {
            match.id = matchedEntry?.match?.physicalStationId || match.id;
            match.provider = "matched";
            match.providers = ["cpcb_data_gov", "openaq"];
            const mergedPollutants = { ...match.pollutants };
            for (const [pollutant, reading] of Object.entries(openAq.pollutants)) {
                const existing = mergedPollutants[pollutant];
                if (!existing?.usableForCurrentFusion)
                    mergedPollutants[pollutant] = reading;
            }
            match.pollutants = mergedPollutants;
            match.sourceReadings = { cpcb: match.sourceReadings?.cpcb, openaq: openAq.sourceReadings?.openaq };
            match.sourceBundles = Object.fromEntries(POLLUTANT_ORDER.flatMap((pollutant) => {
                const cpcbReading = match.sourceReadings?.cpcb?.[pollutant];
                const openAqReading = match.sourceReadings?.openaq?.[pollutant];
                if (!cpcbReading && !openAqReading)
                    return [];
                const difference = cpcbReading?.value !== undefined && openAqReading?.value !== undefined ? Math.abs(cpcbReading.value - openAqReading.value) : undefined;
                const relative = difference !== undefined && cpcbReading?.value ? difference / cpcbReading.value * 100 : undefined;
                return [[pollutant, { pollutant, cpcb: cpcbReading, openaq: openAqReading, selectedCurrent: mergedPollutants[pollutant], samePhysicalStation: true, selectionReason: mergedPollutants[pollutant]?.provider === "cpcb_data_gov" ? "cpcb_preferred" : "openaq_compatible_fallback", conflict: { detected: relative !== undefined && relative > 30, absoluteDifference: difference, relativeDifferencePercent: relative, reason: relative !== undefined && relative > 30 ? "provider_values_differ_materially" : undefined } }]];
            }));
            match.attribution = openAq.attribution;
            match.license = openAq.license;
        }
    }
    return merged.sort((a, b) => (a.distanceMeters ?? Infinity) - (b.distanceMeters ?? Infinity));
}
function unavailable(reason, warnings = []) {
    return { provider: "unavailable", status: "unavailable", pollutants: {}, readings: {}, warnings: [{ code: "provider_error", message: reason }, ...warnings], rawSummary: "Current measured-air context is unavailable. Report verification remains independent of AQI providers.", sourceNote: "No usable monitoring-station measurement was available." };
}
function timed(promise, timeoutMs, fallback) {
    return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(fallback), timeoutMs))]);
}
function toOpenMeteoMapPoint(summary, lat, lng, city, state) {
    const readings = summary.readings || {};
    const metrics = Object.fromEntries(Object.entries(readings).flatMap(([pollutant, item]) => item?.value === undefined ? [] : [[pollutant, item.value]]));
    const units = Object.fromEntries(Object.entries(readings).flatMap(([pollutant, item]) => item?.value === undefined ? [] : [[pollutant, item.unit]]));
    if (summary.aqi !== undefined)
        metrics.aqi = summary.aqi;
    units.aqi = "AQI";
    const selected = summary.aqi === undefined || !summary.category ? undefined : {
        value: summary.aqi,
        category: summary.category,
        quality: "indicative",
        calculationType: summary.calculationType === "unavailable" || !summary.calculationType ? "reported_average_estimate" : summary.calculationType,
        isOfficial: false,
        dominantPollutant: summary.dominantPollutant,
        averagingPeriodsVerified: false,
        coverageValidated: false,
        warnings: ["Modelled hourly estimate; not official station AQI."]
    };
    return {
        id: `open-meteo:${coordinateKey(lat, lng)}`,
        physicalStationId: `open-meteo:${coordinateKey(lat, lng)}`,
        provider: "open_meteo",
        sourceLabel: "Open-Meteo area estimate (not a monitoring station)",
        label: city ? `${city} AQI estimate` : "Live area AQI estimate",
        name: city ? `Open-Meteo area model - ${city}` : "Open-Meteo area model",
        city,
        state,
        lat,
        lng,
        metrics,
        units,
        aqi: summary.aqi,
        aqiQuality: selected?.quality || "unavailable",
        aqiStatus: { selected, indicative: selected, status: selected ? "indicative_available" : "unavailable", warnings: selected?.warnings || [] },
        category: summary.category,
        dominantPollutant: summary.dominantPollutant,
        lastUpdate: summary.lastUpdate,
        availability: { available: Object.keys(readings).length, supported: POLLUTANT_ORDER.length, label: "Modelled hourly pollutant estimate" },
        metricDetails: Object.fromEntries(Object.entries(readings).flatMap(([pollutant, item]) => item?.value === undefined ? [] : [[pollutant, { value: item.value, unit: item.unit, provider: "open_meteo", measuredAt: item.measuredAt, freshness: item.freshness, valueKind: item.valueKind, aggregationPeriod: item.aggregationPeriod, aggregationPeriodVerified: false, currentMapEligible: true, aqiEligible: false, warnings: ["modelled_hourly_reading"] }]])),
        attribution: "Open-Meteo",
        note: "Indicative AQI estimated from modelled hourly area data; not official CPCB station AQI."
    };
}
async function providerStations(lat, lng) {
    const [cpcbResult, openAqResult] = await Promise.allSettled([
        getNearbyCpcbStations(lat, lng, { radiusKm: 25, limit: 25, pollutant: "all" }),
        getOpenAqNearbyStations(lat, lng, { radiusKm: 25, limit: 12 })
    ]);
    const cpcbStations = cpcbResult.status === "fulfilled" ? cpcbResult.value.stations.map(cpcbStationToStation) : [];
    const openAqPoints = openAqResult.status === "fulfilled" ? openAqResult.value : [];
    const openAqStations = openAqPoints.map(openAqStationToStation);
    const current = getCurrentAqiSnapshot(openAqPoints);
    const warnings = [];
    if (cpcbResult.status === "rejected")
        warnings.push({ code: "provider_error", provider: "cpcb_data_gov", message: cpcbResult.reason instanceof Error ? cpcbResult.reason.message : "CPCB provider unavailable." });
    if (openAqResult.status === "rejected")
        warnings.push({ code: "provider_error", provider: "openaq", message: openAqResult.reason instanceof Error ? openAqResult.reason.message : "OpenAQ provider unavailable." });
    return { cpcbStations, openAqStations, stations: mergeStations(cpcbStations, openAqStations), snapshots: current.byLocationId, warnings };
}
function chooseReading(pollutant, station, warnings) {
    const cpcb = station?.pollutants[pollutant];
    const openAq = station?.pollutants[pollutant];
    if (cpcb?.provider === "cpcb_data_gov" && cpcb.value !== undefined && cpcb.usableForCurrentFusion)
        return cpcb;
    if (openAq?.provider === "openaq" && openAq.value !== undefined && openAq.unitCompatible && openAq.usableForCurrentFusion !== false && openAq.freshness !== "expired") {
        if (cpcb?.value !== undefined && cpcb.value > 0 && Math.abs(cpcb.value - openAq.value) / cpcb.value > 0.3)
            warnings.push({ code: "station_match_uncertain", pollutant, message: `${pollutant} values differ across matched provider records.` });
        return openAq;
    }
    return cpcb || openAq;
}
function publicRollingAqi(result) {
    return { value: result.value, category: result.category, quality: result.quality, calculationType: result.calculationType, isOfficial: result.isOfficial, dominantPollutant: result.dominantPollutant, averagingPeriodsVerified: result.averagingPeriodsVerified, coverageValidated: result.coverageValidated, subIndices: result.subIndices, calculationTrace: result.calculationTrace, warnings: result.warnings };
}
function indicativeAqiForStation(station) {
    const cpcbSource = station.sourceReadings?.cpcb || (station.provider === "cpcb_data_gov" ? station.pollutants : {});
    const openAqSource = station.sourceReadings?.openaq || (station.provider === "openaq" ? station.pollutants : {});
    const useCpcb = Object.keys(cpcbSource).length > 0;
    const source = useCpcb ? cpcbSource : openAqSource;
    const sourceProvider = useCpcb ? "cpcb_data_gov" : "openaq";
    const result = calculateIndicativeCpcbAqi(POLLUTANT_ORDER.flatMap((pollutant) => {
        const reading = source[pollutant];
        return reading?.value === undefined ? [] : [{ pollutant, value: reading.value, stationId: station.id, source: sourceProvider, valueKind: reading.valueKind, measuredAt: reading.measuredAt, freshness: reading.freshness, unitCompatible: reading.unitCompatible }];
    }));
    if (result.aqi === undefined || !result.category)
        return undefined;
    const eligible = Array.isArray(result.calculationTrace?.eligible)
        ? result.calculationTrace.eligible
        : [];
    const subIndices = Object.fromEntries(Object.entries(result.subIndices).flatMap(([pollutant, subIndex]) => {
        const item = eligible.find((candidate) => candidate.pollutant === pollutant);
        return item && subIndex !== undefined ? [[pollutant, { concentration: item.value, subIndex, averagingHours: pollutant === "CO" || pollutant === "OZONE" ? 8 : 24, sourceProvider, stationId: station.id }]] : [];
    }));
    return { value: result.aqi, category: result.category, quality: "indicative", calculationType: "reported_average_estimate", isOfficial: false, dominantPollutant: result.dominantPollutant, averagingPeriodsVerified: false, coverageValidated: false, subIndices, calculationTrace: result.calculationTrace, warnings: result.warnings || [useCpcb ? "cpcb_average_period_unverified" : "openaq_average_period_unverified"] };
}
function currentSnapshotForStation(station, snapshots) {
    const sourceReading = Object.values(station.sourceReadings?.openaq || {}).find((reading) => reading?.stationId?.startsWith("openaq:"));
    const locationId = Number(sourceReading?.stationId?.split(":")[1] || station.id.split(":")[1]);
    return Number.isFinite(locationId) ? snapshots.get(locationId) : undefined;
}
function buildSummary(lat, lng, stations, warnings, snapshots = new Map()) {
    const station = stations[0];
    if (!station)
        return unavailable("No monitoring station within 25 km.", warnings);
    const pollutantSources = Object.fromEntries(POLLUTANT_ORDER.flatMap((pollutant) => {
        const candidate = stations.find((candidateStation) => {
            const reading = candidateStation.pollutants[pollutant];
            return reading?.value !== undefined && reading.usableForCurrentFusion && (reading.unitCompatible !== false);
        });
        if (!candidate)
            return [];
        const reading = chooseReading(pollutant, candidate, warnings);
        return reading ? [[pollutant, { station: candidate.name, distanceMeters: candidate.distanceMeters, provider: reading.provider, reading }]] : [];
    }));
    const readings = Object.fromEntries(Object.entries(pollutantSources || {}).map(([pollutant, source]) => [pollutant, source.reading]));
    const current = currentSnapshotForStation(station, snapshots);
    const indicative = indicativeAqiForStation(station);
    const providerReported = current?.selected?.quality === "provider_reported" ? publicRollingAqi(current.selected) : undefined;
    const selectedAqi = providerReported || (current?.validated ? publicRollingAqi(current.validated) : indicative);
    const aqiWarnings = [
        ...warnings,
        ...(current?.warnings || []).map((message) => ({ code: "insufficient_history", message })),
        ...(indicative?.warnings || []).map((message) => ({ code: "insufficient_history", message }))
    ];
    const provider = station.provider === "matched" ? "fused_measured" : station.provider;
    const available = Object.values(readings || {}).filter((reading) => reading?.value !== undefined).length;
    return { provider, status: "available", aqi: selectedAqi?.value, category: selectedAqi?.category || "AQI unavailable", dominantPollutant: selectedAqi?.dominantPollutant, pollutants: readings, readings, pollutantSources, nearestStation: station.name, nearestStationDistanceMeters: station.distanceMeters, lastUpdate: station.lastUpdate, station, nearbyStations: stations, confidence: available >= 4 ? "high" : available >= 2 ? "medium" : "low", warnings: [...new Set(aqiWarnings)], calculationType: selectedAqi?.calculationType || "unavailable", aqiQuality: selectedAqi?.quality || "unavailable", isOfficial: selectedAqi?.isOfficial || false, calculationTrace: selectedAqi?.calculationTrace, rawSummary: selectedAqi ? selectedAqi.quality === "rolling_validated" ? `Estimated Indian AQI ${selectedAqi.value}; calculated from validated rolling station measurements.` : `Indicative AQI ${selectedAqi.value}; estimated from CPCB-reported averages and the averaging period is not verified.` : current?.status === "pending" ? "Validated AQI calculation is pending station-history processing. Pollutant context remains available." : "Measured station context is available, but AQI cannot currently be calculated from the available station data.", sourceNote: "CPCB is the official Indian monitoring source; OpenAQ is supplementary and may republish government data. These are station-derived readings, not exact street-level measurements." };
}
export async function getAirQuality(lat, lng) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180)
        return unavailable("lat and lng must be finite coordinates.");
    const key = coordinateKey(lat, lng);
    const cached = currentCache.get(key);
    if (cached && cached.expires > Date.now())
        return cached.value;
    try {
        const context = await providerStations(lat, lng);
        const stationValue = buildSummary(lat, lng, context.stations, context.warnings, context.snapshots);
        const value = stationValue.provider === "unavailable" ? await getOpenMeteoAirQuality(lat, lng).catch(() => stationValue) : stationValue;
        currentCache.set(key, { expires: Date.now() + CACHE_TTL_MS, value });
        return value;
    }
    catch (error) {
        return unavailable(error instanceof Error ? error.message : "Air-quality providers failed.");
    }
}
export async function getAirQualitySources(lat, lng) {
    const context = await providerStations(lat, lng);
    const selected = buildSummary(lat, lng, context.stations, context.warnings, context.snapshots);
    const cpcbStation = context.cpcbStations[0];
    const openAqStation = context.openAqStations[0];
    const cpcbValue = cpcbStation ? buildSummary(lat, lng, [cpcbStation], [], context.snapshots) : undefined;
    const openAqValue = openAqStation ? buildSummary(lat, lng, [openAqStation], [], context.snapshots) : undefined;
    return { lat, lng, selectedProvider: selected.provider, selected, cpcb: { configured: Boolean(process.env.DATA_GOV_API_KEY), usable: context.cpcbStations.length > 0, reason: context.cpcbStations.length ? "CPCB official monitoring-station data available." : "CPCB returned no station within 25 km.", value: cpcbValue?.provider === "unavailable" ? undefined : cpcbValue }, openaq: { configured: Boolean(process.env.OPENAQ_API_KEY), usable: context.openAqStations.length > 0, reason: context.openAqStations.length ? "OpenAQ supplementary monitoring data available." : "OpenAQ returned no usable station within 25 km.", value: openAqValue?.provider === "unavailable" ? undefined : openAqValue }, warnings: selected.warnings };
}
function toMapPoint(station, current, snapshotComplete = false) {
    const providerReported = current?.selected?.quality === "provider_reported" ? publicRollingAqi(current.selected) : undefined;
    const validated = current?.validated ? publicRollingAqi(current.validated) : undefined;
    const indicative = indicativeAqiForStation(station);
    const selected = providerReported || validated || indicative;
    const aqiStatus = {
        selected,
        validated,
        indicative,
        status: providerReported ? "provider_reported_available" : validated ? "validated_available" : indicative ? "indicative_available" : current?.status === "pending" || !snapshotComplete ? "pending" : current?.status === "insufficient_coverage" ? "insufficient_coverage" : current?.status === "insufficient_pollutants" ? "insufficient_pollutants" : current?.status === "insufficient_history" ? "insufficient_history" : "unavailable",
        warnings: [...new Set([...(current?.warnings || []), ...(validated?.warnings || []), ...(indicative?.warnings || [])])]
    };
    const eligibleReadings = Object.entries(station.pollutants).filter(([, reading]) => reading?.value !== undefined && reading.usableForCurrentFusion && reading.unitCompatible !== false);
    const metrics = Object.fromEntries(eligibleReadings.map(([pollutant, reading]) => [pollutant, reading.value]));
    const units = Object.fromEntries(eligibleReadings.map(([pollutant, reading]) => [pollutant, reading.unit]));
    const available = eligibleReadings.length;
    const metricDetails = Object.fromEntries(eligibleReadings.map(([pollutant, reading]) => [pollutant, { value: reading.value, unit: reading.unit, provider: reading.provider || (station.provider === "matched" ? "fused_measured" : station.provider), measuredAt: reading.measuredAt, ageHours: reading.ageHours, freshness: reading.freshness, valueKind: reading.valueKind, aggregationPeriod: reading.aggregationPeriod, aggregationPeriodVerified: reading.aggregationPeriodVerified, currentMapEligible: true, aqiEligible: Boolean(reading.usableForAqi), warnings: reading.exclusionReason ? [reading.exclusionReason] : [] }]));
    if (selected)
        metrics.aqi = selected.value;
    const provider = station.provider === "matched" ? "fused_measured" : station.provider;
    units.aqi = "AQI";
    return { id: station.id, physicalStationId: station.id, provider, sourceLabel: station.provider === "matched" ? "Matched CPCB + OpenAQ station" : station.provider === "cpcb_data_gov" ? "CPCB official monitoring station" : "OpenAQ supplementary monitoring station", label: station.name, name: station.name, city: station.city, state: station.state, lat: station.lat, lng: station.lng, metrics, units, aqi: selected?.value, aqiQuality: selected?.quality || "unavailable", aqiStatus, category: selected?.category, dominantPollutant: selected?.dominantPollutant, lastUpdate: station.lastUpdate, distanceMeters: station.distanceMeters, station, providers: station.providers, metricDetails, availability: { available, supported: POLLUTANT_ORDER.length, label: `${available} of ${POLLUTANT_ORDER.length} current eligible pollutants available` }, attribution: station.attribution, note: selected?.quality === "rolling_validated" ? "Estimated Indian AQI calculated from validated rolling station measurements; application-calculated and not official." : selected?.quality === "indicative" ? "Indicative AQI from fresh CPCB-reported averages; averaging period not verified." : "Station-derived context, not exact street-level sensor data." };
}
export async function getAirQualityMap(location) {
    const cpcb = await timed(getCpcbMapPoints().catch((error) => ({ points: [], reason: error instanceof Error ? error.message : "CPCB unavailable.", complete: false })), 2_500, { points: [], reason: "CPCB map refresh is taking too long; showing available live sources.", complete: false });
    let nearbyFallback = [];
    if (location && Number.isFinite(location.lat) && Number.isFinite(location.lng)) {
        try {
            nearbyFallback = await getOpenAqNearbyStations(location.lat, location.lng, { radiusKm: 25, limit: 8 });
        }
        catch {
            nearbyFallback = [];
        }
    }
    // A geolocated request must still launch the country-wide synchronizer;
    // nearby stations are merely the fast first response, never a replacement.
    const national = getOpenAqNationalSnapshot({ startRefresh: true });
    // Keep local-first stations in the working set even after the first national
    // batch arrives. Partial national publication must augment, never replace,
    // the fast nearby response.
    const openAqById = new Map();
    for (const station of nearbyFallback)
        openAqById.set(station.locationId, station);
    for (const station of national.stations)
        if (!openAqById.has(station.locationId))
            openAqById.set(station.locationId, station);
    const openAqStations = [...openAqById.values()];
    const usingNearbyFallback = nearbyFallback.length > 0 && national.stations.length === 0;
    const current = getCurrentAqiSnapshot(openAqStations, nearbyFallback.map((station) => station.locationId));
    const cpcbStations = cpcb.points.flatMap((point) => point.cpcbStation ? [cpcbStationToStation(point.cpcbStation)] : []);
    const merged = mergeStations(cpcbStations, openAqStations.map(openAqStationToStation));
    const rawPoints = merged.map((station) => toMapPoint(station, current.byLocationId.get(Number(Object.values(station.sourceReadings?.openaq || {}).find((reading) => reading?.stationId?.startsWith("openaq:"))?.stationId?.split(":")[1] || station.id.split(":")[1])), current.status.complete));
    if (openAqStations.length === 0)
        rawPoints.push(...getLocalAqiDataset());
    const fallbackLocation = location && Number.isFinite(location.lat) && Number.isFinite(location.lng) ? location : { lat: 18.5204, lng: 73.8567 };
    if (!rawPoints.some((point) => point.aqi !== undefined)) {
        const nationalModel = await getOpenMeteoNationalAirQuality().catch(() => []);
        if (nationalModel.length) {
            rawPoints.push(...nationalModel.map((point) => toOpenMeteoMapPoint(point.summary, point.lat, point.lng, point.city, point.state)));
        }
        else {
            const modelled = await getOpenMeteoAirQuality(fallbackLocation.lat, fallbackLocation.lng).catch(() => undefined);
            if (modelled)
                rawPoints.push(toOpenMeteoMapPoint(modelled, fallbackLocation.lat, fallbackLocation.lng));
        }
    }
    const points = rawPoints.filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng) && point.lat >= 6.0 && point.lat <= 37.5 && point.lng >= 68.0 && point.lng <= 97.5);
    const totalPhysicalStations = points.length;
    const metricCoverage = Object.fromEntries(["aqi", ...POLLUTANT_ORDER].map((metric) => [metric, { eligibleStations: metric === "aqi" ? points.filter((point) => point.aqiStatus?.status === "validated_available" || point.aqiStatus?.status === "provider_reported_available" || point.aqiStatus?.status === "indicative_available").length : points.filter((point) => point.metrics[metric] !== undefined).length, totalPhysicalStations }]));
    const nationalSnapshotReady = national.stations.length > 0 || national.status.metadataComplete || !national.status.configured;
    const modelledCoverageReady = points.length > 0 && points.every((point) => point.provider === "open_meteo");
    const aqiCoverage = { validatedEligibleStations: points.filter((point) => point.aqiStatus?.status === "validated_available").length, indicativeEligibleStations: points.filter((point) => point.aqiStatus?.status === "indicative_available").length, providerReportedEligibleStations: points.filter((point) => point.aqiStatus?.status === "provider_reported_available").length, selectedDisplayStations: points.filter((point) => point.aqiStatus?.status === "validated_available" || point.aqiStatus?.status === "provider_reported_available" || point.aqiStatus?.status === "indicative_available").length, pendingStations: points.filter((point) => point.aqiStatus?.status === "pending").length, insufficientHistoryStations: points.filter((point) => point.aqiStatus?.status === "insufficient_history").length, insufficientPollutantStations: points.filter((point) => point.aqiStatus?.status === "insufficient_pollutants").length, unavailableStations: points.filter((point) => point.aqiStatus?.status === "unavailable" || !point.aqiStatus).length, totalPhysicalStations, processedStations: current.status.processedStations, queuedStations: current.status.queuedStations, successfulValidatedStations: current.status.successfulValidatedStations, failedStations: current.status.failedStations, snapshotRefreshing: current.status.refreshing, nationalSnapshotRefreshing: national.status.refreshing, snapshotComplete: modelledCoverageReady || (current.status.complete && nationalSnapshotReady) };
    latestAqiCoverage = aqiCoverage;
    const warnings = [];
    if (!cpcb.complete)
        warnings.push({ code: "incomplete_pagination", message: "CPCB coverage is partial because the provider repeated a page before its reported total." });
    if (!current.status.complete)
        warnings.push({ code: "insufficient_history", message: current.status.warnings.includes("no_open_aq_station_history_candidates") ? "Validated AQI is unavailable because no OpenAQ station history was loaded." : current.status.refreshing ? "Validated AQI is being calculated from station history." : "Validated AQI history processing is pending." });
    if (!aqiCoverage.validatedEligibleStations && aqiCoverage.indicativeEligibleStations)
        warnings.push({ code: "insufficient_history", message: "No validated rolling AQI is ready yet. Indicative CPCB estimates are available." });
    if (!aqiCoverage.validatedEligibleStations && !aqiCoverage.indicativeEligibleStations && current.status.complete)
        warnings.push({ code: "insufficient_history", message: "AQI cannot currently be calculated from the available station data." });
    const response = { generatedAt: new Date().toISOString(), country: "India", cpcbUsable: cpcbStations.length > 0, cpcbReason: cpcb.reason, openAqUsable: openAqStations.length > 0, openAqReason: openAqStations.length ? usingNearbyFallback ? "Showing nearby OpenAQ monitoring stations while the national snapshot synchronizes." : "OpenAQ India monitoring snapshot loaded; AQI history may still be processing." : national.status.refreshing ? "OpenAQ India monitoring snapshot is still synchronizing." : `OpenAQ India monitoring snapshot unavailable: ${national.status.stopReason || "provider_error"}.`, points, providerCounts: { cpcb_data_gov: points.filter((point) => point.provider === "cpcb_data_gov").length, openaq: points.filter((point) => point.provider === "openaq").length, open_meteo: points.filter((point) => point.provider === "open_meteo").length, locally_forecast: points.filter((point) => point.provider === "locally_forecast").length, fused_measured: points.filter((point) => point.provider === "fused_measured").length }, completeness: { cpcbComplete: cpcb.complete, openAqMetadataComplete: national.status.metadataComplete, openAqLatestComplete: national.status.latestSnapshotComplete, nationalMapComplete: cpcb.complete && national.status.metadataComplete && national.status.latestSnapshotComplete }, metricCoverage, aqiCoverage, warnings };
    const hasLiveAqi = points.some((point) => typeof point.metrics.aqi === "number" && Number.isFinite(point.metrics.aqi));
    if (hasLiveAqi) {
        lastSuccessfulMap = response;
        saveAirQualityMapCache(response);
        return response;
    }
    if (lastSuccessfulMap?.points.some((point) => typeof point.metrics.aqi === "number" && Number.isFinite(point.metrics.aqi))) {
        return { ...lastSuccessfulMap, generatedAt: response.generatedAt, openAqReason: "Showing last-known station AQI while live monitoring data refreshes.", points: lastSuccessfulMap.points.map((point) => ({ ...point, stale: true, cachedAt: lastSuccessfulMap.generatedAt })) };
    }
    return response;
}
export function getLatestAqiCoverage() {
    return latestAqiCoverage;
}
export async function getLocalAirQualityMap(region = "pune_pcmc") {
    if (region !== "pune_pcmc")
        return { generatedAt: new Date().toISOString(), country: "India", cpcbUsable: false, cpcbReason: `No measured station region is configured for ${region}.`, points: [] };
    const context = await providerStations(18.5204, 73.8567);
    const points = context.stations.filter((station) => (station.distanceMeters ?? Infinity) <= 25_000).map((station) => toMapPoint(station, currentSnapshotForStation(station, context.snapshots), false));
    return { generatedAt: new Date().toISOString(), country: "India", cpcbUsable: context.cpcbStations.length > 0, cpcbReason: "Pune/PCMC map contains real monitoring stations within 25 km.", openAqUsable: context.openAqStations.length > 0, openAqReason: "OpenAQ locations are real monitoring stations; no sampled AQI points are generated.", points, providerCounts: { cpcb_data_gov: points.filter((point) => point.provider === "cpcb_data_gov").length, openaq: points.filter((point) => point.provider === "openaq").length, fused_measured: points.filter((point) => point.provider === "fused_measured").length } };
}
export async function getAirQualityDebug(lat, lng) {
    const cpcb = await getCpcbAirQualityWithDebug(lat, lng);
    const value = await getAirQuality(lat, lng);
    return { cpcbConfigured: Boolean(process.env.DATA_GOV_API_KEY), cpcbUsable: cpcb.debug.usable, cpcbReason: cpcb.debug.reason, cpcbRecordCount: cpcb.debug.recordCount, cpcbNearestStation: cpcb.debug.nearestStation, openAqConfigured: Boolean(process.env.OPENAQ_API_KEY), openAqUsable: value.provider === "openaq" || value.provider === "fused_measured", openAqReason: value.warnings?.find((warning) => warning.provider === "openaq")?.message || "OpenAQ supplementary context checked.", selectedProvider: value.provider, finalValue: value };
}
export function clearAirQualityCache() { currentCache.clear(); }
