import { calculateIndianAqi } from "../airQuality/aqi.js";
const ENDPOINT = "https://air-quality-api.open-meteo.com/v1/air-quality";
const CACHE_MS = 10 * 60_000;
const cache = new Map();
const INDIA_LOCATIONS = [
    { city: "Srinagar", state: "Jammu and Kashmir", lat: 34.0837, lng: 74.7973 },
    { city: "Chandigarh", state: "Chandigarh", lat: 30.7333, lng: 76.7794 },
    { city: "Delhi", state: "Delhi", lat: 28.6139, lng: 77.2090 },
    { city: "Jaipur", state: "Rajasthan", lat: 26.9124, lng: 75.7873 },
    { city: "Lucknow", state: "Uttar Pradesh", lat: 26.8467, lng: 80.9462 },
    { city: "Ahmedabad", state: "Gujarat", lat: 23.0225, lng: 72.5714 },
    { city: "Bhopal", state: "Madhya Pradesh", lat: 23.2599, lng: 77.4126 },
    { city: "Patna", state: "Bihar", lat: 25.5941, lng: 85.1376 },
    { city: "Kolkata", state: "West Bengal", lat: 22.5726, lng: 88.3639 },
    { city: "Guwahati", state: "Assam", lat: 26.1445, lng: 91.7362 },
    { city: "Mumbai", state: "Maharashtra", lat: 19.0760, lng: 72.8777 },
    { city: "Pune", state: "Maharashtra", lat: 18.5204, lng: 73.8567 },
    { city: "Nagpur", state: "Maharashtra", lat: 21.1458, lng: 79.0882 },
    { city: "Hyderabad", state: "Telangana", lat: 17.3850, lng: 78.4867 },
    { city: "Visakhapatnam", state: "Andhra Pradesh", lat: 17.6868, lng: 83.2185 },
    { city: "Bengaluru", state: "Karnataka", lat: 12.9716, lng: 77.5946 },
    { city: "Chennai", state: "Tamil Nadu", lat: 13.0827, lng: 80.2707 },
    { city: "Kochi", state: "Kerala", lat: 9.9312, lng: 76.2673 },
    { city: "Bhubaneswar", state: "Odisha", lat: 20.2961, lng: 85.8245 }
];
let nationalCache;
function coordinateKey(lat, lng) {
    return `${lat.toFixed(2)}:${lng.toFixed(2)}`;
}
function reading(pollutant, value, unit, measuredAt) {
    if (!Number.isFinite(value) || value === undefined || value < 0)
        return undefined;
    return {
        pollutant,
        value,
        unit,
        provider: "open_meteo",
        station: "Open-Meteo area model",
        stationId: "open-meteo-area-model",
        measuredAt,
        freshness: "usable",
        valueKind: "instantaneous",
        aggregationPeriod: "hourly",
        aggregationPeriodVerified: false,
        unitCompatible: true,
        usableForCurrentFusion: true,
        usableForAqi: false,
        status: "available",
        warnings: ["modelled_hourly_reading"]
    };
}
function summaryFromPayload(lat, lng, payload, name = "Open-Meteo area model") {
    const key = coordinateKey(lat, lng);
    const current = payload.current;
    if (!current)
        throw new Error("Open-Meteo returned no current air-quality data.");
    const measuredAt = current.time ? new Date(current.time).toISOString() : new Date().toISOString();
    const readings = Object.fromEntries([
        ["PM2.5", reading("PM2.5", current.pm2_5, "µg/m³", measuredAt)],
        ["PM10", reading("PM10", current.pm10, "µg/m³", measuredAt)],
        // Open-Meteo supplies CO in µg/m³; the Indian AQI breakpoint uses mg/m³.
        ["CO", reading("CO", current.carbon_monoxide === undefined ? undefined : current.carbon_monoxide / 1_000, "mg/m³", measuredAt)],
        ["NO2", reading("NO2", current.nitrogen_dioxide, "µg/m³", measuredAt)],
        ["SO2", reading("SO2", current.sulphur_dioxide, "µg/m³", measuredAt)],
        ["OZONE", reading("OZONE", current.ozone, "µg/m³", measuredAt)]
    ].flatMap(([pollutant, item]) => item ? [[pollutant, item]] : []));
    const aqiCalculation = calculateIndianAqi(Object.values(readings).flatMap((item) => item?.value === undefined ? [] : [{ pollutant: item.pollutant, value: item.value }]));
    const aqi = aqiCalculation.aqi === undefined || !aqiCalculation.category ? undefined : {
        value: aqiCalculation.aqi,
        category: aqiCalculation.category,
        quality: "indicative",
        calculationType: "reported_average_estimate",
        isOfficial: false,
        dominantPollutant: aqiCalculation.dominantPollutant,
        averagingPeriodsVerified: false,
        coverageValidated: false,
        subIndices: Object.fromEntries(Object.entries(aqiCalculation.subIndices).map(([pollutant, subIndex]) => [pollutant, { concentration: readings[pollutant]?.value || 0, subIndex, sourceProvider: "open_meteo", stationId: "open-meteo-area-model" }])),
        calculationTrace: { source: "Open-Meteo", readingType: "modelled_hourly" },
        warnings: ["Modelled hourly readings are an indicative estimate, not official monitoring-station AQI."]
    };
    const station = {
        id: `open-meteo:${key}`,
        name,
        provider: "open_meteo",
        lat,
        lng,
        lastUpdate: measuredAt,
        freshness: "usable",
        pollutants: readings,
        attribution: "Open-Meteo",
        license: "CC BY 4.0"
    };
    return {
        provider: "open_meteo",
        status: "available",
        aqi: aqi?.value,
        category: aqi?.category,
        dominantPollutant: aqi?.dominantPollutant,
        pollutants: readings,
        readings,
        nearestStation: station.name,
        lastUpdate: measuredAt,
        station,
        nearbyStations: [station],
        confidence: "low",
        warnings: [{ code: "provider_error", provider: "open_meteo", message: "Showing an indicative Open-Meteo area estimate because no nearby official monitoring-station reading is available." }],
        calculationType: aqi?.calculationType || "unavailable",
        aqiQuality: aqi?.quality || "unavailable",
        isOfficial: false,
        calculationTrace: aqi?.calculationTrace,
        rawSummary: aqi ? `Indicative AQI ${aqi.value}; estimated from Open-Meteo hourly area data.` : "Open-Meteo hourly pollutant context is available, but an AQI estimate could not be calculated.",
        sourceNote: "Open-Meteo provides modelled area data. This is not an official CPCB monitoring-station measurement or a street-level sensor reading."
    };
}
async function requestOpenMeteo(latitudes, longitudes) {
    const url = new URL(ENDPOINT);
    url.searchParams.set("latitude", latitudes);
    url.searchParams.set("longitude", longitudes);
    url.searchParams.set("current", "pm2_5,pm10,carbon_monoxide,nitrogen_dioxide,sulphur_dioxide,ozone");
    url.searchParams.set("timezone", "auto");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4_000);
    try {
        const response = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
        if (!response.ok)
            throw new Error(`Open-Meteo returned ${response.status}.`);
        return await response.json();
    }
    finally {
        clearTimeout(timeout);
    }
}
export async function getOpenMeteoAirQuality(lat, lng) {
    const key = coordinateKey(lat, lng);
    const cached = cache.get(key);
    if (cached && cached.expires > Date.now())
        return cached.value;
    const payload = await requestOpenMeteo(String(lat), String(lng));
    const value = summaryFromPayload(lat, lng, Array.isArray(payload) ? payload[0] : payload);
    cache.set(key, { expires: Date.now() + CACHE_MS, value });
    return value;
}
export async function getOpenMeteoNationalAirQuality() {
    if (nationalCache && nationalCache.expires > Date.now())
        return nationalCache.value;
    const payload = await requestOpenMeteo(INDIA_LOCATIONS.map((location) => location.lat).join(","), INDIA_LOCATIONS.map((location) => location.lng).join(","));
    const values = Array.isArray(payload) ? payload : [payload];
    const result = INDIA_LOCATIONS.flatMap((location, index) => {
        const value = values[index];
        if (!value?.current)
            return [];
        return [{ ...location, summary: summaryFromPayload(location.lat, location.lng, value, `Open-Meteo area model — ${location.city}`) }];
    });
    nationalCache = { expires: Date.now() + CACHE_MS, value: result };
    return result;
}
