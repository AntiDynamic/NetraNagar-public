import { distanceMeters } from "../utils/geo.js";
const DEFAULT_RADIUS_METERS = 900;
const cache = new Map();
function enabled(name) { return process.env[name]?.toLowerCase() === "true"; }
function timeoutMs() { const parsed = Number(process.env.SURROUNDINGS_TIMEOUT_MS || 5000); return Number.isFinite(parsed) ? Math.max(500, Math.min(parsed, 10000)) : 5000; }
function ttlMs() { const parsed = Number(process.env.SURROUNDINGS_CACHE_TTL_MINUTES || 360); return (Number.isFinite(parsed) ? Math.max(5, parsed) : 360) * 60_000; }
function failureTtlMs() { const parsed = Number(process.env.SURROUNDINGS_FAILURE_CACHE_TTL_SECONDS || 60); return (Number.isFinite(parsed) ? Math.max(5, Math.min(parsed, 300)) : 60) * 1000; }
function key(lat, lng, pollutionType) { return `${lat.toFixed(3)}:${lng.toFixed(3)}:${pollutionType || "unclear"}`; }
function placeType(types = []) {
    for (const value of ["preschool", "primary_school", "general_hospital", "medical_center", "school", "hospital"])
        if (types.includes(value))
            return value;
    return null;
}
function weight(type) { return ({ preschool: 1, primary_school: .95, school: .9, hospital: 1, general_hospital: 1, medical_center: .8, other_sensitive: .75 })[type]; }
function relevance(type, pollutionType) {
    if (pollutionType === "road_dust")
        return type.includes("hospital") || type === "medical_center" ? .85 : .8;
    if (pollutionType === "illegal_dumping")
        return type.includes("school") || type === "preschool" ? 1 : .75;
    return 1;
}
export function calculateCommunityExposureScore(places, radius = DEFAULT_RADIUS_METERS, pollutionType) {
    const values = places.map((place) => Math.max(0, 1 - place.distanceMeters / radius) * place.sensitivityWeight * relevance(place.type, pollutionType) * 100).sort((a, b) => b - a);
    if (!values.length)
        return 0;
    return Math.min(100, Math.round(values[0] + values.slice(1, 5).reduce((sum, value, index) => sum + value * (.22 / (index + 1)), 0)));
}
function contextualize(places, provider, pollutionType, warnings) {
    const sorted = [...new Map(places.sort((a, b) => a.distanceMeters - b.distanceMeters).map((place) => [`${place.id || ""}:${place.name}:${place.type}`, place])).values()];
    const nearestSchool = sorted.find((p) => ["school", "preschool", "primary_school"].includes(p.type));
    const nearestHospital = sorted.find((p) => ["hospital", "general_hospital", "medical_center"].includes(p.type));
    const reasons = [
        ...(nearestSchool ? [`${nearestSchool.type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())} ${Math.round(nearestSchool.distanceMeters)} m from incident`] : []),
        ...(nearestHospital ? [`${nearestHospital.type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())} ${Math.round(nearestHospital.distanceMeters)} m from incident`] : []),
        ...(sorted.length > 1 ? [`${sorted.length} sensitive locations detected within ${DEFAULT_RADIUS_METERS} m`] : [])
    ];
    return { status: sorted.length ? "ready" : "partial", provider, generatedAt: new Date().toISOString(), searchRadiusMeters: DEFAULT_RADIUS_METERS, sensitivePlaces: sorted, nearestSchool, nearestHospital, sensitivePlaceCount: sorted.length, communityExposureScore: calculateCommunityExposureScore(sorted, DEFAULT_RADIUS_METERS, pollutionType), reasons: sorted.length ? reasons : ["No sensitive locations found within the search area."], ...(warnings?.length ? { warnings } : {}) };
}
function unavailable(warning) {
    return { status: "unavailable", provider: "none", generatedAt: new Date().toISOString(), searchRadiusMeters: DEFAULT_RADIUS_METERS, sensitivePlaces: [], sensitivePlaceCount: 0, communityExposureScore: 0, reasons: [], warnings: [warning] };
}
async function googlePlaces(lat, lng, pollutionType) {
    const apiKey = process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_SERVER_API_KEY;
    if (!apiKey || !enabled("ENABLE_GOOGLE_PLACES"))
        return unavailable("Google Places is not enabled or configured.");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs());
    try {
        const response = await fetch("https://places.googleapis.com/v1/places:searchNearby", {
            method: "POST", signal: controller.signal,
            headers: { "Content-Type": "application/json", "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": "places.id,places.displayName,places.types,places.location" },
            body: JSON.stringify({ includedTypes: ["school", "primary_school", "preschool", "hospital", "general_hospital", "medical_center"], maxResultCount: 20, locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius: DEFAULT_RADIUS_METERS } } })
        });
        if (!response.ok)
            return unavailable(`Google Places lookup unavailable (${response.status}).`);
        const payload = await response.json();
        const places = (payload.places || []).flatMap((item) => {
            const type = placeType(item.types);
            const placeLat = item.location?.latitude;
            const placeLng = item.location?.longitude;
            if (!type || !Number.isFinite(placeLat) || !Number.isFinite(placeLng))
                return [];
            return [{ id: item.id, name: item.displayName?.text || "Sensitive location", type, lat: placeLat, lng: placeLng, distanceMeters: distanceMeters(lat, lng, placeLat, placeLng), sensitivityWeight: weight(type), source: "google_places" }];
        }).filter((item) => item.distanceMeters <= DEFAULT_RADIUS_METERS);
        return contextualize(places, "google_places", pollutionType);
    }
    catch (error) {
        return unavailable(error instanceof Error && error.name === "AbortError" ? "Google Places lookup timed out." : "Google Places network lookup failed.");
    }
    finally {
        clearTimeout(timer);
    }
}
function demoContext(pollutionType) {
    return contextualize([
        { id: "demo-school", name: "Demo Public School", type: "school", distanceMeters: 140, sensitivityWeight: .9, source: "demo" },
        { id: "demo-hospital", name: "Demo Community Hospital", type: "hospital", distanceMeters: 420, sensitivityWeight: 1, source: "demo" }
    ], "demo", pollutionType);
}
export async function getSurroundingContext(input) {
    const cacheKey = key(input.lat, input.lng, input.pollutionType);
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now())
        return { ...cached.value, generatedAt: new Date().toISOString() };
    let value;
    if (enabled("ENABLE_GOOGLE_PLACES") && (process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_SERVER_API_KEY))
        value = await googlePlaces(input.lat, input.lng, input.pollutionType);
    else if (enabled("ENABLE_DEMO_SURROUNDING_CONTEXT"))
        value = demoContext(input.pollutionType);
    else
        value = unavailable(enabled("ENABLE_OSM_SURROUNDINGS") ? "OSM surroundings fallback is enabled but not configured in this build." : "Sensitive-surroundings provider is unavailable.");
    cache.set(cacheKey, { expiresAt: Date.now() + (value.status === "unavailable" ? failureTtlMs() : ttlMs()), value });
    return value;
}
export function getSurroundingContextStatus() { return { googlePlacesConfigured: Boolean(process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_SERVER_API_KEY), surroundingContextProvider: enabled("ENABLE_GOOGLE_PLACES") ? "google_places" : enabled("ENABLE_DEMO_SURROUNDING_CONTEXT") ? "demo" : "none", googlePlacesEnabled: enabled("ENABLE_GOOGLE_PLACES"), osmFallback: "unsupported_not_implemented", demoProviderEnabled: enabled("ENABLE_DEMO_SURROUNDING_CONTEXT") }; }
