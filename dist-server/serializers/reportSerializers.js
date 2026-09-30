function normalizedStatus(status) {
    return status.trim().toLowerCase().replace(/[ _-]+/g, " ");
}
function citizenStatusFromValue(status) {
    const normalized = normalizedStatus(status);
    if (normalized === "resolved" || normalized === "completed")
        return "Resolved";
    if (normalized === "cleanup proof submitted")
        return "Cleanup Proof Submitted";
    if (normalized === "assigned" ||
        normalized === "accepted" ||
        normalized === "in progress" ||
        normalized === "cleanup in progress") {
        return "In Progress";
    }
    return "Submitted";
}
function municipalStageFromValue(status) {
    const normalized = normalizedStatus(status);
    if (normalized === "resolved" || normalized === "completed")
        return "Completed";
    if (normalized === "cleanup proof submitted")
        return "Cleanup Proof Submitted";
    if (normalized === "assigned" || normalized === "accepted")
        return "Assigned";
    return "Cleanup In Progress";
}
function publicMediaUrl(media) {
    return media?.publicUrl;
}
function reportEvidence(report) {
    if (report.primaryMediaId) {
        const primary = report.media?.find((media) => media.mediaId === report.primaryMediaId);
        if (primary)
            return primary;
    }
    return report.media?.[0];
}
function safeReportMedia(media) {
    const url = publicMediaUrl(media);
    if (!media || !url)
        return undefined;
    return { type: media.type, url };
}
function officerMedia(media) {
    const safe = safeReportMedia(media);
    if (!safe)
        return undefined;
    return {
        ...safe,
        ...(media.capturedAt ? { capturedAt: media.capturedAt } : {}),
        ...(media.width === undefined ? {} : { width: media.width }),
        ...(media.height === undefined ? {} : { height: media.height })
    };
}
function gpsAccuracyMeters(report) {
    return report.captureEvidence?.captureLocation.accuracyMeters;
}
function toMunicipalAssignmentDto(report) {
    const assignment = report.ngoAssignment;
    if (!assignment)
        return undefined;
    return {
        teamName: assignment.ngoName,
        assignedAt: assignment.assignedAt,
        status: municipalStageFromValue(assignment.status)
    };
}
function toCitizenCleanupProofDto(report) {
    const proof = report.cleanupProof;
    if (!proof)
        return undefined;
    return {
        submittedAt: proof.submittedAt,
        ...(safeReportMedia(proof.afterMedia) ? { afterEvidence: safeReportMedia(proof.afterMedia) } : {}),
        ...(proof.actionTaken ? { actionTaken: proof.actionTaken } : {}),
        ...(proof.summary ? { summary: proof.summary } : {})
    };
}
function toCleanupProofDto(report) {
    const proof = report.cleanupProof;
    if (!proof)
        return undefined;
    const afterEvidence = safeReportMedia(proof.afterMedia);
    return {
        submittedAt: proof.submittedAt,
        ...(afterEvidence ? { afterEvidence } : {}),
        ...(proof.locality ? { locality: proof.locality } : {}),
        ...(proof.lat === undefined ? {} : { lat: proof.lat }),
        ...(proof.lng === undefined ? {} : { lng: proof.lng }),
        ...(proof.gpsAccuracy === undefined ? {} : { gpsAccuracyMeters: proof.gpsAccuracy }),
        ...(proof.actionTaken ? { actionTaken: proof.actionTaken } : {}),
        ...(proof.note ? { note: proof.note } : {}),
        ...(proof.cleanupPercentage === undefined ? {} : { cleanupPercentage: proof.cleanupPercentage }),
        ...(proof.locationMatch === undefined ? {} : { locationMatch: proof.locationMatch }),
        ...(proof.remainingPollution ? { remainingPollution: proof.remainingPollution } : {}),
        ...(proof.summary ? { summary: proof.summary } : {})
    };
}
function toCitizenResolutionDto(resolution) {
    if (!resolution)
        return undefined;
    const afterEvidence = safeReportMedia(resolution.afterMedia);
    return {
        resolvedAt: resolution.resolvedAt,
        actionTaken: resolution.actionTaken,
        ...(afterEvidence ? { afterEvidence } : {})
    };
}
function toOfficerResolutionDto(resolution) {
    if (!resolution)
        return undefined;
    const afterEvidence = resolution.afterMedia ? officerMedia(resolution.afterMedia) : undefined;
    return {
        beforeMediaId: resolution.beforeMediaId,
        actionTaken: resolution.actionTaken,
        resolvedBy: resolution.resolvedBy,
        resolvedAt: resolution.resolvedAt,
        notes: resolution.notes,
        ...(afterEvidence ? { afterEvidence } : {})
    };
}
function toOfficerAirQualityDto(airQuality) {
    return {
        provider: airQuality.provider,
        ...(airQuality.aqi === undefined ? {} : { aqi: airQuality.aqi }),
        ...(airQuality.category ? { category: airQuality.category } : {}),
        ...(airQuality.dominantPollutant ? { dominantPollutant: airQuality.dominantPollutant } : {}),
        ...(airQuality.nearestStation ? { nearestStation: airQuality.nearestStation } : {}),
        ...(airQuality.nearestStationDistanceMeters === undefined
            ? {}
            : { nearestStationDistanceMeters: airQuality.nearestStationDistanceMeters }),
        ...(airQuality.lastUpdate ? { lastUpdate: airQuality.lastUpdate } : {}),
        ...(airQuality.status ? { status: airQuality.status } : {}),
        ...(airQuality.warnings ? { warnings: [...airQuality.warnings.map((warning) => warning.message)] } : {})
    };
}
function toOfficerSatelliteEvidenceDto(evidence) {
    return {
        status: evidence.status,
        ...(evidence.checkedAt ? { checkedAt: evidence.checkedAt } : {}),
        ...(evidence.requestedAt ? { requestedAt: evidence.requestedAt } : {}),
        ...(evidence.completedAt ? { completedAt: evidence.completedAt } : {}),
        assessment: {
            result: evidence.assessment.result,
            confidence: evidence.assessment.confidence,
            explanation: evidence.assessment.explanation,
            limitations: [...evidence.assessment.limitations]
        },
        observability: {
            status: evidence.observability.status,
            score: evidence.observability.score,
            reasons: [...evidence.observability.reasons]
        },
        evidenceContributionPoints: evidence.evidenceContributionPoints,
        decisionEffect: evidence.decisionEffect,
        warnings: [...evidence.warnings],
        explanation: evidence.explanation,
        limitations: [...evidence.limitations]
    };
}
function toOfficerActionLogDto(entry) {
    return {
        type: entry.type,
        at: entry.at,
        ...(entry.note ? { note: entry.note } : {})
    };
}
function toOfficerStatusHistoryDto(entry) {
    return {
        status: entry.status,
        label: entry.label,
        timestamp: entry.timestamp,
        ...(entry.updatedByRole ? { updatedByRole: entry.updatedByRole } : {}),
        ...(entry.message ? { message: entry.message } : {})
    };
}
export function toCitizenFacingStatus(report) {
    if (report.resolutionProof || report.resolvedAt || normalizedStatus(report.status) === "resolved")
        return "Resolved";
    if (report.cleanupProof || normalizedStatus(report.status) === "cleanup proof submitted")
        return "Cleanup Proof Submitted";
    return citizenStatusFromValue(report.status);
}
export function sanitizeCitizenStatusHistory(history) {
    return (history ?? []).map((entry) => {
        const status = citizenStatusFromValue(entry.status);
        return { status, label: status, timestamp: entry.timestamp };
    });
}
export function sanitizeMunicipalHistory(history) {
    return (history ?? [])
        .filter((entry) => {
        const status = normalizedStatus(entry.status);
        return entry.updatedByRole === "municipal" || ["assigned", "accepted", "in progress", "cleanup in progress", "cleanup proof submitted", "resolved", "completed"].includes(status);
    })
        .map((entry) => ({ status: municipalStageFromValue(entry.status), timestamp: entry.timestamp }));
}
export function toPublicReportDto(report) {
    const evidenceUrl = publicMediaUrl(reportEvidence(report));
    const nearbyReportCount = report.nearby?.similarReportCount;
    return {
        id: report.id,
        approximateLat: Math.round(report.lat * 1000) / 1000,
        approximateLng: Math.round(report.lng * 1000) / 1000,
        ...(report.locality?.locality_name ? { approximateLocality: report.locality.locality_name } : {}),
        pollutionType: report.gemini.pollution_type,
        severity: report.gemini.severity,
        priority: report.priority,
        status: toCitizenFacingStatus(report),
        createdAt: report.createdAt,
        ...(evidenceUrl ? { thumbnailUrl: evidenceUrl } : {}),
        ...(report.hotspotScore > 0 ? { hotspotScore: report.hotspotScore } : {}),
        ...(nearbyReportCount === undefined ? {} : { nearbyReportCount })
    };
}
export function toCitizenReportDto(report) {
    const evidence = safeReportMedia(reportEvidence(report));
    const assignment = toMunicipalAssignmentDto(report);
    const cleanupProof = toCitizenCleanupProofDto(report);
    const resolution = toCitizenResolutionDto(report.resolutionProof);
    return {
        id: report.id,
        createdAt: report.createdAt,
        updatedAt: report.updatedAt,
        lat: report.lat,
        lng: report.lng,
        areaText: report.areaText,
        ...(gpsAccuracyMeters(report) === undefined ? {} : { gpsAccuracyMeters: gpsAccuracyMeters(report) }),
        pollutionType: report.gemini.pollution_type,
        severity: report.gemini.severity,
        priority: report.priority,
        status: toCitizenFacingStatus(report),
        publicSummary: report.gemini.public_summary,
        evidenceScore: report.evidenceScore,
        ...(evidence ? { evidence } : {}),
        statusHistory: sanitizeCitizenStatusHistory(report.statusHistory),
        ...(assignment ? { municipalAssignment: assignment } : {}),
        ...(cleanupProof ? { cleanupProof } : {}),
        ...(resolution ? { resolution } : {})
    };
}
export function toMunicipalReportDto(report) {
    const beforeEvidence = safeReportMedia(reportEvidence(report));
    const assignment = toMunicipalAssignmentDto(report);
    const cleanupProof = toCleanupProofDto(report);
    return {
        id: report.id,
        createdAt: report.createdAt,
        updatedAt: report.updatedAt,
        lat: report.lat,
        lng: report.lng,
        ...(gpsAccuracyMeters(report) === undefined ? {} : { gpsAccuracyMeters: gpsAccuracyMeters(report) }),
        areaText: report.areaText,
        pollutionType: report.gemini.pollution_type,
        severity: report.gemini.severity,
        priority: report.priority,
        hotspotScore: report.hotspotScore,
        workflowStage: report.resolutionProof ? "Completed" : report.cleanupProof ? "Cleanup Proof Submitted" : assignment?.status ?? municipalStageFromValue(report.status),
        ...(beforeEvidence ? { beforeEvidence } : {}),
        userDescription: report.userDescription,
        ...(assignment ? { assignment } : {}),
        municipalHistory: sanitizeMunicipalHistory(report.statusHistory),
        ...(cleanupProof ? { cleanupProof } : {}),
        ...(report.actionTaken ? { actionTaken: report.actionTaken } : {})
    };
}
export function toOfficerReportDto(report) {
    const media = (report.media ?? [])
        .map(officerMedia)
        .filter((item) => item !== undefined);
    const assignment = toMunicipalAssignmentDto(report);
    const cleanupProof = toCleanupProofDto(report);
    const resolution = toOfficerResolutionDto(report.resolutionProof);
    return {
        id: report.id,
        createdAt: report.createdAt,
        updatedAt: report.updatedAt,
        status: report.status,
        lat: report.lat,
        lng: report.lng,
        areaText: report.areaText,
        userDescription: report.userDescription,
        pollutionType: report.gemini.pollution_type,
        severity: report.gemini.severity,
        priority: report.priority,
        hotspotScore: report.hotspotScore,
        nearby: {
            similarReportCount: report.nearby?.similarReportCount ?? 0,
            reportIds: [...(report.nearby?.nearbyReportIds ?? [])]
        },
        media,
        ...(report.captureEvidence ? { captureEvidence: structuredClone(report.captureEvidence) } : {}),
        verification: {
            evidenceStatus: report.evidenceStatus,
            evidenceScore: report.evidenceScore,
            trustLevel: report.trustLevel,
            authenticityScore: report.authenticityScore,
            authenticityFlags: [...(report.authenticityFlags ?? [])],
            ...(report.scoreBreakdown ? { scoreBreakdown: { ...report.scoreBreakdown } } : {}),
            evidenceReasons: [...(report.evidenceReasons ?? [])],
            publicSummary: report.gemini.public_summary,
            municipalAction: report.gemini.municipal_action,
            visibleEvidence: [...report.gemini.visible_evidence],
            pollutionVisible: report.gemini.pollution_visible,
            imageQuality: report.gemini.image_quality,
            confidence: report.gemini.confidence,
            needsManualReview: report.gemini.needs_manual_review,
            ...(report.rejectionReason ? { rejectionReason: report.rejectionReason } : {})
        },
        airQuality: toOfficerAirQualityDto(report.airQuality),
        ...(report.satelliteEvidence ? { satelliteEvidence: toOfficerSatelliteEvidenceDto(report.satelliteEvidence) } : {}),
        ...(assignment ? { assignment } : {}),
        municipalHistory: sanitizeMunicipalHistory(report.statusHistory),
        ...(cleanupProof ? { cleanupProof } : {}),
        actionLog: (report.actionLog ?? []).map(toOfficerActionLogDto),
        statusHistory: (report.statusHistory ?? []).map(toOfficerStatusHistoryDto),
        ...(resolution ? { resolution } : {}),
        ...(report.gemini.needs_manual_review ? { internalReviewRecommendation: report.gemini.municipal_action } : {})
    };
}
export function toPublicReportDtos(reports) {
    return reports.map(toPublicReportDto);
}
export function toCitizenReportDtos(reports) {
    return reports.map(toCitizenReportDto);
}
export function toMunicipalReportDtos(reports) {
    return reports.map(toMunicipalReportDto);
}
export function toOfficerReportDtos(reports) {
    return reports.map(toOfficerReportDto);
}
