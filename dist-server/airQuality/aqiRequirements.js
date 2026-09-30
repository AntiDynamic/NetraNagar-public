export const CPCB_AQI_REQUIREMENTS = {
    minimumPollutants: 3,
    mandatoryParticulatePollutants: ["PM2.5", "PM10"],
    minimumDailyObservations: 16,
    sourceTitle: "How is AQI calculated?",
    sourceUrl: "https://cpcb.nic.in/displaypdf.php?id=bmF0aW9uYWwtYWlyLXF1YWxpdHktaW5kZXgvSG93X0FRSV9DYWxjdWxhdGVkLnBkZg%3D%3D"
};
export function averagingHoursFor(pollutant) {
    return pollutant === "CO" || pollutant === "OZONE" ? 8 : 24;
}
export function minimumWindowObservations(pollutant) {
    // CPCB specifies at least 16 observations for a daily sub-index. An 8-hour
    // rolling window cannot contain 16 hourly slots, so it requires one complete
    // 8-hour window while the overall daily sufficiency rule remains 16.
    return averagingHoursFor(pollutant) === 24 ? CPCB_AQI_REQUIREMENTS.minimumDailyObservations : 8;
}
export function validatePollutantSufficiency(pollutants) {
    const availablePollutants = [...new Set(pollutants)];
    const particulatePresent = CPCB_AQI_REQUIREMENTS.mandatoryParticulatePollutants.some((pollutant) => availablePollutants.includes(pollutant));
    const missingRequirements = [];
    if (availablePollutants.length < CPCB_AQI_REQUIREMENTS.minimumPollutants) {
        missingRequirements.push(`minimum_${CPCB_AQI_REQUIREMENTS.minimumPollutants}_pollutants`);
    }
    if (!particulatePresent)
        missingRequirements.push("pm25_or_pm10_required");
    return {
        valid: missingRequirements.length === 0,
        availablePollutants,
        requiredMinimumPollutantCount: CPCB_AQI_REQUIREMENTS.minimumPollutants,
        mandatoryPollutantRuleSatisfied: particulatePresent,
        missingRequirements,
        warnings: missingRequirements.length ? ["insufficient_pollutants"] : []
    };
}
