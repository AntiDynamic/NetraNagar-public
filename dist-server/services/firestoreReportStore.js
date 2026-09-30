/**
 * server/services/firestoreReportStore.ts
 *
 * Firestore adapter for PollutionReport persistence.
 * Uses the centralized Firebase Admin SDK from adminApp.ts.
 *
 * All writes strip large base64 fields to keep documents lean.
 * Timestamps are normalized to ISO strings on read.
 */
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getAdminApp, adminAvailable } from "./adminApp.js";
const COLLECTION = "reports";
const MAX_LIST = 200;
function db() {
    const app = getAdminApp();
    if (!app)
        return null;
    return getFirestore(app);
}
export function firestoreEnabled() {
    return adminAvailable();
}
/**
 * Strip raw base64 image data from a report before writing to Firestore.
 * We store only metadata — never large blobs.
 */
function sanitizeForFirestore(report) {
    const sanitized = { ...report };
    // Strip any accidentally-attached base64 blobs
    delete sanitized["imageBase64"];
    delete sanitized["originalBase64"];
    delete sanitized["thumbnailBase64"];
    // Ensure nested media array doesn't contain base64
    if (Array.isArray(sanitized["media"])) {
        sanitized["media"] = sanitized["media"].map((m) => {
            const clean = { ...m };
            delete clean["base64"];
            delete clean["originalBase64"];
            return clean;
        });
    }
    // Recursively remove undefined values which Firestore rejects
    const removeUndefined = (obj) => {
        if (Array.isArray(obj)) {
            return obj.map(removeUndefined);
        }
        else if (obj !== null && typeof obj === "object") {
            return Object.fromEntries(Object.entries(obj)
                .filter(([_, v]) => v !== undefined)
                .map(([k, v]) => [k, removeUndefined(v)]));
        }
        return obj;
    };
    return removeUndefined(sanitized);
}
/**
 * Normalize Firestore Timestamps to ISO strings on read.
 * Firestore returns Timestamp objects for date fields stored as server timestamps.
 */
function normalizeTimestamps(data) {
    const normalize = (val) => {
        if (val && typeof val === "object" && "toDate" in val) {
            return val.toDate().toISOString();
        }
        if (val && typeof val === "object" && !Array.isArray(val)) {
            return Object.fromEntries(Object.entries(val).map(([k, v]) => [k, normalize(v)]));
        }
        if (Array.isArray(val))
            return val.map(normalize);
        return val;
    };
    return normalize(data);
}
export async function saveReportToFirestore(report) {
    const firestore = db();
    if (!firestore) {
        return { persisted: false, reason: "Firebase Admin not configured — using local dev store." };
    }
    try {
        const payload = {
            ...sanitizeForFirestore(report),
            _serverUpdatedAt: FieldValue.serverTimestamp()
        };
        await firestore.collection(COLLECTION).doc(report.id).set(payload, { merge: true });
        return { persisted: true, reason: "Persisted to Firestore." };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[Firestore] saveReport(${report.id}) failed:`, msg);
        return { persisted: false, reason: `Firestore write failed: ${msg}` };
    }
}
export async function listFirestoreReports() {
    const firestore = db();
    if (!firestore)
        return null;
    try {
        const snapshot = await firestore
            .collection(COLLECTION)
            .orderBy("createdAt", "desc")
            .limit(MAX_LIST)
            .get();
        return snapshot.docs.map((doc) => normalizeTimestamps(doc.data()));
    }
    catch (err) {
        console.error("[Firestore] listReports failed:", err instanceof Error ? err.message : err);
        return null;
    }
}
export async function findFirestoreReport(id) {
    const firestore = db();
    if (!firestore)
        return null;
    try {
        const snapshot = await firestore.collection(COLLECTION).doc(id).get();
        if (!snapshot.exists)
            return null;
        return normalizeTimestamps(snapshot.data());
    }
    catch (err) {
        console.error(`[Firestore] findReport(${id}) failed:`, err instanceof Error ? err.message : err);
        return null;
    }
}
export async function updateFirestoreReport(id, patch) {
    const firestore = db();
    if (!firestore)
        return null;
    try {
        const ref = firestore.collection(COLLECTION).doc(id);
        const existing = await ref.get();
        if (!existing.exists)
            return null;
        const base = normalizeTimestamps(existing.data());
        const next = { ...base, ...patch, updatedAt: new Date().toISOString() };
        await ref.set({
            ...sanitizeForFirestore(next),
            _serverUpdatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        return next;
    }
    catch (err) {
        console.error(`[Firestore] updateReport(${id}) failed:`, err instanceof Error ? err.message : err);
        return null;
    }
}
export async function listFirestoreReportsByUser(userId) {
    const firestore = db();
    if (!firestore)
        return null;
    try {
        const snapshot = await firestore
            .collection(COLLECTION)
            .where("userId", "==", userId)
            .orderBy("createdAt", "desc")
            .limit(50)
            .get();
        return snapshot.docs.map((doc) => normalizeTimestamps(doc.data()));
    }
    catch (err) {
        console.error(`[Firestore] listByUser(${userId}) failed:`, err instanceof Error ? err.message : err);
        return null;
    }
}
