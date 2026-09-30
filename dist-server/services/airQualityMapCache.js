import fs from "node:fs";
import path from "node:path";
const cachePath = path.join(process.cwd(), ".cache", "air-quality", "map.json");
let writeTimer;
export function loadAirQualityMapCache() {
    if (process.env.NODE_ENV === "production" || process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME)
        return undefined;
    try {
        const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8"));
        if (parsed.version !== 1 || !parsed.map || !Array.isArray(parsed.map.points))
            return undefined;
        return parsed.map;
    }
    catch {
        return undefined;
    }
}
export function saveAirQualityMapCache(map) {
    if (process.env.NODE_ENV === "production" || process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME)
        return;
    if (!map.points.some((point) => typeof point.metrics.aqi === "number" && Number.isFinite(point.metrics.aqi)))
        return;
    if (writeTimer)
        clearTimeout(writeTimer);
    writeTimer = setTimeout(() => {
        try {
            fs.mkdirSync(path.dirname(cachePath), { recursive: true });
            const temp = `${cachePath}.${process.pid}.tmp`;
            fs.writeFileSync(temp, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), map }));
            fs.renameSync(temp, cachePath);
        }
        catch { /* cache is optional; never disrupt live data */ }
    }, 250);
}
