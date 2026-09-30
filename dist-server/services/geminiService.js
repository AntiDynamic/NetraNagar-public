import { GoogleGenAI, Type } from "@google/genai";
export class VerificationError extends Error {
    reasonCode;
    constructor(message, reasonCode = "verification_rejected") {
        super(message);
        this.name = "VerificationError";
        this.reasonCode = reasonCode;
    }
}
const schema = {
    type: Type.OBJECT,
    properties: {
        is_pollution_related: { type: Type.BOOLEAN },
        pollution_visible: { type: Type.BOOLEAN },
        image_quality: { type: Type.STRING, enum: ["clear", "usable", "poor", "unusable"] },
        image_quality_score: { type: Type.NUMBER },
        pollution_type: {
            type: Type.STRING,
            enum: [
                "garbage_burning",
                "road_dust",
                "construction_dust",
                "industrial_smoke",
                "vehicle_smoke",
                "open_waste",
                "illegal_dumping",
                "stagnant_water",
                "sewage_overflow",
                "water_pollution",
                "unclear",
                "not_pollution"
            ]
        },
        confidence: { type: Type.NUMBER },
        severity: { type: Type.STRING, enum: ["low", "medium", "high", "severe"] },
        evidence_strength: { type: Type.NUMBER },
        visible_evidence: { type: Type.ARRAY, items: { type: Type.STRING } },
        rejection_reason: { type: Type.STRING },
        possible_pollutants: { type: Type.ARRAY, items: { type: Type.STRING } },
        public_summary: { type: Type.STRING },
        municipal_action: { type: Type.STRING },
        needs_manual_review: { type: Type.BOOLEAN },
        trust_decision: { type: Type.STRING, enum: ["verified", "likely_valid", "needs_review", "rejected"] },
        safety_note: { type: Type.STRING }
    },
    required: [
        "is_pollution_related",
        "pollution_visible",
        "image_quality",
        "image_quality_score",
        "pollution_type",
        "confidence",
        "severity",
        "evidence_strength",
        "visible_evidence",
        "possible_pollutants",
        "public_summary",
        "municipal_action",
        "needs_manual_review",
        "trust_decision",
        "safety_note"
    ]
};
const GEMINI_VERIFICATION_PROMPT = `You are NetraNagar's backend visual evidence classifier for civic pollution reports.

Analyze only visible evidence in the image. Do not estimate AQI from the image. Do not claim the image is definitely real, current, or authentic. If visible pollution evidence exists but uncertainty remains, return needs_review instead of rejected.

Accept visible evidence such as:
- smoke from garbage burning
- visible fire or burnt garbage
- road dust / dust cloud / dusty broken road
- construction dust / uncovered construction material
- industrial smoke / chimney fumes
- vehicle smoke / dark exhaust
- open waste / illegal dumping / garbage pile
- stagnant dirty water
- sewage overflow
- visibly polluted water / floating waste / foamy or dark contaminated water

Reject only if the image is clearly unrelated:
- selfie
- food
- document
- meme
- screenshot
- indoor object
- clean landscape
- clean road with no visible issue
- completely blurry/dark/cropped image
- image where no visible pollution/civic environmental hazard can be judged

Classify image quality separately:
- clear: good image, evidence visible
- usable: not perfect, but evidence can be judged
- poor: hard to judge, but some context/evidence visible
- unusable: too blurry/dark/cropped to judge

For weak but visible pollution, set:
is_pollution_related=true
pollution_visible=true
needs_manual_review=true
trust_decision="needs_review"

Do not reject weak-but-visible civic evidence. Route it for manual review.

Category guidance:
- road_dust: visible dust cloud, dusty road, unpaved/broken road, vehicle stirring dust, dust-covered roadside
- garbage_burning: fire, smoke from waste, ash, blackened garbage, burnt pile
- open_waste/illegal_dumping: garbage pile, plastic/organic waste, overflowing waste, dumped material
- construction_dust: cement/sand dust, construction site, demolition dust, uncovered material
- vehicle_smoke: visible exhaust smoke or dark fumes from vehicles
- industrial_smoke: smoke/fumes from chimney/factory/industrial outlet
- stagnant_water/sewage: dirty standing water, drain overflow, sewage, garbage mixed with water
- water_pollution: floating waste, dark/foamy water, visibly contaminated water

Return strict JSON only.`;
export function decideVerification(result) {
    const visibleEvidenceCount = result.visible_evidence?.length || 0;
    const rawEvidence = result.evidence_strength ?? result.confidence ?? 0;
    const evidenceStrength = rawEvidence <= 1 ? rawEvidence * 100 : rawEvidence;
    const rawConfidence = result.confidence ?? 0;
    const confidence = rawConfidence <= 1 ? rawConfidence * 100 : rawConfidence;
    const noVisibleEvidence = result.pollution_visible === false && visibleEvidenceCount === 0;
    const rejectionText = `${result.rejection_reason || ""} ${(result.visible_evidence || []).join(" ")}`.toLowerCase();
    if (/screen|screenshot|monitor|phone display|browser ui|printed image|printout|synthetic|generated image/.test(rejectionText)) {
        return {
            accepted: false,
            status: "Rejected",
            trustLevel: "Rejected",
            evidenceStatus: "rejected",
            reasonCode: "non_live_evidence",
            message: "This appears to be a photo of a screen or another non-live image. Please capture the actual pollution location using the live camera."
        };
    }
    if (!result.is_pollution_related || result.pollution_type === "not_pollution") {
        return {
            accepted: false,
            status: "Rejected",
            trustLevel: "Rejected",
            evidenceStatus: "rejected",
            reasonCode: "not_pollution",
            message: result.rejection_reason || "No visible pollution evidence was found."
        };
    }
    if (result.image_quality === "unusable") {
        return {
            accepted: false,
            status: "Rejected",
            trustLevel: "Rejected",
            evidenceStatus: "rejected",
            reasonCode: "unclear_photo",
            message: "The image is too dark or blurry to verify."
        };
    }
    if (noVisibleEvidence || (evidenceStrength < 20 && visibleEvidenceCount === 0)) {
        return {
            accepted: false,
            status: "Rejected",
            trustLevel: "Rejected",
            evidenceStatus: "rejected",
            reasonCode: "not_pollution",
            message: "This looks unrelated to a pollution hotspot."
        };
    }
    const needsReview = result.trust_decision === "needs_review" ||
        (result.pollution_type === "unclear" && evidenceStrength >= 25) ||
        (result.pollution_type === "unclear" && visibleEvidenceCount > 0) ||
        (confidence < 35 && visibleEvidenceCount > 0) ||
        (result.image_quality === "poor" && result.pollution_visible) ||
        (result.needs_manual_review && visibleEvidenceCount > 0) ||
        (evidenceStrength >= 20 && evidenceStrength < 50);
    if (needsReview) {
        return {
            accepted: true,
            status: "Manual review needed",
            trustLevel: "Needs Review",
            evidenceStatus: "needs_review",
            reasonCode: "needs_review",
            message: "Pollution evidence is visible but needs manual review."
        };
    }
    const verified = evidenceStrength >= 75 &&
        confidence >= 70 &&
        ["clear", "usable"].includes(result.image_quality) &&
        result.pollution_type !== "unclear" &&
        visibleEvidenceCount > 0;
    return {
        accepted: true,
        status: "Submitted",
        trustLevel: verified ? "Verified" : "Likely Valid",
        evidenceStatus: "verified",
        reasonCode: verified ? "verified" : "likely_valid",
        message: "Visible pollution evidence detected."
    };
}
function geminiFailureMessage(error) {
    const shaped = error;
    const message = shaped?.message || String(error);
    const causeMessage = shaped?.cause?.message || "";
    const causeCode = shaped?.cause?.code || "";
    if (shaped?.status === 401 || shaped?.status === 403 || /api key|permission|unauthorized|forbidden/i.test(message)) {
        return {
            message: "Gemini verification is not authorized. Check GEMINI_API_KEY and Gemini API access.",
            reasonCode: "gemini_auth_failed"
        };
    }
    if (shaped?.status === 429 || /quota|rate|too many requests|resource_exhausted|exceeded|429/i.test(message)) {
        return {
            message: "Gemini API quota or rate limit exceeded. Please try again later or check your Gemini project quota.",
            reasonCode: "gemini_rate_limited"
        };
    }
    if ((typeof shaped?.status === "number" && shaped.status >= 500) || /service unavailable|temporarily unavailable|503|502|504/i.test(message)) {
        return {
            message: "Gemini verification is temporarily unavailable. Please retry your fresh capture shortly.",
            reasonCode: "gemini_unavailable"
        };
    }
    if (/fetch failed/i.test(message) || causeCode || /ENOTFOUND|ECONNRESET|ETIMEDOUT|certificate/i.test(causeMessage)) {
        return {
            message: "Gemini verification could not reach the Gemini API. Check internet access, firewall/proxy, and that Gemini API is enabled for this key.",
            reasonCode: "gemini_network_failed"
        };
    }
    return {
        message: "AI verification failed. Please try again with a clear pollution photo.",
        reasonCode: "gemini_failed"
    };
}
function numberFromEnv(name, fallback) {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
}
function thinkingConfigForModel(model) {
    const budget = numberFromEnv("GEMINI_THINKING_BUDGET", 0);
    if (budget > 0 && (model.includes("2.5") || model.includes("flash-lite"))) {
        return { thinkingBudget: budget, includeThoughts: false };
    }
    return undefined;
}
function parseGeminiJson(text) {
    const cleaned = text.replace(/```(?:json)?/gi, "").trim();
    if (!cleaned)
        return {};
    try {
        return JSON.parse(cleaned);
    }
    catch {
        const start = cleaned.indexOf("{");
        const end = cleaned.lastIndexOf("}");
        if (start >= 0 && end > start) {
            try {
                return JSON.parse(cleaned.slice(start, end + 1));
            }
            catch {
                // Fallback below
            }
        }
        console.error("[GeminiParseError] Failed to parse raw text response:", text);
        throw new VerificationError("AI verification returned an invalid response. Please try again with a clear pollution photo.", "gemini_invalid_json");
    }
}
export async function analyzeImageData(input) {
    if (!process.env.GEMINI_API_KEY) {
        throw new VerificationError("Report verification service is not configured.", "gemini_not_configured");
    }
    if (!input.imageBase64 || !input.imageMimeType.startsWith("image/")) {
        throw new VerificationError("A valid image is required.", "invalid_media");
    }
    try {
        const model = process.env.GEMINI_MODEL || "gemini-3.6-flash";
        const ai = new GoogleGenAI({
            apiKey: process.env.GEMINI_API_KEY,
            httpOptions: {
                timeout: numberFromEnv("GEMINI_TIMEOUT_MS", 45000),
                retryOptions: { attempts: numberFromEnv("GEMINI_MAX_RETRIES", 2) + 1 }
            }
        });
        const generate = async (imageBase64) => {
            const result = await ai.models.generateContent({
                model,
                contents: [
                    {
                        role: "user",
                        parts: [
                            {
                                text: `${GEMINI_VERIFICATION_PROMPT} Context: ${(input.context || "").slice(0, 300)}`
                            },
                            { inlineData: { mimeType: input.imageMimeType, data: imageBase64 } }
                        ]
                    }
                ],
                config: {
                    responseMimeType: "application/json",
                    responseSchema: schema,
                    temperature: 0.1,
                    maxOutputTokens: 2048,
                    thinkingConfig: thinkingConfigForModel(model)
                }
            });
            return parseGeminiJson(result.text || "{}");
        };
        const firstPass = await generate(input.imageBase64);
        if (shouldRetryWithOriginal(firstPass) && input.fallbackImageBase64) {
            const secondPass = await generate(input.fallbackImageBase64);
            return { ...secondPass, second_pass_used: true };
        }
        return { ...firstPass, second_pass_used: false };
    }
    catch (error) {
        console.error("[GeminiError]", error);
        if (error instanceof VerificationError)
            throw error;
        const failure = geminiFailureMessage(error);
        throw new VerificationError(failure.message, failure.reasonCode);
    }
}
export function shouldRetryWithOriginal(result) {
    const reason = (result.rejection_reason || "").toLowerCase();
    if (result.image_quality === "unusable")
        return false;
    if (result.pollution_type === "not_pollution" &&
        /selfie|food|document|meme|screenshot|indoor object|clean road|clean landscape/.test(reason)) {
        return false;
    }
    const rawConfidence = result.confidence ?? 0;
    const confidence = rawConfidence <= 1 ? rawConfidence * 100 : rawConfidence;
    const rawEvidence = result.evidence_strength ?? 0;
    const evidenceStrength = rawEvidence <= 1 ? rawEvidence * 100 : rawEvidence;
    return (result.pollution_type === "unclear" ||
        confidence < 45 ||
        (evidenceStrength >= 15 && evidenceStrength <= 55) ||
        result.trust_decision === "needs_review");
}
