import { distanceMeters } from "../utils/geo.js";
const disclaimer = "General public guidance only, not medical advice.";
const guidance = {
    garbage_burning: {
        healthConcerns: ["Smoke may irritate eyes, throat, and lungs", "Sensitive people may experience breathing discomfort"],
        citizenAdvice: ["Avoid standing near smoke", "Keep children and elderly away", "Use alternate route if smoke is heavy"],
        municipalActions: ["Stop active burning", "Clear waste pile", "Increase collection frequency"],
        reductionMeasures: ["Add no-burning signage", "Monitor repeated dumping/burning point"]
    },
    road_dust: {
        healthConcerns: ["Dust may irritate eyes and throat", "Breathing discomfort may increase for sensitive people"],
        citizenAdvice: ["Avoid dusty road edge", "Use alternate route during heavy dust"],
        municipalActions: ["Water sprinkling", "Remove loose debris", "Repair broken road patch"],
        reductionMeasures: ["Cover roadside soil/debris", "Regular sweeping", "Enforce material covering"]
    },
    construction_dust: {
        healthConcerns: ["Dust may irritate eyes and throat", "Sensitive people may experience breathing discomfort"],
        citizenAdvice: ["Avoid dusty road edge", "Keep windows closed near heavy dust"],
        municipalActions: ["Inspect construction site", "Enforce dust screens", "Ensure sand/cement covering", "Water sprinkling"],
        reductionMeasures: ["Cover construction material", "Clean road near site", "Use dust barriers"]
    },
    vehicle_smoke: {
        healthConcerns: ["Smoke may irritate eyes, throat, and lungs", "Sensitive people may experience breathing discomfort"],
        citizenAdvice: ["Avoid standing near visible exhaust", "Use alternate route if smoke is heavy"],
        municipalActions: ["Flag high-smoke vehicle zone", "Reduce idling", "Traffic enforcement check"],
        reductionMeasures: ["No-idling awareness", "Improve traffic flow", "Emission check drive"]
    },
    industrial_smoke: {
        healthConcerns: ["Fumes may irritate eyes, throat, and lungs", "Sensitive people may experience breathing discomfort"],
        citizenAdvice: ["Avoid standing near fumes", "Report repeated visible emissions"],
        municipalActions: ["Inspect industrial outlet", "Check emission compliance", "Escalate repeated visible smoke"],
        reductionMeasures: ["Monitor outlet", "Require mitigation at source", "Improve buffer management"]
    },
    open_waste: {
        healthConcerns: ["Waste may attract pests and cause odor", "Smoke risk increases if waste is burned"],
        citizenAdvice: ["Avoid touching waste", "Keep children away from dumping point"],
        municipalActions: ["Clear waste", "Identify repeat dumping source", "Increase bin/collection availability"],
        reductionMeasures: ["Add collection point", "Add signage", "Monitor repeat dumping time"]
    },
    illegal_dumping: {
        healthConcerns: ["Waste may attract pests and cause odor", "Sharp or contaminated waste may be present"],
        citizenAdvice: ["Avoid touching waste", "Keep children away from dumping point"],
        municipalActions: ["Clear waste", "Identify repeat dumping source", "Increase bin/collection availability"],
        reductionMeasures: ["Add collection point", "Add signage", "Monitor repeat dumping time"]
    },
    stagnant_water: {
        healthConcerns: ["Bad odor and contamination exposure possible", "Mosquito breeding risk possible in stagnant water"],
        citizenAdvice: ["Avoid contact with water", "Keep children away"],
        municipalActions: ["Inspect drainage", "Clear blockage", "Disinfect/clean area", "Fix overflow source"],
        reductionMeasures: ["Regular drain cleaning", "Prevent garbage entering drain"]
    },
    sewage_overflow: {
        healthConcerns: ["Bad odor and contamination exposure possible", "Mosquito breeding risk possible in stagnant water"],
        citizenAdvice: ["Avoid contact with water", "Keep children away"],
        municipalActions: ["Inspect drainage", "Clear blockage", "Disinfect/clean area", "Fix overflow source"],
        reductionMeasures: ["Regular drain cleaning", "Prevent garbage entering drain"]
    },
    water_pollution: {
        healthConcerns: ["Bad odor and contamination exposure possible", "Mosquito breeding risk possible in stagnant water"],
        citizenAdvice: ["Avoid contact with water", "Keep children away"],
        municipalActions: ["Inspect drainage", "Clear blockage", "Disinfect/clean area", "Fix overflow source"],
        reductionMeasures: ["Regular drain cleaning", "Prevent garbage entering drain"]
    },
    unclear: {
        healthConcerns: ["Possible local nuisance or exposure risk needs review"],
        citizenAdvice: ["Avoid direct contact with the suspected hotspot", "Submit a clearer follow-up photo if safe"],
        municipalActions: ["Manual site inspection", "Confirm pollution source"],
        reductionMeasures: ["Track repeat reports", "Address confirmed source"]
    },
    not_pollution: {
        healthConcerns: ["No pollution-specific concern identified"],
        citizenAdvice: ["No action needed unless visible pollution appears"],
        municipalActions: ["No municipal pollution action suggested"],
        reductionMeasures: ["Monitor if new evidence appears"]
    }
};
function causeFor(type) {
    return type.replace(/_/g, " ");
}
export function buildRiskAdvisor(input) {
    const type = input.report.gemini.pollution_type;
    const recentNearby = input.nearbyReports.filter((report) => report.id !== input.report.id &&
        Date.now() - new Date(report.createdAt).getTime() < 7 * 24 * 60 * 60 * 1000 &&
        distanceMeters(input.report.lat, input.report.lng, report.lat, report.lng) <= 250);
    const priorityReasons = [
        `Evidence score ${input.report.evidenceScore}/100`,
        `Hotspot score ${input.report.hotspotScore}/100`,
        input.report.airQuality.aqi ? `AQI context ${input.report.airQuality.aqi}` : "AQI context attached when available"
    ];
    if (recentNearby.length)
        priorityReasons.push(`${recentNearby.length} related report${recentNearby.length === 1 ? "" : "s"} nearby`);
    const surroundings = input.report.surroundingContext;
    if (surroundings && surroundings.status !== "unavailable") {
        priorityReasons.push(`Community exposure ${surroundings.communityExposureScore}/100`);
        priorityReasons.push(...surroundings.reasons.slice(0, 3));
        if (surroundings.communityExposureScore >= 60)
            priorityReasons.push("High community exposure near vulnerable locations");
    }
    else {
        priorityReasons.push("Sensitive-surroundings context unavailable");
    }
    return {
        likelyCause: causeFor(type),
        causeConfidence: input.report.evidenceScore >= 75 ? "high" : input.report.evidenceScore >= 50 ? "medium" : "low",
        ...(guidance[type] || guidance.unclear),
        recurringHotspot: {
            isRecurring: recentNearby.length + 1 >= 3,
            reportCount7d: recentNearby.length + 1,
            radiusMeters: 250,
            dominantIssue: causeFor(type),
            recommendation: recentNearby.length + 1 >= 3
                ? `Repeated ${causeFor(type)} reports found within 250m. Prioritize source control and follow-up inspection.`
                : "Monitor for repeated reports before escalating as a recurring hotspot."
        },
        priorityReasons,
        disclaimer
    };
}
