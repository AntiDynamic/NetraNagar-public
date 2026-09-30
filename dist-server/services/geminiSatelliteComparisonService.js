import { GoogleGenAI, Type } from "@google/genai";
const assessmentSchema = {
    type: Type.OBJECT,
    properties: {
        observability: { type: Type.STRING, enum: ["observable", "partially_observable", "not_observable"] },
        eventSuitability: { type: Type.STRING, enum: ["suitable", "partially_suitable", "not_suitable"] },
        citizenPhotoSignals: { type: Type.ARRAY, items: { type: Type.STRING } },
        satelliteSignals: { type: Type.ARRAY, items: { type: Type.STRING } },
        surfaceChangeSignals: { type: Type.ARRAY, items: { type: Type.STRING } },
        contradictorySignals: { type: Type.ARRAY, items: { type: Type.STRING } },
        temporalConsistency: { type: Type.STRING, enum: ["relevant", "weak", "mismatched"] },
        spatialContext: { type: Type.STRING, enum: ["potentially_consistent", "unclear", "contradictory"] },
        result: { type: Type.STRING, enum: ["potentially_consistent", "possible_surface_change", "no_observable_signal", "contradictory_context", "inconclusive", "not_observable"] },
        confidence: { type: Type.NUMBER },
        summary: { type: Type.STRING },
        limitations: { type: Type.ARRAY, items: { type: Type.STRING } }
    },
    required: ["observability", "eventSuitability", "citizenPhotoSignals", "satelliteSignals", "surfaceChangeSignals", "contradictorySignals", "temporalConsistency", "spatialContext", "result", "confidence", "summary", "limitations"]
};
const prompt = `You are assessing semantic consistency between one citizen ground-level pollution photo and clearly labelled Sentinel-2 overhead context images. Do not perform pixel matching. The images have different viewing angles, scales, resolutions, acquisition times and atmospheric conditions.

Use only the supplied metadata and visible signals. Do not infer AQI or PM2.5. Do not claim the phone was physically at the coordinates, that the photo is authentic, that a small fire definitely happened, or that street-level smoke definitely existed. Do not invent objects invisible at Sentinel-2 resolution. Do not claim a small event is absent merely because it is not visible. Do not treat colour differences alone as pollution, bare soil alone as dust, or positive surface change alone as active burning. Return inconclusive when evidence is insufficient.

Return strict JSON. A scene or image existing is not evidence by itself. The report's citizen photo remains primary; satellite context is limited supporting context only.`;
function clampConfidence(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : 0;
}
function parseResponse(text) {
    const trimmed = text.trim();
    try {
        return JSON.parse(trimmed);
    }
    catch {
        const start = trimmed.indexOf("{");
        const end = trimmed.lastIndexOf("}");
        if (start >= 0 && end > start)
            return JSON.parse(trimmed.slice(start, end + 1));
        throw new Error("Gemini satellite assessment returned invalid JSON.");
    }
}
function strings(value) { return Array.isArray(value) ? value.filter((item) => typeof item === "string").slice(0, 12) : []; }
export async function analyzeSatelliteComparison(input) {
    if (!process.env.GEMINI_API_KEY)
        throw new Error("Gemini satellite comparison is not configured.");
    const model = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, httpOptions: { timeout: Number(process.env.GEMINI_TIMEOUT_MS || 45000) } });
    const images = [input.citizenPhoto, ...input.satelliteImages].slice(0, 6);
    const parts = [{ text: `${prompt}\nMetadata:\n${JSON.stringify(input.metadata).slice(0, 12000)}` }];
    for (const image of images) {
        parts.push({ text: image.label });
        parts.push({ inlineData: { mimeType: image.mimeType || "image/jpeg", data: image.buffer.toString("base64") } });
    }
    const response = await ai.models.generateContent({
        model,
        contents: [{ role: "user", parts: parts }],
        config: { responseMimeType: "application/json", responseSchema: assessmentSchema, temperature: 0.1, maxOutputTokens: 1200 }
    });
    const raw = parseResponse(response.text || "{}");
    const result = ["potentially_consistent", "possible_surface_change", "no_observable_signal", "contradictory_context", "inconclusive", "not_observable"].includes(String(raw.result)) ? raw.result : "inconclusive";
    return {
        result,
        confidence: clampConfidence(raw.confidence),
        source: "gemini_multimodal",
        observability: ["observable", "partially_observable"].includes(String(raw.observability)) ? raw.observability : "not_observable",
        eventSuitability: ["suitable", "partially_suitable"].includes(String(raw.eventSuitability)) ? raw.eventSuitability : "not_suitable",
        citizenPhotoSignals: strings(raw.citizenPhotoSignals),
        satelliteSignals: strings(raw.satelliteSignals),
        surfaceChangeSignals: strings(raw.surfaceChangeSignals),
        contradictorySignals: strings(raw.contradictorySignals),
        temporalConsistency: ["relevant", "weak"].includes(String(raw.temporalConsistency)) ? raw.temporalConsistency : "mismatched",
        spatialContext: ["potentially_consistent", "unclear"].includes(String(raw.spatialContext)) ? raw.spatialContext : "contradictory",
        explanation: typeof raw.summary === "string" ? raw.summary.slice(0, 1000) : "Gemini returned no satellite-context summary.",
        limitations: strings(raw.limitations)
    };
}
