function hasCoordinates(report) {
    return Number.isFinite(report.captureEvidence?.captureLocation.lat ?? report.lat)
        && Number.isFinite(report.captureEvidence?.captureLocation.lng ?? report.lng);
}
function hasSatelliteProducts(report) {
    return Boolean(report.satelliteEvidence && Object.values(report.satelliteEvidence.products).some(Boolean));
}
export function eligibleSentinelReports(reports, input) {
    const limit = Math.max(1, Math.min(100, input.limit));
    return reports.filter((report) => {
        if (input.mode === "report")
            return report.id === input.reportId;
        if (!input.includeResolved && report.status === "Resolved")
            return false;
        if (!hasCoordinates(report) || hasSatelliteProducts(report))
            return false;
        const status = report.satelliteEvidence?.status;
        if (input.mode === "failed")
            return status === "failed" || status === "unavailable";
        if (input.mode === "pending")
            return status === "pending" || status === "processing";
        if (input.mode === "missing")
            return !report.satelliteEvidence || !hasSatelliteProducts(report);
        return status !== "ready";
    }).slice(0, limit);
}
/** Preserves the last safe failure summary before placing a report back in the queue. */
export function pendingSentinelEvidenceForReprocess(report) {
    const current = report.satelliteEvidence;
    if (!current)
        return undefined;
    const previousFailures = current.error
        ? [...(current.previousFailures || []), { code: current.error.code, message: current.error.message, at: current.checkedAt || new Date().toISOString() }].slice(-5)
        : current.previousFailures;
    return { ...current, status: "pending", requestedAt: new Date().toISOString(), error: undefined, previousFailures };
}
