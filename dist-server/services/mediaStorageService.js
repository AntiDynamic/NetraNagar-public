import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
export class MediaStorageUnavailableError extends Error {
    code = "MEDIA_STORAGE_UNAVAILABLE";
    constructor() {
        super("Report media storage is temporarily unavailable. Please try again.");
        this.name = "MediaStorageUnavailableError";
    }
}
export function localMediaRoot() {
    const configured = process.env.LOCAL_MEDIA_ROOT?.trim();
    if (configured)
        return path.resolve(configured);
    return process.env.NODE_ENV === "production" || process.env.FUNCTIONS_EMULATOR
        ? path.join("/tmp", "media")
        : path.join(process.cwd(), "storage", "media");
}
const MAX_MEDIA_BYTES = 5_000_000;
function extensionFor(mimeType) {
    if (mimeType === "image/png")
        return "png";
    if (mimeType === "image/webp")
        return "webp";
    if (mimeType === "video/mp4")
        return "mp4";
    return "jpg";
}
function decodeBase64(data) {
    const cleaned = data.includes(",") ? data.split(",").pop() || "" : data;
    return Buffer.from(cleaned, "base64");
}
function ensureSupported(mimeType, sizeBytes) {
    const valid = ["image/jpeg", "image/png", "image/webp", "video/mp4"].includes(mimeType);
    if (!valid)
        throw new Error("Unsupported media type. Upload a JPEG, PNG, WebP, or MP4 evidence file.");
    if (sizeBytes <= 0)
        throw new Error("Uploaded media is empty.");
    if (sizeBytes > MAX_MEDIA_BYTES)
        throw new Error("Uploaded media is too large after compression.");
}
function localMediaUrl(storagePath) {
    return `/media/${storagePath.replaceAll("\\", "/")}`;
}
async function localMediaExists(storagePath) {
    try {
        await access(path.join(localMediaRoot(), storagePath), constants.R_OK);
        return true;
    }
    catch {
        return false;
    }
}
/** Creates fresh response-time media URLs without changing stored reports. */
export async function refreshMediaDisplayUrl(media) {
    if (!media)
        return media;
    const existingUrl = media.displayUrl || media.publicUrl;
    const localUrl = [media.displayUrl, media.publicUrl].find((url) => url?.startsWith("/media/"));
    if (localUrl) {
        if (await localMediaExists(media.storagePath)) {
            return { ...media, displayUrl: localUrl, publicUrl: localUrl };
        }
        if (existingUrl && !existingUrl.startsWith("/media/")) {
            return { ...media, displayUrl: existingUrl, publicUrl: existingUrl };
        }
        return { ...media, displayUrl: localUrl, publicUrl: localUrl };
    }
    if (media.storagePath) {
        const displayUrl = localMediaUrl(media.storagePath);
        if (await localMediaExists(media.storagePath)) {
            return { ...media, displayUrl, publicUrl: displayUrl, storageProvider: "local_dev" };
        }
    }
    if (existingUrl) {
        return { ...media, displayUrl: existingUrl, publicUrl: existingUrl };
    }
    return { ...media, displayUrl: undefined, publicUrl: undefined };
}
export async function hydrateReportMediaUrls(report) {
    const media = await Promise.all((report.media ?? []).map(refreshMediaDisplayUrl));
    const primary = report.primaryMediaId ? media.find((item) => item.mediaId === report.primaryMediaId) : media[0];
    const cleanupProof = report.cleanupProof
        ? { ...report.cleanupProof, afterMedia: await refreshMediaDisplayUrl(report.cleanupProof.afterMedia) }
        : undefined;
    const resolutionProof = report.resolutionProof
        ? {
            ...report.resolutionProof,
            ...(report.resolutionProof.afterMedia
                ? { afterMedia: await refreshMediaDisplayUrl(report.resolutionProof.afterMedia) }
                : {})
        }
        : undefined;
    return {
        ...report,
        media,
        imageUrl: primary?.displayUrl,
        ...(cleanupProof ? { cleanupProof } : {}),
        ...(resolutionProof ? { resolutionProof } : {})
    };
}
export async function hydrateReportsMediaUrls(reports) {
    return Promise.all(reports.map(hydrateReportMediaUrls));
}
async function uploadLocal(pathname, buffer) {
    const absolutePath = path.join(localMediaRoot(), pathname);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, buffer);
    return `/media/${pathname.replaceAll("\\", "/")}`;
}
export function mediaHash(base64) {
    return createHash("sha256").update(decodeBase64(base64)).digest("hex");
}
export async function storeReportMedia(input) {
    const original = decodeBase64(input.originalBase64);
    const thumbnail = decodeBase64(input.thumbnailBase64 || input.originalBase64);
    ensureSupported(input.mimeType, original.byteLength);
    const hash = createHash("sha256").update(original).digest("hex");
    const extension = extensionFor(input.mimeType);
    const storagePath = `reports/${input.reportId}/${input.mediaId}/original.${extension}`;
    const thumbnailPath = `reports/${input.reportId}/${input.mediaId}/thumbnail.jpg`;
    const warnings = [];
    if (!input.exifAvailable && !input.captureEvidence)
        warnings.push("no_exif_metadata");
    let publicUrl;
    let displayUrl;
    let storageProvider = "local_dev";
    displayUrl = await uploadLocal(storagePath, original);
    await uploadLocal(thumbnailPath, thumbnail);
    publicUrl = displayUrl;
    return {
        mediaId: input.mediaId,
        type: input.mimeType.startsWith("video/") ? "video" : "photo",
        storagePath,
        thumbnailPath,
        publicUrl,
        displayUrl,
        storageProvider,
        mimeType: input.mimeType,
        sizeBytes: original.byteLength,
        sha256Hash: hash,
        uploadedAt: new Date().toISOString(),
        fileModifiedAt: input.fileModifiedAt,
        capturedAt: input.capturedAt,
        width: input.width,
        height: input.height,
        exifAvailable: input.exifAvailable,
        captureEvidence: input.captureEvidence,
        metadataWarnings: warnings
    };
}
export async function storeResolutionMedia(input) {
    const buffer = decodeBase64(input.imageBase64);
    ensureSupported(input.mimeType, buffer.byteLength);
    const extension = extensionFor(input.mimeType);
    const storagePath = `reports/${input.reportId}/resolution/after.${extension}`;
    const hash = createHash("sha256").update(buffer).digest("hex");
    let publicUrl;
    let displayUrl;
    let storageProvider = "local_dev";
    displayUrl = await uploadLocal(storagePath, buffer);
    publicUrl = displayUrl;
    return {
        mediaId: "RES-AFTER",
        type: input.mimeType.startsWith("video/") ? "video" : "photo",
        storagePath,
        publicUrl,
        displayUrl,
        storageProvider,
        mimeType: input.mimeType,
        sizeBytes: buffer.byteLength,
        sha256Hash: hash,
        uploadedAt: new Date().toISOString(),
        exifAvailable: false,
        metadataWarnings: ["no_exif_metadata"]
    };
}
function safeSatelliteFilename(filename) {
    const parsed = path.parse(filename);
    const stem = parsed.name.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "product";
    const extension = [".png", ".jpg", ".jpeg", ".webp"].includes(parsed.ext.toLowerCase()) ? parsed.ext.toLowerCase() : ".png";
    return `${stem}${extension}`;
}
export async function storeSatelliteMedia(input) {
    const { buffer, reportId, filename } = input;
    const mimeType = input.mimeType || "image/png";
    if (!/^image\/(png|jpeg|webp)$/.test(mimeType))
        throw new Error("Satellite products must be stored as PNG, JPEG, or WebP images.");
    if (!buffer.byteLength)
        throw new Error("Satellite product is empty.");
    const safeReportId = reportId.replace(/[^a-zA-Z0-9_-]/g, "-");
    if (!safeReportId)
        throw new Error("Satellite report ID is invalid.");
    const storagePath = `reports/${safeReportId}/satellite/${safeSatelliteFilename(filename)}`;
    const createdAt = new Date().toISOString();
    const sha256Hash = createHash("sha256").update(buffer).digest("hex");
    await uploadLocal(storagePath, buffer);
    return { storagePath, displayUrl: localMediaUrl(storagePath), mimeType, sizeBytes: buffer.byteLength, sha256Hash, createdAt };
}
export async function readMediaBuffer(media) {
    try {
        return await readFile(path.join(localMediaRoot(), media.storagePath));
    }
    catch {
        return undefined;
    }
}
