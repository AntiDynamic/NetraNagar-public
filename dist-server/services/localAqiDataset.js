// Fixed demonstration fallback used only while live monitoring providers return no AQI points.
const DATASET = [
    ["New Delhi", "Delhi", "Delhi", 28.6139, 77.2090, 168], ["Anand Vihar", "Delhi", "Delhi", 28.6469, 77.3160, 176], ["Rohini", "Delhi", "Delhi", 28.7495, 77.0670, 151], ["Dwarka", "Delhi", "Delhi", 28.5921, 77.0460, 146],
    ["Amritsar", "Punjab", "Punjab", 31.6340, 74.8723, 126], ["Gurugram", "Haryana", "Haryana", 28.4595, 77.0266, 158], ["Jaipur", "Rajasthan", "Rajasthan", 26.9124, 75.7873, 118], ["Lucknow", "Uttar Pradesh", "Uttar Pradesh", 26.8467, 80.9462, 143], ["Kanpur", "Uttar Pradesh", "Uttar Pradesh", 26.4499, 80.3319, 161], ["Varanasi", "Uttar Pradesh", "Uttar Pradesh", 25.3176, 82.9739, 132],
    ["Ahmedabad", "Gujarat", "Gujarat", 23.0225, 72.5714, 109], ["Mumbai", "Maharashtra", "Maharashtra", 19.0760, 72.8777, 94], ["Andheri", "Maharashtra", "Maharashtra", 19.1197, 72.8468, 101], ["Navi Mumbai", "Maharashtra", "Maharashtra", 19.0330, 73.0297, 88], ["Pune", "Maharashtra", "Maharashtra", 18.5204, 73.8567, 76], ["Pimpri-Chinchwad", "Maharashtra", "Maharashtra", 18.6298, 73.7997, 82], ["Hadapsar", "Maharashtra", "Maharashtra", 18.5089, 73.9260, 71],
    ["Bhopal", "Madhya Pradesh", "Madhya Pradesh", 23.2599, 77.4126, 79], ["Kolkata", "West Bengal", "West Bengal", 22.5726, 88.3639, 103], ["Patna", "Bihar", "Bihar", 25.5941, 85.1376, 149], ["Bhubaneswar", "Odisha", "Odisha", 20.2961, 85.8245, 68], ["Guwahati", "Assam", "Assam", 26.1445, 91.7362, 61],
    ["Bengaluru", "Karnataka", "Karnataka", 12.9716, 77.5946, 58], ["Whitefield", "Karnataka", "Karnataka", 12.9698, 77.7500, 64], ["Electronic City", "Karnataka", "Karnataka", 12.8452, 77.6602, 52], ["Hyderabad", "Telangana", "Telangana", 17.3850, 78.4867, 71], ["Vijayawada", "Andhra Pradesh", "Andhra Pradesh", 16.5062, 80.6480, 78], ["Chennai", "Tamil Nadu", "Tamil Nadu", 13.0827, 80.2707, 66], ["Kochi", "Kerala", "Kerala", 9.9312, 76.2673, 49]
];
function category(aqi) {
    return aqi <= 50 ? "Good" : aqi <= 100 ? "Satisfactory" : aqi <= 200 ? "Moderate" : aqi <= 300 ? "Poor" : aqi <= 400 ? "Very poor" : "Severe";
}
export function getLocalAqiDataset() {
    return DATASET.map(([label, city, state, lat, lng, aqi]) => ({
        id: `local-aqi:${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
        physicalStationId: `local-aqi:${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
        name: label, label, city, state, lat, lng, provider: "locally_forecast", sourceLabel: "Local AQI demonstration dataset",
        metrics: { aqi }, units: { aqi: "AQI" }, aqi, category: category(aqi), aqiQuality: "indicative",
        aqiStatus: { selected: { value: aqi, quality: "indicative", category: category(aqi), dominantPollutant: "PM2.5", calculationType: "reported_average_estimate", isOfficial: false, averagingPeriodsVerified: false, coverageValidated: false, warnings: ["Temporary local demonstration data; not a live monitoring-station reading."] }, status: "indicative_available", warnings: ["Temporary local demonstration data; not a live monitoring-station reading."] },
        availability: { available: 1, supported: 1, label: "AQI available" }, note: "Temporary fixed local AQI dataset."
    }));
}
