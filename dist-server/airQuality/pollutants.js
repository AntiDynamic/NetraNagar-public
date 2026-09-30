export const POLLUTANT_ORDER = ["PM2.5", "PM10", "NO2", "SO2", "CO", "OZONE", "NH3", "PB"];
export const POLLUTANT_UNITS = {
    "PM2.5": "µg/m³",
    PM10: "µg/m³",
    NO2: "µg/m³",
    SO2: "µg/m³",
    CO: "mg/m³",
    OZONE: "µg/m³",
    NH3: "µg/m³",
    PB: "µg/m³"
};
export function normalizePollutant(value) {
    const normalized = String(value ?? "").trim().toLowerCase().replace(/[._\s-]/g, "");
    if (normalized === "pm25" || normalized === "pm2.5")
        return "PM2.5";
    if (normalized === "pm10")
        return "PM10";
    if (normalized === "no2")
        return "NO2";
    if (normalized === "so2")
        return "SO2";
    if (normalized === "co")
        return "CO";
    if (normalized === "o3" || normalized === "ozone")
        return "OZONE";
    if (normalized === "nh3")
        return "NH3";
    if (normalized === "pb" || normalized === "lead")
        return "PB";
    return undefined;
}
export function normalizeUnit(value) {
    return String(value ?? "").trim().toLowerCase().replace(/μ/g, "µ").replace(/³/g, "3").replace(/\s+/g, "");
}
export function isCompatibleUnit(pollutant, unit) {
    const normalized = normalizeUnit(unit);
    if (pollutant === "CO")
        return normalized === "mg/m3" || normalized === "mg/m^3";
    return normalized === "µg/m3" || normalized === "ug/m3" || normalized === "µg/m^3" || normalized === "ug/m^3";
}
export function canonicalUnit(pollutant) {
    return POLLUTANT_UNITS[pollutant];
}
