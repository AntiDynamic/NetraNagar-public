import { requestSentinelHub, SentinelProviderError } from "./sentinelHubClient.js";
export function narrowProcessingWindow(acquisitionTime, minutes = 5) {
    const time = new Date(acquisitionTime).getTime();
    return { fromTime: new Date(time - minutes * 60000).toISOString(), toTime: new Date(time + minutes * 60000).toISOString() };
}
function hasExpectedImageSignature(buffer, mimeType) {
    if (mimeType === "image/png")
        return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    if (mimeType === "image/jpeg")
        return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    if (mimeType === "image/webp")
        return buffer.length >= 12 && buffer.subarray(0, 4).equals(Buffer.from("RIFF")) && buffer.subarray(8, 12).equals(Buffer.from("WEBP"));
    return false;
}
function validateImageResponse(buffer, contentType, status) {
    const mimeType = (contentType || "").split(";", 1)[0].toLowerCase();
    if (!["image/png", "image/jpeg", "image/webp"].includes(mimeType) || buffer.length < 64 || !hasExpectedImageSignature(buffer, mimeType)) {
        let hostDetail = "";
        if (process.env.SENTINEL_DEBUG_RESPONSE_DETAILS === "true" && mimeType === "application/json") {
            try {
                const payload = JSON.parse(buffer.toString("utf8"));
                const detail = payload.error?.message || payload.error?.code || payload.message;
                hostDetail = ` detail=${(typeof detail === "string" ? detail : JSON.stringify(payload)).slice(0, 240)}`;
            }
            catch { /* retain the safe generic diagnostic */ }
        }
        throw new SentinelProviderError("SENTINEL_INVALID_RESPONSE", `Sentinel Process API did not return a valid image (mimeType=${mimeType || "unknown"}, bytes=${buffer.length}).${hostDetail}`, status, false, undefined, undefined, "invalid_response");
    }
}
function extractImageResponse(buffer, contentType, status) {
    const normalized = (contentType || "").toLowerCase();
    if (!normalized.startsWith("multipart/"))
        return { buffer, mimeType: normalized.split(";", 1)[0] };
    const boundary = contentType?.match(/boundary="?([^";]+)"?/i)?.[1];
    if (!boundary)
        throw new SentinelProviderError("SENTINEL_INVALID_RESPONSE", "Sentinel Process API returned malformed multipart data.", status, false, undefined, undefined, "invalid_response");
    const marker = Buffer.from(`--${boundary}`, "latin1");
    let cursor = 0;
    while (cursor < buffer.length) {
        const start = buffer.indexOf(marker, cursor);
        if (start < 0)
            break;
        const headerStart = start + marker.length + 2;
        const headerEnd = buffer.indexOf(Buffer.from("\r\n\r\n", "latin1"), headerStart);
        if (headerEnd < 0)
            break;
        const headers = buffer.subarray(headerStart, headerEnd).toString("latin1");
        const mimeType = headers.match(/^content-type:\s*([^;\r\n]+)/im)?.[1]?.trim().toLowerCase();
        const bodyStart = headerEnd + 4;
        const next = buffer.indexOf(marker, bodyStart);
        if (mimeType && next >= 0 && mimeType.startsWith("image/")) {
            const bodyEnd = buffer.subarray(next - 2, next).equals(Buffer.from("\r\n", "latin1")) ? next - 2 : next;
            return { buffer: buffer.subarray(bodyStart, bodyEnd), mimeType };
        }
        cursor = bodyStart;
    }
    throw new SentinelProviderError("SENTINEL_INVALID_RESPONSE", "Sentinel Process API multipart response did not contain an image.", status, false, undefined, undefined, "invalid_response");
}
function evalscriptFor(product) {
    const common = `
//VERSION=3
function setup() {
  return { input: ["B02", "B03", "B04", "B08", "B11", "B12", "SCL", "dataMask"], output: { bands: 4, sampleType: "AUTO" } };
}

function clamp(value) { return Math.max(0, Math.min(1, value)); }
`;
    const body = product === "true_colour"
        ? `function evaluatePixel(sample) { return [clamp(sample.B04 * 2.5), clamp(sample.B03 * 2.5), clamp(sample.B02 * 2.5), sample.dataMask]; }`
        : product === "swir_nir_context"
            ? `function evaluatePixel(sample) { return [clamp(sample.B12 * 2.5), clamp(sample.B08 * 2.5), clamp(sample.B04 * 2.5), sample.dataMask]; }`
            : product === "nbr_context"
                ? `function evaluatePixel(sample) { const d = sample.B08 + sample.B12; const nbr = d === 0 ? 0 : (sample.B08 - sample.B12) / d; return [clamp((nbr + 1) / 2), clamp((nbr + 1) / 2), clamp((nbr + 1) / 2), sample.dataMask]; }`
                : `function evaluatePixel(sample) { const d = sample.B08 + sample.B04; const bsi = d === 0 ? 0 : ((sample.B11 + sample.B04) - (sample.B08 + sample.B02)) / d; return [clamp((bsi + 1) / 2), clamp((bsi + 1) / 2), clamp((bsi + 1) / 2), sample.dataMask]; }`;
    return `${common}\n${body}`;
}
async function executeProcessApi(product, params) {
    if (new Date(params.toTime).getTime() - new Date(params.fromTime).getTime() >= 50 * 60000) {
        throw new Error("Sentinel processing interval must be shorter than 50 minutes.");
    }
    const width = Math.max(64, Math.min(1024, Math.floor(params.width ?? 512)));
    const height = Math.max(64, Math.min(1024, Math.floor(params.height ?? 512)));
    const body = {
        input: {
            bounds: { bbox: params.bbox, properties: { crs: "http://www.opengis.net/def/crs/EPSG/0/4326" } },
            data: [{
                    type: "sentinel-2-l2a",
                    dataFilter: { timeRange: { from: params.fromTime, to: params.toTime }, maxCloudCoverage: Math.max(0, Math.min(100, params.maxCloudCoverage)), mosaickingOrder: "mostRecent" }
                }]
        },
        output: { width, height, responses: [{ identifier: "default", format: { type: "image/png" } }] },
        evalscript: evalscriptFor(product)
    };
    const { data, response } = await requestSentinelHub("/api/v1/process", { method: "POST", headers: { Accept: "image/png" }, body: JSON.stringify(body) }, "buffer");
    const image = extractImageResponse(data, response.headers.get("content-type"), response.status);
    validateImageResponse(image.buffer, image.mimeType, response.status);
    return {
        buffer: image.buffer,
        product,
        requestedOutput: { width, height },
        processingWindow: { from: params.fromTime, to: params.toTime },
        processedAcquisitionTimes: [],
        sameAcquisitionConfirmed: false,
        warning: "Processed response metadata did not confirm the catalog scene identity."
    };
}
export const getSentinel2TrueColorChip = (params) => executeProcessApi("true_colour", params);
export const getSentinel2SwirNirContextChip = (params) => executeProcessApi("swir_nir_context", params);
export const getSentinel2NBRChip = (params) => executeProcessApi("nbr_context", params);
export const getSentinel2BareSurfaceChip = (params) => executeProcessApi("bare_surface_context", params);
