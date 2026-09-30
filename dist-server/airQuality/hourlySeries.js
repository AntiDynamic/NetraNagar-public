import { averagingHoursFor, minimumWindowObservations } from "./aqiRequirements.js";
const HOUR_MS = 3_600_000;
function hourStart(timestamp) {
    return Math.floor(timestamp / HOUR_MS) * HOUR_MS;
}
export function dedupeHourlySeries(points) {
    const byHour = new Map();
    for (const point of points) {
        const timestamp = Date.parse(point.dateTime);
        if (!Number.isFinite(timestamp) || !Number.isFinite(point.value) || point.value < 0 || !point.unitCompatible)
            continue;
        const key = hourStart(timestamp);
        const existing = byHour.get(key);
        if (!existing || Date.parse(existing.dateTime) < timestamp) {
            byHour.set(key, { ...point, dateTime: new Date(timestamp).toISOString() });
        }
    }
    return [...byHour.values()].sort((a, b) => a.dateTime.localeCompare(b.dateTime));
}
export function buildRollingWindow(pollutant, input, options = {}) {
    const averagingHours = averagingHoursFor(pollutant);
    const expectedHourlySlots = averagingHours;
    const clean = dedupeHourlySeries(input);
    const latestTimestamp = clean.length ? Date.parse(clean.at(-1).dateTime) : NaN;
    const endTimestamp = options.endAt ? Date.parse(options.endAt) : latestTimestamp;
    if (!Number.isFinite(endTimestamp)) {
        return {
            pollutant,
            windowStart: "",
            windowEnd: "",
            averagingHours,
            expectedHourlySlots,
            observedHourlySlots: 0,
            interpolatedHourlySlots: 0,
            missingHourlySlots: expectedHourlySlots,
            coveragePercent: 0,
            latestAgeHours: undefined,
            valid: false,
            invalidReasons: ["timestamp_unknown", "rolling_average_unavailable"],
            points: []
        };
    }
    const endHour = hourStart(endTimestamp);
    const startHour = endHour - (expectedHourlySlots - 1) * HOUR_MS;
    const windowStart = new Date(startHour).toISOString();
    const windowEnd = new Date(endHour).toISOString();
    const invalidReasons = [];
    if (!Number.isFinite(endTimestamp))
        invalidReasons.push("timestamp_unknown");
    const referenceNow = options.endAt ? Date.parse(options.endAt) : Date.now();
    const latestAgeHours = Number.isFinite(latestTimestamp) ? Math.max(0, (referenceNow - latestTimestamp) / HOUR_MS) : undefined;
    if (options.maxAgeHours !== undefined && latestAgeHours !== undefined && latestAgeHours > options.maxAgeHours) {
        invalidReasons.push("stale_or_expired_history");
    }
    const values = new Map();
    const points = clean.filter((point) => {
        const timestamp = hourStart(Date.parse(point.dateTime));
        return timestamp >= startHour && timestamp <= endHour;
    });
    for (const point of points)
        values.set(hourStart(Date.parse(point.dateTime)), point.value);
    let observedHourlySlots = values.size;
    let interpolatedHourlySlots = 0;
    const maxGap = Math.max(0, Math.floor(options.maxInterpolatedGapHours ?? 2));
    for (let index = 0; index < expectedHourlySlots; index += 1) {
        const slot = startHour + index * HOUR_MS;
        if (values.has(slot))
            continue;
        let previous = index - 1;
        while (previous >= 0 && !values.has(startHour + previous * HOUR_MS))
            previous -= 1;
        let next = index + 1;
        while (next < expectedHourlySlots && !values.has(startHour + next * HOUR_MS))
            next += 1;
        const gap = next - previous - 1;
        if (previous >= 0 && next < expectedHourlySlots && gap <= maxGap) {
            const previousValue = values.get(startHour + previous * HOUR_MS);
            const nextValue = values.get(startHour + next * HOUR_MS);
            values.set(slot, previousValue + (nextValue - previousValue) * ((index - previous) / (next - previous)));
            interpolatedHourlySlots += 1;
        }
    }
    const missingHourlySlots = expectedHourlySlots - values.size;
    const coveragePercent = expectedHourlySlots ? values.size / expectedHourlySlots * 100 : 0;
    if (observedHourlySlots < minimumWindowObservations(pollutant))
        invalidReasons.push("insufficient_observed_hours");
    if (missingHourlySlots > 0)
        invalidReasons.push("long_or_unfillable_gap");
    if (coveragePercent < 75)
        invalidReasons.push("insufficient_hourly_coverage");
    const rollingValues = [...values.values()];
    const rollingConcentration = rollingValues.length === expectedHourlySlots
        ? rollingValues.reduce((sum, value) => sum + value, 0) / rollingValues.length
        : undefined;
    if (rollingConcentration === undefined)
        invalidReasons.push("rolling_average_unavailable");
    return {
        pollutant,
        windowStart,
        windowEnd,
        averagingHours,
        expectedHourlySlots,
        observedHourlySlots,
        interpolatedHourlySlots,
        missingHourlySlots,
        coveragePercent,
        rollingConcentration,
        latestAgeHours,
        valid: invalidReasons.length === 0,
        invalidReasons: [...new Set(invalidReasons)],
        points
    };
}
