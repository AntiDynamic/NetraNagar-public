import { getAqiForecast } from "./forecastService.js";
import { getAirQuality } from "./airQualityService.js";
const INDIAN_STATES_AND_UTS = [
    { id: "AP", name: "Andhra Pradesh", type: "state", city: "Amaravati", lat: 16.5062, lng: 80.6480 },
    { id: "AR", name: "Arunachal Pradesh", type: "state", city: "Itanagar", lat: 27.0844, lng: 93.6053 },
    { id: "AS", name: "Assam", type: "state", city: "Guwahati", lat: 26.1445, lng: 91.7362 },
    { id: "BR", name: "Bihar", type: "state", city: "Patna", lat: 25.5941, lng: 85.1376 },
    { id: "CT", name: "Chhattisgarh", type: "state", city: "Raipur", lat: 21.2514, lng: 81.6296 },
    { id: "GA", name: "Goa", type: "state", city: "Panaji", lat: 15.4909, lng: 73.8278 },
    { id: "GJ", name: "Gujarat", type: "state", city: "Ahmedabad", lat: 23.0225, lng: 72.5714 },
    { id: "HR", name: "Haryana", type: "state", city: "Chandigarh", lat: 30.7333, lng: 76.7794 },
    { id: "HP", name: "Himachal Pradesh", type: "state", city: "Shimla", lat: 31.1048, lng: 77.1734 },
    { id: "JH", name: "Jharkhand", type: "state", city: "Ranchi", lat: 23.3441, lng: 85.3096 },
    { id: "KA", name: "Karnataka", type: "state", city: "Bengaluru", lat: 12.9716, lng: 77.5946 },
    { id: "KL", name: "Kerala", type: "state", city: "Thiruvananthapuram", lat: 8.5241, lng: 76.9366 },
    { id: "MP", name: "Madhya Pradesh", type: "state", city: "Bhopal", lat: 23.2599, lng: 77.4126 },
    { id: "MH", name: "Maharashtra", type: "state", city: "Mumbai", lat: 19.0760, lng: 72.8777 },
    { id: "MN", name: "Manipur", type: "state", city: "Imphal", lat: 24.8170, lng: 93.9368 },
    { id: "ML", name: "Meghalaya", type: "state", city: "Shillong", lat: 25.5788, lng: 91.8933 },
    { id: "MZ", name: "Mizoram", type: "state", city: "Aizawl", lat: 23.7271, lng: 92.7176 },
    { id: "NL", name: "Nagaland", type: "state", city: "Kohima", lat: 25.6751, lng: 94.1086 },
    { id: "OR", name: "Odisha", type: "state", city: "Bhubaneswar", lat: 20.2961, lng: 85.8245 },
    { id: "PB", name: "Punjab", type: "state", city: "Chandigarh", lat: 30.7333, lng: 76.7794 },
    { id: "RJ", name: "Rajasthan", type: "state", city: "Jaipur", lat: 26.9124, lng: 75.7873 },
    { id: "SK", name: "Sikkim", type: "state", city: "Gangtok", lat: 27.3389, lng: 88.6065 },
    { id: "TN", name: "Tamil Nadu", type: "state", city: "Chennai", lat: 13.0827, lng: 80.2707 },
    { id: "TG", name: "Telangana", type: "state", city: "Hyderabad", lat: 17.3850, lng: 78.4867 },
    { id: "TR", name: "Tripura", type: "state", city: "Agartala", lat: 23.8315, lng: 91.2868 },
    { id: "UP", name: "Uttar Pradesh", type: "state", city: "Lucknow", lat: 26.8467, lng: 80.9462 },
    { id: "UT", name: "Uttarakhand", type: "state", city: "Dehradun", lat: 30.3165, lng: 78.0322 },
    { id: "WB", name: "West Bengal", type: "state", city: "Kolkata", lat: 22.5726, lng: 88.3639 },
    { id: "AN", name: "Andaman and Nicobar Islands", type: "union_territory", city: "Port Blair", lat: 11.6234, lng: 92.7265 },
    { id: "CH", name: "Chandigarh", type: "union_territory", city: "Chandigarh", lat: 30.7333, lng: 76.7794 },
    { id: "DH", name: "Dadra and Nagar Haveli and Daman and Diu", type: "union_territory", city: "Daman", lat: 20.3974, lng: 72.8328 },
    { id: "DL", name: "Delhi", type: "union_territory", city: "New Delhi", lat: 28.6139, lng: 77.2090 },
    { id: "JK", name: "Jammu and Kashmir", type: "union_territory", city: "Srinagar", lat: 34.0837, lng: 74.7973 },
    { id: "LA", name: "Ladakh", type: "union_territory", city: "Leh", lat: 34.1526, lng: 77.5771 },
    { id: "LD", name: "Lakshadweep", type: "union_territory", city: "Kavaratti", lat: 10.5667, lng: 72.6369 },
    { id: "PY", name: "Puducherry", type: "union_territory", city: "Puducherry", lat: 11.9416, lng: 79.8083 }
];
function getCacheTtlMinutes() {
    return Number.isFinite(Number(process.env.AQI_FORECAST_CACHE_TTL_MINUTES))
        ? Number(process.env.AQI_FORECAST_CACHE_TTL_MINUTES)
        : 30;
}
let cachedResponse = null;
let cachedResponseExpiresAt = 0;
let isRefreshing = false;
let refreshPromise = null;
async function fetchStateForecastsInternal() {
    const now = new Date();
    const ttlMinutes = getCacheTtlMinutes();
    const nextRefreshAt = new Date(now.getTime() + ttlMinutes * 60 * 1000).toISOString();
    const states = [];
    const providerSummary = { locallyForecast: 0, measuredOnly: 0, unavailable: 0 };
    // Concurrency control: batch of 3 requests at a time
    const batchSize = 3;
    for (let i = 0; i < INDIAN_STATES_AND_UTS.length; i += batchSize) {
        const batch = INDIAN_STATES_AND_UTS.slice(i, i + batchSize);
        const results = await Promise.allSettled(batch.map(async (st) => {
            const forecast = await getAqiForecast({ lat: st.lat, lng: st.lng });
            return { st, forecast };
        }));
        for (let ri = 0; ri < results.length; ri++) {
            const result = results[ri];
            if (result.status === "fulfilled") {
                const { st, forecast } = result.value;
                if (forecast.provider === "locally_forecast")
                    providerSummary.locallyForecast++;
                else {
                    const current = await getAirQuality(st.lat, st.lng);
                    if (current.status === "available")
                        providerSummary.measuredOnly++;
                    else
                        providerSummary.unavailable++;
                }
                // Only safely extract from AqiForecastResult
                const mappedForecast = {
                    id: st.id,
                    name: st.name,
                    type: st.type,
                    capitalOrReferenceCity: st.city,
                    lat: st.lat,
                    lng: st.lng,
                    provider: forecast.provider === "locally_forecast" ? "locally_forecast" : "unavailable",
                    latestAqi: forecast.latestAvailableAqi,
                    peakAqi: forecast.peakAqi,
                    averageAqi: forecast.averageAqi,
                    peakTime: forecast.peakTime,
                    category: forecast.categories?.["1h"] || forecast.hourly?.[0]?.category || "Unknown",
                    dominantPollutant: forecast.hourly?.[0]?.dominantPollutant,
                    trend: forecast.trend || "unknown",
                    spikeRisk: forecast.spikeRisk || "unknown",
                    predictions: forecast.predictions || {},
                    sourceNote: forecast.sourceNote || "",
                    confidenceNote: forecast.confidenceNote || "",
                    updatedAt: forecast.generatedAt || now.toISOString(),
                    nextRefreshAt,
                    reason: forecast.reason || forecast.spikeReason
                };
                states.push(mappedForecast);
            }
            else {
                // Fallback for unexpected failures in getAqiForecast
                const st = batch[ri];
                providerSummary.unavailable++;
                states.push({
                    id: st.id,
                    name: st.name,
                    type: st.type,
                    capitalOrReferenceCity: st.city,
                    lat: st.lat,
                    lng: st.lng,
                    provider: "unavailable",
                    trend: "unknown",
                    spikeRisk: "unknown",
                    predictions: {},
                    sourceNote: "Internal server error during fetch.",
                    confidenceNote: "No data available.",
                    updatedAt: now.toISOString(),
                    nextRefreshAt,
                    reason: "Fetch failed."
                });
            }
        }
        // Add a slight delay between batches to avoid rate limits
        if (i + batchSize < INDIAN_STATES_AND_UTS.length) {
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }
    return {
        generatedAt: now.toISOString(),
        nextRefreshAt,
        ttlMinutes,
        country: "India",
        total: states.length,
        providerSummary,
        states
    };
}
export async function getStateForecasts(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && cachedResponse && now < cachedResponseExpiresAt) {
        return cachedResponse;
    }
    if (isRefreshing && refreshPromise) {
        return refreshPromise;
    }
    isRefreshing = true;
    refreshPromise = fetchStateForecastsInternal().then(response => {
        cachedResponse = response;
        cachedResponseExpiresAt = Date.now() + (response.ttlMinutes * 60 * 1000);
        isRefreshing = false;
        refreshPromise = null;
        return response;
    }).catch(err => {
        isRefreshing = false;
        refreshPromise = null;
        if (cachedResponse)
            return cachedResponse; // Graceful fallback
        throw err;
    });
    return refreshPromise;
}
export function getStateForecastStatus() {
    return {
        stateForecastConfigured: true,
        stateForecastCacheTtlMinutes: getCacheTtlMinutes(),
        stateForecastLastGeneratedAt: cachedResponse?.generatedAt || null
    };
}
