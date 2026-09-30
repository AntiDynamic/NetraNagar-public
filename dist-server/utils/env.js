export function validateEnv() {
    if (!process.env.GEMINI_API_KEY)
        console.warn("GEMINI_API_KEY is missing. Report verification requests will return a controlled unavailable response.");
    if (!process.env.DATA_GOV_API_KEY)
        console.warn("DATA_GOV_API_KEY is missing. CPCB/data.gov.in fallback will be skipped.");
    if (!process.env.OPENAQ_API_KEY)
        console.warn("OPENAQ_API_KEY is missing. OpenAQ supplementary station context will be skipped.");
    if (process.env.ENABLE_EARTH_ENGINE === "true" && !process.env.GOOGLE_CLOUD_PROJECT && !process.env.GCLOUD_PROJECT)
        console.warn("ENABLE_EARTH_ENGINE is true but GOOGLE_CLOUD_PROJECT is missing. Satellite context will be unavailable.");
    const defaults = {
        OPENAQ_BASE_URL: "https://api.openaq.org/v3", OPENAQ_LOCATION_CACHE_TTL_MINUTES: "1440", OPENAQ_LATEST_CACHE_TTL_MINUTES: "10", OPENAQ_HISTORY_CACHE_TTL_MINUTES: "60",
        AQI_CURRENT_CACHE_TTL_MINUTES: "10", AQI_FORECAST_CACHE_TTL_MINUTES: "30", AQI_SEARCH_RADIUS_KM: "25", AQI_FRESH_HOURS: "3", AQI_USABLE_HOURS: "12", AQI_MAX_AGE_HOURS: "24", AQI_HISTORY_DAYS: "7", AQI_FORECAST_MIN_HISTORY_HOURS: "72",
        CPCB_CACHE_TTL_MINUTES: "60", CPCB_PAGE_LIMIT: "1000", CPCB_MAX_PAGES: "25", CPCB_RESOURCE_ID: "3b01bcb8-0b14-4abf-b6f2-c1bfd384ba69",
        GEMINI_TIMEOUT_MS: "45000", GEMINI_MAX_RETRIES: "2", GEMINI_THINKING_BUDGET: "0", API_RATE_LIMIT_PER_HOUR: process.env.NODE_ENV === "production" ? "300" : "500", REPORT_RATE_LIMIT_PER_HOUR: process.env.NODE_ENV === "production" ? "30" : "60", AI_RATE_LIMIT_PER_HOUR: "30", PORT: "8787"
    };
    for (const [key, value] of Object.entries(defaults))
        if (!process.env[key])
            process.env[key] = value;
}
