import { calculateIndianAqi, aqiCategory } from "../airQuality/aqi.js";
import { POLLUTANT_ORDER, isCompatibleUnit, normalizePollutant } from "../airQuality/pollutants.js";
import { getOpenAqHourlyHistory, getOpenAqLocations } from "./openAqService.js";
const HORIZONS = ["1h", "6h", "12h", "24h"];
const forecastCache = new Map();
function cacheTtlMs() {
    const minutes = Number(process.env.AQI_FORECAST_CACHE_TTL_MINUTES || "30");
    return (Number.isFinite(minutes) ? Math.max(5, minutes) : 30) * 60_000;
}
function category(aqi) { return aqiCategory(aqi); }
function unavailable(lat, lng, reason, warnings = []) {
    return { provider: "unavailable", lat, lng, predictions: {}, categories: {}, hourly: [], trend: "unknown", spikeRisk: "unknown", spikeReason: reason, confidenceNote: "Prediction unavailable until enough recent hourly station history is available.", sourceNote: "The 24-hour result is an application-generated local statistical prediction, not an official CPCB or OpenAQ forecast.", generatedAt: new Date().toISOString(), reason, confidence: "unavailable", warnings: [{ code: "insufficient_history", message: reason }, ...warnings] };
}
function mean(values) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined; }
function byHour(history) {
    const grouped = new Map();
    history.forEach((point) => grouped.set(new Date(point.dateTime).getUTCHours(), [...(grouped.get(new Date(point.dateTime).getUTCHours()) || []), point.value]));
    return new Map([...grouped.entries()].map(([hour, values]) => [hour, mean(values)]));
}
function trendFor(values) {
    if (values.length < 2)
        return "unknown";
    const diff = values.at(-1) - values[0];
    return diff > 8 ? "rising" : diff < -8 ? "falling" : "stable";
}
function riskFor(values) {
    if (!values.length)
        return { spikeRisk: "unknown", spikeReason: "No predicted AQI values were available." };
    const peak = Math.max(...values);
    const increase = peak - values[0];
    if (peak >= 400 || increase >= 120)
        return { spikeRisk: "severe", spikeReason: "Predicted AQI has a severe peak or rapid increase." };
    if (peak >= 300 || increase >= 70)
        return { spikeRisk: "high", spikeReason: "Predicted AQI has a high peak or rapid increase." };
    if (peak >= 200 || increase >= 35)
        return { spikeRisk: "medium", spikeReason: "Predicted AQI has a moderate peak or increase." };
    return { spikeRisk: "low", spikeReason: "Predicted AQI remains below elevated spike thresholds." };
}
function distanceSort(locations) { return [...locations].sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity)); }
async function collectHistory(location) {
    const candidates = location.sensors.filter((sensor) => {
        const pollutant = normalizePollutant(sensor.parameter?.name || sensor.name);
        return pollutant && sensor.parameter?.units && isCompatibleUnit(pollutant, sensor.parameter.units);
    }).slice(0, 7);
    const result = {};
    for (const sensor of candidates) {
        const pollutant = normalizePollutant(sensor.parameter?.name || sensor.name);
        if (!pollutant)
            continue;
        try {
            const history = await getOpenAqHourlyHistory(sensor.id, pollutant, { days: Number(process.env.AQI_HISTORY_DAYS || "7"), limit: 2_000 });
            if (history.length)
                result[pollutant] = history;
        }
        catch {
            // A sensor failure should not suppress other sensors at the same physical station.
        }
    }
    return result;
}
function predictSeries(history, hours) {
    const sorted = [...history].sort((a, b) => a.dateTime.localeCompare(b.dateTime));
    const seasonal = byHour(sorted);
    const recent = sorted.slice(-12).map((point) => point.value);
    const last = recent.at(-1);
    if (last === undefined)
        return [];
    const recentMean = mean(recent) ?? last;
    const slope = recent.length >= 2 ? Math.max(-Math.abs(last) * 0.05, Math.min(Math.abs(last) * 0.05, (last - recent[0]) / recent.length)) : 0;
    const start = new Date();
    start.setUTCMinutes(0, 0, 0);
    return Array.from({ length: hours }, (_, index) => {
        const dateTime = new Date(start.getTime() + (index + 1) * 3_600_000);
        const seasonalValue = seasonal.get(dateTime.getUTCHours()) ?? recentMean;
        const value = Math.max(0, seasonalValue * 0.65 + recentMean * 0.35 + slope * (index + 1));
        const residuals = sorted.slice(-24).map((point) => Math.abs(point.value - recentMean));
        const uncertainty = Math.max(2, mean(residuals) || 2) * (1 + index / hours);
        return { dateTime: dateTime.toISOString(), value, lower: Math.max(0, value - uncertainty), upper: value + uncertainty };
    });
}
function forecastAqi(historyByPollutant, predictionsByPollutant, index) {
    const readings = POLLUTANT_ORDER.flatMap((pollutant) => {
        const history = historyByPollutant[pollutant] || [];
        const predicted = predictionsByPollutant[pollutant]?.[index];
        const windowHours = pollutant === "CO" || pollutant === "OZONE" ? 8 : 24;
        const prior = history.slice(-(windowHours - 1)).map((point) => point.value);
        if (!predicted || prior.length < windowHours - 1)
            return [];
        const value = mean([...prior, predicted.value]);
        return value === undefined ? [] : [{ pollutant, value }];
    });
    return calculateIndianAqi(readings);
}
export async function getAqiForecast(input) {
    const lat = input.lat;
    const lng = input.lng;
    if (!Number.isFinite(lat) || !Number.isFinite(lng))
        return unavailable(lat || 0, lng || 0, "lat and lng are required for the local prediction.");
    const key = `${lat.toFixed(3)}:${lng.toFixed(3)}`;
    const cached = forecastCache.get(key);
    if (cached && cached.expires > Date.now())
        return cached.value;
    try {
        const locations = distanceSort(await getOpenAqLocations(lat, lng, { radiusKm: 25, limit: 8 }));
        let selected;
        let historyByPollutant = {};
        for (const location of locations) {
            const history = await collectHistory(location);
            const total = Object.values(history).reduce((count, series) => count + (series?.length || 0), 0);
            if (total >= Number(process.env.AQI_FORECAST_MIN_HISTORY_HOURS || "72")) {
                selected = location;
                historyByPollutant = history;
                break;
            }
        }
        if (!selected) {
            const result = unavailable(lat, lng, "Insufficient hourly OpenAQ history within 25 km for a local 24-hour prediction.");
            forecastCache.set(key, { expires: Date.now() + cacheTtlMs(), value: result });
            return result;
        }
        const predictionsByPollutant = {};
        for (const pollutant of POLLUTANT_ORDER) {
            const history = historyByPollutant[pollutant];
            if (history && history.length >= 12)
                predictionsByPollutant[pollutant] = predictSeries(history, 24);
        }
        const hourly = Array.from({ length: 24 }, (_, index) => {
            const aqi = forecastAqi(historyByPollutant, predictionsByPollutant, index);
            const allPredicted = POLLUTANT_ORDER.flatMap((pollutant) => predictionsByPollutant[pollutant]?.[index]?.value === undefined ? [] : [predictionsByPollutant[pollutant][index].value]);
            return { dateTime: predictionsByPollutant["PM2.5"]?.[index]?.dateTime || new Date(Date.now() + (index + 1) * 3_600_000).toISOString(), aqi: aqi.aqi, category: category(aqi.aqi), dominantPollutant: aqi.dominantPollutant, pollutants: Object.fromEntries(POLLUTANT_ORDER.flatMap((pollutant) => { const point = predictionsByPollutant[pollutant]?.[index]; return point ? [[pollutant, { predictedValue: point.value, lowerBound: point.lower, upperBound: point.upper, unit: historyByPollutant[pollutant]?.[0]?.unit || "", confidence: historyByPollutant[pollutant].length >= 72 ? "medium" : "low" }]] : []; })), predictedValues: allPredicted };
        }).filter((point) => point.aqi !== undefined);
        if (hourly.length < 6)
            return unavailable(lat, lng, "Recent station history exists but does not provide enough valid rolling AQI coverage.");
        const aqiValues = hourly.map((point) => point.aqi).filter(Number.isFinite);
        const peakAqi = Math.max(...aqiValues);
        const peak = hourly.find((point) => point.aqi === peakAqi);
        const risk = riskFor(aqiValues);
        const predictions = {};
        const categories = {};
        const indices = { "1h": 0, "6h": 5, "12h": 11, "24h": 23 };
        HORIZONS.forEach((horizon) => { const point = hourly[indices[horizon]] || hourly.at(-1); if (point?.aqi !== undefined) {
            predictions[horizon] = Math.round(point.aqi);
            categories[horizon] = point.category;
        } });
        const result = { provider: "locally_forecast", lat, lng, nearestStation: selected.name, nearestStationDistanceMeters: selected.distance ?? undefined, latestAvailableTimestamp: Object.values(historyByPollutant).flat().sort((a, b) => b.dateTime.localeCompare(a.dateTime))[0]?.dateTime, latestAvailableAqi: undefined, predictions, categories, hourly: hourly.map((point) => ({ dateTime: point.dateTime, aqi: point.aqi, category: point.category, dominantPollutant: point.dominantPollutant, pollutants: point.pollutants })), peakAqi: Math.round(peakAqi), peakTime: peak?.dateTime, averageAqi: Math.round(mean(aqiValues) || 0), trend: trendFor(aqiValues), ...risk, confidenceNote: "Prediction confidence is based on recent hourly coverage and residual uncertainty; it is not an official CPCB/OpenAQ forecast.", sourceNote: "Local statistical prediction based on recent measured station history. OpenAQ may republish government data and is not automatically independent confirmation.", generatedAt: new Date().toISOString(), method: "hour-of-day seasonal mean + recent EWMA/trend with rolling AQI windows", confidence: Object.values(historyByPollutant).some((series) => (series?.length || 0) >= 168) ? "medium" : "low", uncertainty: { lower: Math.min(...hourly.map((point) => point.aqi)), upper: Math.max(...hourly.map((point) => point.aqi)) }, backtest: POLLUTANT_ORDER.flatMap((pollutant) => historyByPollutant[pollutant] ? [{ pollutant, validationCount: Math.max(0, historyByPollutant[pollutant].length - 24), coverage: historyByPollutant[pollutant].length / 168, mae: undefined }] : []) };
        forecastCache.set(key, { expires: Date.now() + cacheTtlMs(), value: result });
        return result;
    }
    catch (error) {
        const result = unavailable(lat, lng, error instanceof Error ? error.message : "Local prediction failed.");
        forecastCache.set(key, { expires: Date.now() + cacheTtlMs(), value: result });
        return result;
    }
}
export async function getForecastStations() {
    try {
        const locations = await getOpenAqLocations(18.5204, 73.8567, { radiusKm: 25, limit: 20 });
        return { stations: locations.map((location) => ({ id: location.id, name: location.name, lat: location.coordinates.latitude, lng: location.coordinates.longitude, distanceMeters: location.distance ?? undefined })), count: locations.length, reason: "OpenAQ stations with recent measured history are eligible for local prediction." };
    }
    catch (error) {
        return { stations: [], count: 0, reason: error instanceof Error ? error.message : "OpenAQ station history unavailable." };
    }
}
