export function distanceMeters(aLat, aLng, bLat, bLng) {
    const radius = 6371000;
    const toRad = (value) => (value * Math.PI) / 180;
    const dLat = toRad(bLat - aLat);
    const dLng = toRad(bLng - aLng);
    const h = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
    return 2 * radius * Math.asin(Math.sqrt(h));
}
