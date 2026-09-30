export function scoreEvidence(input) {
    const visualEvidenceScore = Math.max(0, Math.min(100, Math.round(input.gemini.evidence_strength ?? input.gemini.confidence)));
    const nearbyCorroborationScore = Math.min(100, input.nearbyCount * 25);
    const locationConfidenceScore = input.hasPreciseLocation ? 88 : 52;
    const ageMs = Date.now() - new Date(input.uploadedAt).getTime();
    const recencyScore = ageMs < 60 * 60 * 1000 ? 96 : ageMs < 24 * 60 * 60 * 1000 ? 82 : 55;
    const evidenceScore = Math.round(0.35 * visualEvidenceScore +
        0.2 * input.authenticity.authenticityScore +
        0.2 * nearbyCorroborationScore +
        0.15 * locationConfidenceScore +
        0.1 * recencyScore);
    let trustLevel = evidenceScore >= 80 && input.authenticity.authenticityScore >= 70
        ? "Verified"
        : evidenceScore >= 60
            ? "Likely Valid"
            : evidenceScore >= 35
                ? "Needs Review"
                : "Rejected";
    if (input.gemini.trust_decision === "rejected" || input.decision?.trustLevel === "Rejected") {
        trustLevel = "Rejected";
    }
    else if (input.gemini.trust_decision === "needs_review" || input.decision?.trustLevel === "Needs Review") {
        trustLevel = evidenceScore >= 80 && visualEvidenceScore >= 70 ? "Likely Valid" : "Needs Review";
    }
    else if (input.decision?.trustLevel === "Likely Valid" && trustLevel === "Verified") {
        trustLevel = "Likely Valid";
    }
    const reasons = [
        `Visual evidence ${visualEvidenceScore}/100`,
        `Authenticity ${input.authenticity.authenticityScore}/100`,
        input.nearbyCount
            ? `${input.nearbyCount} nearby report${input.nearbyCount === 1 ? "" : "s"} corroborate this area`
            : "No nearby corroborating reports yet",
        input.hasPreciseLocation ? "Location coordinates available" : "Location needs manual review"
    ];
    if (input.gemini.needs_manual_review)
        reasons.push("Gemini requested manual review");
    if (input.gemini.image_quality)
        reasons.push(`Image quality: ${input.gemini.image_quality}`);
    if (input.gemini.second_pass_used)
        reasons.push("Second-pass analysis used stored evidence image");
    if (input.decision?.message)
        reasons.push(input.decision.message);
    input.authenticity.authenticityFlags.forEach((flag) => reasons.push(flag.replace(/_/g, " ")));
    return {
        evidenceScore,
        trustLevel,
        scoreBreakdown: {
            visualEvidenceScore,
            authenticityScore: input.authenticity.authenticityScore,
            nearbyCorroborationScore,
            locationConfidenceScore,
            recencyScore
        },
        reasons
    };
}
