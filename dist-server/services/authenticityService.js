export function assessAuthenticity(input) {
    const flags = [];
    let score = 86;
    if (input.duplicateRecent) {
        flags.push("duplicate_image_hash");
        score -= 45;
    }
    if (!input.media.exifAvailable && input.media.captureEvidence?.captureMethod !== "live_camera") {
        flags.push("no_exif_metadata");
        score -= 3;
    }
    if (input.media.sizeBytes < 18_000) {
        flags.push("very_small_image");
        score -= 5;
    }
    const aspectRatio = input.media.width && input.media.height ? input.media.width / input.media.height : 1;
    const unusualAspectRatio = aspectRatio > 2.1 || aspectRatio < 0.48;
    if (unusualAspectRatio) {
        flags.push("unusual_aspect_ratio");
        score -= 4;
    }
    const reason = (input.gemini.rejection_reason || "").toLowerCase();
    const evidenceText = input.gemini.visible_evidence.join(" ").toLowerCase();
    const screenLikeDimensions = Boolean(input.media.width &&
        input.media.height &&
        (Math.max(input.media.width, input.media.height) / Math.min(input.media.width, input.media.height) > 1.7));
    const screenshotSignals = [
        input.media.sizeBytes < 18_000,
        unusualAspectRatio,
        !input.media.exifAvailable && input.media.captureEvidence?.captureMethod !== "live_camera",
        /screenshot|ui|interface|text overlay|screen/.test(`${reason} ${evidenceText}`),
        screenLikeDimensions
    ].filter(Boolean).length;
    if (screenshotSignals >= 2) {
        flags.push("possible_screenshot");
        score -= 10;
    }
    if ((input.gemini.evidence_strength ?? input.gemini.confidence) < 45) {
        flags.push("low_visual_evidence");
        score -= 12;
    }
    if (input.gemini.needs_manual_review) {
        flags.push("manual_review_triggered");
        score -= 8;
    }
    if (input.userRecentReports.length >= 5) {
        flags.push("repeated_uploads_by_user");
        score -= 7;
    }
    if (!input.locationText || input.locationText.includes(",")) {
        flags.push("location_needs_review");
        score -= 4;
    }
    if (input.nearbyCount > 0) {
        flags.push("nearby_reports_confirmed");
        score += Math.min(10, input.nearbyCount * 3);
    }
    if (/synthetic|edited|manipulated|generated/.test(reason)) {
        flags.push("possible_synthetic_or_edited_image");
        score -= 25;
    }
    if (input.gemini.image_quality === "clear" || input.gemini.image_quality === "usable")
        score += 4;
    if (input.gemini.trust_decision === "verified")
        score += 5;
    const authenticityScore = Math.max(0, Math.min(100, Math.round(score)));
    const authenticityLevel = authenticityScore >= 70 && !input.gemini.needs_manual_review
        ? "likely_real"
        : authenticityScore >= 45
            ? "suspicious"
            : "needs_manual_review";
    return { authenticityScore, authenticityLevel, authenticityFlags: flags };
}
