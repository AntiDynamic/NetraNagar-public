export function classifySatelliteEventSuitability(type) {
    switch (type) {
        case "industrial_smoke": return { suitability: "partially_suitable", reason: "A broad plume may be visible near the report time, but small or short-lived emissions may not be resolved.", recommendedAoiRadiusMeters: 1000, maximumUsefulTemporalOffsetHours: 72 };
        case "garbage_burning": return { suitability: "partially_suitable", reason: "A small fire may be invisible; a broad plume or persistent burn-surface change may be visible.", recommendedAoiRadiusMeters: 800, maximumUsefulTemporalOffsetHours: 72 };
        case "construction_dust": return { suitability: "partially_suitable", reason: "Large exposed surfaces may be visible, while short-lived dust is difficult to observe overhead.", recommendedAoiRadiusMeters: 800, maximumUsefulTemporalOffsetHours: 168 };
        case "open_waste":
        case "illegal_dumping": return { suitability: "partially_suitable", reason: "Only large, persistent dumping or waste areas are likely to be visible at Sentinel-2 resolution.", recommendedAoiRadiusMeters: 1000, maximumUsefulTemporalOffsetHours: 720 };
        case "water_pollution": return { suitability: "partially_suitable", reason: "Large visible surface changes may be observable, but water quality cannot be inferred from colour alone.", recommendedAoiRadiusMeters: 1000, maximumUsefulTemporalOffsetHours: 720 };
        case "road_dust": return { suitability: "not_suitable", reason: "Ordinary street dust is normally too small or temporary for Sentinel-2 context.", recommendedAoiRadiusMeters: 500 };
        case "vehicle_smoke": return { suitability: "not_suitable", reason: "Individual vehicle exhaust is below useful Sentinel-2 resolution and persistence.", recommendedAoiRadiusMeters: 500 };
        case "stagnant_water":
        case "sewage_overflow": return { suitability: "not_suitable", reason: "Small stagnant-water or sewage events are usually not observable unless they affect a large surface area.", recommendedAoiRadiusMeters: 700 };
        default: return { suitability: "partially_suitable", reason: "The event type is uncertain, so satellite context can only be exploratory and limited.", recommendedAoiRadiusMeters: 500 };
    }
}
