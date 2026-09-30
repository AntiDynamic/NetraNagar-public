export const CAPTURE_GPS_PREFERRED_ACCURACY_METERS = 50;
export const CAPTURE_GPS_MAX_ACCURACY_METERS = Number(process.env.CAPTURE_GPS_MAX_ACCURACY_METERS || 150);
export const CAPTURE_GPS_MAX_AGE_SECONDS = Number(process.env.CAPTURE_GPS_MAX_AGE_SECONDS || 30);
export const CAPTURE_MAX_CLOCK_SKEW_SECONDS = Number(process.env.CAPTURE_MAX_CLOCK_SKEW_SECONDS || 300);
export const CAPTURE_MAX_PHOTO_AGE_SECONDS = Number(process.env.CAPTURE_MAX_PHOTO_AGE_SECONDS || 86400);
export class CaptureValidationError extends Error {
    reasonCode;
    constructor(reasonCode, message) {
        super(message);
        this.reasonCode = reasonCode;
        this.name = "CaptureValidationError";
    }
}
function requiredString(value, field) {
    if (typeof value !== "string" || !value.trim()) {
        throw new CaptureValidationError("capture_metadata_required", `${field} is required.`);
    }
    return value;
}
function parseTimestamp(value, field) {
    const raw = requiredString(value, field);
    const time = Date.parse(raw);
    if (!Number.isFinite(time)) {
        throw new CaptureValidationError("invalid_capture_timestamp", `${field} must be a valid ISO timestamp.`);
    }
    return { raw, time };
}
function finiteCoordinate(value, field, min, max) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
        throw new CaptureValidationError("invalid_capture_location", `${field} is outside the valid coordinate range.`);
    }
    return value;
}
export function validateLiveCameraCapture(input, now = Date.now()) {
    if (input.captureMethod !== "live_camera") {
        throw new CaptureValidationError(input.captureMethod ? "invalid_capture_method" : "capture_method_required", "Public reports must use the live camera capture flow.");
    }
    if (input.imageMimeType !== "image/jpeg") {
        throw new CaptureValidationError("camera_image_required", "Public camera captures must be JPEG images.");
    }
    if (typeof input.width !== "number" || !Number.isInteger(input.width) || input.width <= 0 || input.width > 12000 ||
        typeof input.height !== "number" || !Number.isInteger(input.height) || input.height <= 0 || input.height > 12000) {
        throw new CaptureValidationError("invalid_capture_dimensions", "Camera image dimensions are invalid.");
    }
    if (input.cameraFacingMode !== "environment" && input.cameraFacingMode !== "user") {
        throw new CaptureValidationError("invalid_camera_facing_mode", "Camera facing mode is invalid.");
    }
    const photo = parseTimestamp(input.photoCapturedAt, "photoCapturedAt");
    const location = input.captureLocation;
    if (!location || typeof location !== "object") {
        throw new CaptureValidationError("capture_location_required", "A GPS fix captured with the photo is required.");
    }
    const lat = finiteCoordinate(location.lat, "captureLocation.lat", -90, 90);
    const lng = finiteCoordinate(location.lng, "captureLocation.lng", -180, 180);
    if (typeof location.accuracyMeters !== "number" || !Number.isFinite(location.accuracyMeters) || location.accuracyMeters < 0) {
        throw new CaptureValidationError("invalid_gps_accuracy", "GPS accuracy must be a non-negative number.");
    }
    if (location.accuracyMeters > CAPTURE_GPS_MAX_ACCURACY_METERS) {
        throw new CaptureValidationError("gps_accuracy_too_low", `GPS accuracy must be within ${CAPTURE_GPS_MAX_ACCURACY_METERS} meters.`);
    }
    const locationTimestamp = parseTimestamp(location.capturedAt, "captureLocation.capturedAt");
    const maxFutureMs = CAPTURE_MAX_CLOCK_SKEW_SECONDS * 1000;
    if (photo.time - now > maxFutureMs || locationTimestamp.time - now > maxFutureMs) {
        throw new CaptureValidationError("capture_timestamp_in_future", "Capture timestamps cannot be materially in the future.");
    }
    const gpsAgeAtShutterSeconds = (photo.time - locationTimestamp.time) / 1000;
    if (gpsAgeAtShutterSeconds < -5) {
        throw new CaptureValidationError("gps_fix_after_photo", "The GPS fix timestamp cannot be later than the photo.");
    }
    if (gpsAgeAtShutterSeconds > CAPTURE_GPS_MAX_AGE_SECONDS) {
        throw new CaptureValidationError("stale_capture_location", "The GPS fix was too old when the photo was captured. Re-open the camera and try again.");
    }
    if ((now - photo.time) / 1000 > CAPTURE_MAX_PHOTO_AGE_SECONDS) {
        throw new CaptureValidationError("photo_timestamp_too_old", "The photo timestamp is too old for a new report.");
    }
    return {
        captureMethod: "live_camera",
        cameraFacingMode: input.cameraFacingMode,
        photoCapturedAt: photo.raw,
        captureLocation: {
            lat,
            lng,
            accuracyMeters: location.accuracyMeters,
            capturedAt: locationTimestamp.raw
        },
        gpsAgeAtShutterSeconds: Math.max(0, gpsAgeAtShutterSeconds)
    };
}
export function validateDroneCapture(input, now = Date.now()) {
    if (!["image/jpeg", "image/png", "image/webp"].includes(String(input.imageMimeType || ""))) {
        throw new CaptureValidationError("drone_image_required", "Drone captures must be JPEG, PNG, or WebP images.");
    }
    const hasDimensions = input.width !== undefined || input.height !== undefined;
    if (hasDimensions && (typeof input.width !== "number" || !Number.isInteger(input.width) || input.width <= 0 || input.width > 12000 ||
        typeof input.height !== "number" || !Number.isInteger(input.height) || input.height <= 0 || input.height > 12000)) {
        throw new CaptureValidationError("invalid_capture_dimensions", "Drone image dimensions are invalid.");
    }
    const photo = parseTimestamp(input.photoCapturedAt, "photoCapturedAt");
    const location = input.captureLocation;
    if (!location || typeof location !== "object") {
        throw new CaptureValidationError("capture_location_required", "Drone GPS coordinates are required.");
    }
    const lat = finiteCoordinate(location.lat, "captureLocation.lat", -90, 90);
    const lng = finiteCoordinate(location.lng, "captureLocation.lng", -180, 180);
    if (typeof location.accuracyMeters !== "number" || !Number.isFinite(location.accuracyMeters) || location.accuracyMeters < 0) {
        throw new CaptureValidationError("invalid_gps_accuracy", "Drone GPS accuracy must be a non-negative number.");
    }
    const locationTimestamp = parseTimestamp(location.capturedAt, "captureLocation.capturedAt");
    const maxFutureMs = CAPTURE_MAX_CLOCK_SKEW_SECONDS * 1000;
    if (photo.time - now > maxFutureMs || locationTimestamp.time - now > maxFutureMs) {
        throw new CaptureValidationError("capture_timestamp_in_future", "Drone capture timestamps cannot be materially in the future.");
    }
    const gpsAgeAtShutterSeconds = (photo.time - locationTimestamp.time) / 1000;
    if (gpsAgeAtShutterSeconds < -5) {
        throw new CaptureValidationError("gps_fix_after_photo", "The drone GPS fix timestamp cannot be later than the photo.");
    }
    if ((now - photo.time) / 1000 > CAPTURE_MAX_PHOTO_AGE_SECONDS) {
        throw new CaptureValidationError("photo_timestamp_too_old", "The drone photo timestamp is too old for a new report.");
    }
    return {
        captureMethod: "drone_esp32_cam",
        cameraFacingMode: "drone",
        photoCapturedAt: photo.raw,
        captureLocation: {
            lat,
            lng,
            accuracyMeters: location.accuracyMeters,
            capturedAt: locationTimestamp.raw
        },
        gpsAgeAtShutterSeconds: Math.max(0, gpsAgeAtShutterSeconds)
    };
}
