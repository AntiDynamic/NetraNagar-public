/**
 * server/services/adminApp.ts
 *
 * Single Firebase Admin SDK initialization point.
 *
 * Auth methods (tried in order):
 *   A) GOOGLE_APPLICATION_CREDENTIALS — path to service account JSON (recommended for local dev)
 *   B) Inline FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY — for CI/CD
 *   C) Application Default Credentials — Cloud Run / GCE / `gcloud auth application-default login`
 *
 * NOTE: Firebase Storage is intentionally NOT initialized here.
 * Storage is not available on the Firebase Spark (free) plan.
 * All media is stored locally and served via Express /media route.
 *
 * Returns null (gracefully) if no Firebase config is present —
 * all services fall back to dev-mode alternatives (in-memory store, local files).
 */
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
let _adminApp = null;
let _initialized = false;
export function getAdminApp() {
    if (_initialized)
        return _adminApp;
    _initialized = true;
    const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;
    if (!projectId) {
        console.warn("[Firebase Admin] FIREBASE_PROJECT_ID not set — local dev mode (no Firestore).");
        return null;
    }
    // Reuse an already-initialized app
    if (getApps().length > 0) {
        _adminApp = getApps()[0];
        console.info("[Firebase Admin] Reusing existing app instance.");
        return _adminApp;
    }
    try {
        // Option A: Inline service account credentials (CI/CD)
        const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
        const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
        if (clientEmail && privateKey) {
            _adminApp = initializeApp({
                credential: cert({ projectId, clientEmail, privateKey })
                // No storageBucket — Storage not used on Spark plan
            });
            console.info(`[Firebase Admin] ✓ Initialized with inline service account (${clientEmail})`);
            return _adminApp;
        }
        // Option B: GOOGLE_APPLICATION_CREDENTIALS env var (path to JSON — local dev)
        if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
            _adminApp = initializeApp({ projectId });
            console.info(`[Firebase Admin] ✓ Initialized via GOOGLE_APPLICATION_CREDENTIALS → ${process.env.GOOGLE_APPLICATION_CREDENTIALS}`);
            return _adminApp;
        }
        // Option C: Application Default Credentials (Cloud Run, GCE)
        _adminApp = initializeApp({ projectId });
        console.info("[Firebase Admin] ✓ Initialized via Application Default Credentials");
        return _adminApp;
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[Firebase Admin] Initialization failed:", msg);
        console.warn("[Firebase Admin] Falling back to local dev mode.");
        return null;
    }
}
/** Returns true if Firebase Admin is properly configured */
export function adminAvailable() {
    return getAdminApp() !== null;
}
export function getAdminAuth() {
    const app = getAdminApp();
    return app ? getAuth(app) : null;
}
