function normalize(value) {
    return (value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}
function similarity(a, b) {
    const left = normalize(a);
    const right = normalize(b);
    if (!left || !right)
        return 0;
    if (left === right)
        return 1;
    if (left.includes(right) || right.includes(left))
        return 0.85;
    const shared = [...new Set(left.split("").filter((char) => right.includes(char)))].length;
    return shared / Math.max(left.length, right.length);
}
export function matchPhysicalStations(cpcb, openaq, distanceMeters) {
    const nameSimilarity = similarity(cpcb.name, openaq.name);
    const localityMatch = Boolean(cpcb.city && openaq.city && normalize(cpcb.city) === normalize(openaq.city));
    const strong = distanceMeters <= 500 && nameSimilarity >= 0.6;
    const possible = distanceMeters <= 1000 && nameSimilarity >= 0.8 && localityMatch;
    if (!strong && !possible)
        return null;
    return {
        physicalStationId: `physical:${normalize(cpcb.name)}:${cpcb.lat.toFixed(4)}:${cpcb.lng.toFixed(4)}`,
        confidence: strong ? "high" : "medium",
        distanceMeters,
        nameSimilarity,
        reasons: [strong ? "station_name_and_coordinate_match" : "strong_name_locality_match", `${Math.round(distanceMeters)}m_apart`]
    };
}
