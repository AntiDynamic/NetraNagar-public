import { validatePollutantSufficiency } from "./aqiRequirements.js";
const BREAKPOINTS = {
    "PM2.5": [[0, 30, 0, 50], [31, 60, 51, 100], [61, 90, 101, 200], [91, 120, 201, 300], [121, 250, 301, 400], [251, 500, 401, 500]],
    PM10: [[0, 50, 0, 50], [51, 100, 51, 100], [101, 250, 101, 200], [251, 350, 201, 300], [351, 430, 301, 400], [431, 1000, 401, 500]],
    NO2: [[0, 40, 0, 50], [41, 80, 51, 100], [81, 180, 101, 200], [181, 280, 201, 300], [281, 400, 301, 400], [401, 1000, 401, 500]],
    SO2: [[0, 40, 0, 50], [41, 80, 51, 100], [81, 380, 101, 200], [381, 800, 201, 300], [801, 1600, 301, 400], [1601, 2000, 401, 500]],
    CO: [[0, 1, 0, 50], [1.1, 2, 51, 100], [2.1, 10, 101, 200], [10.1, 17, 201, 300], [17.1, 34, 301, 400], [34.1, 100, 401, 500]],
    OZONE: [[0, 50, 0, 50], [51, 100, 51, 100], [101, 168, 101, 200], [169, 208, 201, 300], [209, 748, 301, 400], [749, 1000, 401, 500]],
    NH3: [[0, 200, 0, 50], [201, 400, 51, 100], [401, 800, 101, 200], [801, 1200, 201, 300], [1201, 1800, 301, 400], [1801, 2000, 401, 500]],
    PB: [[0, 0.5, 0, 50], [0.5, 1, 51, 100], [1.1, 2, 101, 200], [2.1, 3, 201, 300], [3.1, 3.5, 301, 400], [3.5, 10, 401, 500]]
};
export const INDIAN_AQI_SOURCE = {
    title: "About National Air Quality Index",
    source: "CPCB",
    url: "https://cpcb.nic.in/displaypdf.php?id=bmF0aW9uYWwtYWlyLXF1YWxpdHktaW5kZXgvQWJvdXRfQVFJLnBkZg",
    note: "CPCB identifies eight pollutants; PM, NH3 and Pb use 24-hour values, while CO and O3 use 8-hour values."
};
export function validateAqiCoverage(input) {
    const coveragePercent = input.expectedHourlySlots > 0 ? input.observedHourlySlots / input.expectedHourlySlots * 100 : 0;
    const minimum = input.minimumCoveragePercent ?? Number(process.env.AQI_MIN_COVERAGE_PERCENT || 75);
    return { valid: coveragePercent >= minimum, coveragePercent, minimumCoveragePercent: minimum, warnings: coveragePercent >= minimum ? [] : ["insufficient_hourly_coverage"] };
}
export function validateAqiPollutantRequirements(readings) {
    return validatePollutantSufficiency(readings.map((reading) => reading.pollutant));
}
export function calculatePollutantSubIndex(pollutant, value) {
    return subIndex(pollutant, value);
}
export function calculateProviderAverageAqi(readings) {
    const warnings = readings.flatMap((reading) => reading.averagingPeriodVerified ? [] : ["cpcb_average_period_unverified"]);
    if (warnings.length)
        return { subIndices: {}, status: "unverified_averaging_period", calculationType: "unavailable", isOfficial: false, averagingPeriodsVerified: false, coverageValidated: false, warnings, quality: "unavailable" };
    const result = calculateIndianAqi(readings);
    return { ...result, status: result.aqi === undefined ? "unavailable" : "available", calculationType: "provider_reported", isOfficial: true, averagingPeriodsVerified: true, coverageValidated: true, warnings: [], quality: "provider_reported" };
}
export function calculateRollingIndianAqi(readings) {
    const coverage = readings.map((reading) => ({ pollutant: reading.pollutant, ...validateAqiCoverage(reading.coverage) }));
    const invalid = coverage.filter((item) => !item.valid);
    const sufficiency = validateAqiPollutantRequirements(readings);
    const stationIds = [...new Set(readings.map((reading) => reading.stationId).filter(Boolean))];
    const warnings = [...new Set([...coverage.flatMap((item) => item.warnings), ...sufficiency.warnings])];
    if (stationIds.length > 1)
        warnings.push("multiple_physical_stations");
    if (invalid.length)
        return { subIndices: {}, status: "insufficient_coverage", calculationType: "unavailable", isOfficial: false, averagingPeriodsVerified: true, coverageValidated: false, warnings: [...new Set(warnings)], calculationTrace: { coverage, sufficiency }, quality: "unavailable" };
    if (!sufficiency.valid || stationIds.length > 1)
        return { subIndices: {}, status: "insufficient_pollutants", calculationType: "unavailable", isOfficial: false, averagingPeriodsVerified: true, coverageValidated: false, warnings: [...new Set(warnings)], calculationTrace: { coverage, sufficiency }, quality: "unavailable" };
    const result = calculateIndianAqi(readings);
    return { ...result, status: result.aqi === undefined ? "insufficient_pollutants" : "available", calculationType: "rolling_history_calculated", isOfficial: false, averagingPeriodsVerified: true, coverageValidated: true, warnings: [...new Set(warnings)], calculationTrace: { coverage, sufficiency }, quality: result.aqi === undefined ? "unavailable" : "rolling_validated" };
}
export function calculateIndicativeCpcbAqi(readings) {
    const eligible = readings.filter((reading) => reading.valueKind === "average" && reading.unitCompatible !== false && (reading.freshness === "fresh" || reading.freshness === "usable") && Boolean(reading.measuredAt) && Number.isFinite(reading.value) && reading.value >= 0);
    const sufficiency = validateAqiPollutantRequirements(eligible);
    const stationIds = [...new Set(eligible.map((reading) => reading.stationId).filter(Boolean))];
    const warnings = ["cpcb_average_period_unverified"];
    if (!sufficiency.valid)
        warnings.push(...sufficiency.warnings);
    if (stationIds.length > 1)
        warnings.push("multiple_physical_stations");
    if (!sufficiency.valid || stationIds.length > 1) {
        return { subIndices: {}, status: "insufficient_pollutants", calculationType: "reported_average_estimate", isOfficial: false, averagingPeriodsVerified: false, coverageValidated: false, warnings: [...new Set(warnings)], calculationTrace: { sufficiency, eligibleCount: eligible.length }, quality: "indicative" };
    }
    const result = calculateIndianAqi(eligible);
    return { ...result, status: result.aqi === undefined ? "unavailable" : "available", calculationType: "reported_average_estimate", isOfficial: false, averagingPeriodsVerified: false, coverageValidated: false, warnings: [...new Set(warnings)], calculationTrace: { sufficiency, eligible }, quality: result.aqi === undefined ? "unavailable" : "indicative" };
}
export function aqiCategory(aqi) {
    if (!Number.isFinite(aqi))
        return undefined;
    if (aqi <= 50)
        return "Good";
    if (aqi <= 100)
        return "Satisfactory";
    if (aqi <= 200)
        return "Moderate";
    if (aqi <= 300)
        return "Poor";
    if (aqi <= 400)
        return "Very Poor";
    return "Severe";
}
export function subIndex(pollutant, value) {
    if (!Number.isFinite(value) || value < 0)
        return undefined;
    const bracket = BREAKPOINTS[pollutant].find(([low, high]) => value >= low && value <= high);
    if (!bracket)
        return value > 500 ? 500 : undefined;
    const [clow, chigh, ilow, ihigh] = bracket;
    return Math.round(((ihigh - ilow) / (chigh - clow)) * (value - clow) + ilow);
}
export function calculateIndianAqi(readings) {
    const subIndices = Object.fromEntries(readings.flatMap((reading) => {
        const index = subIndex(reading.pollutant, reading.value);
        return index === undefined ? [] : [[reading.pollutant, index]];
    }));
    const entries = Object.entries(subIndices);
    if (!entries.length)
        return { subIndices, reason: "AQI requires valid pollutant averages with compatible units." };
    const [dominantPollutant, aqi] = entries.sort((a, b) => b[1] - a[1])[0];
    return { aqi: Math.min(500, aqi), category: aqiCategory(aqi), dominantPollutant, subIndices };
}
