import { ExternalAccountClient, GoogleAuth } from "google-auth-library";
import { getVercelOidcToken } from "@vercel/oidc";
export class EarthEngineProviderError extends Error {
    code;
    retryable;
    constructor(code, message, retryable) {
        super(message);
        this.code = code;
        this.retryable = retryable;
        this.name = "EarthEngineProviderError";
    }
}
const EARTH_ENGINE_SCOPE = "https://www.googleapis.com/auth/earthengine";
const endpoint = "https://earthengine.googleapis.com/v1";
function enabled() { return process.env.ENABLE_EARTH_ENGINE === "true"; }
function projectId() { return process.env.GOOGLE_CLOUD_PROJECT?.trim() || process.env.GCLOUD_PROJECT?.trim(); }
function vercelWorkloadIdentityConfig() {
    const projectNumber = process.env.GCP_PROJECT_NUMBER?.trim();
    const serviceAccountEmail = process.env.GCP_SERVICE_ACCOUNT_EMAIL?.trim();
    const poolId = process.env.GCP_WORKLOAD_IDENTITY_POOL_ID?.trim();
    const providerId = process.env.GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID?.trim();
    if (!projectNumber || !serviceAccountEmail || !poolId || !providerId)
        return null;
    return { projectNumber, serviceAccountEmail, poolId, providerId };
}
function bounded(name, fallback, min, max) {
    const value = Number(process.env[name]);
    return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}
export function earthEngineRadiusMeters() { return bounded("EARTH_ENGINE_ANALYSIS_RADIUS_METERS", 1000, 250, 5000); }
export function earthEngineTimeoutMs() { return bounded("EARTH_ENGINE_TIMEOUT_MS", 8000, 2000, 30000); }
function earthEngineCacheTtlMs() { return bounded("EARTH_ENGINE_CACHE_TTL_MINUTES", 360, 5, 1440) * 60_000; }
const no2Cache = new Map();
export function getEarthEngineReadiness() {
    if (!enabled())
        return { enabled: false, configured: false, authenticationStatus: "disabled", errorCode: "EARTH_ENGINE_DISABLED" };
    const project = projectId();
    if (!project)
        return { enabled: true, configured: false, authenticationStatus: "not_configured", errorCode: "EARTH_ENGINE_PROJECT_MISSING" };
    return { enabled: true, configured: true, projectId: project, authenticationStatus: "ready" };
}
function constant(value) { return { constantValue: value }; }
function array(values) { return { arrayValue: { values: values.map(constant) } }; }
function invoke(functionName, arguments_) {
    return { functionInvocationValue: { functionName, arguments: arguments_ } };
}
async function authenticatedRequest(path, init) {
    const readiness = getEarthEngineReadiness();
    if (!readiness.configured || !readiness.projectId)
        throw new EarthEngineProviderError(readiness.errorCode || "EARTH_ENGINE_NOT_CONFIGURED", "Google Earth Engine is not configured.", false);
    const workloadIdentity = process.env.VERCEL === "1" ? vercelWorkloadIdentityConfig() : null;
    const client = workloadIdentity
        ? ExternalAccountClient.fromJSON({
            type: "external_account",
            audience: `//iam.googleapis.com/projects/${workloadIdentity.projectNumber}/locations/global/workloadIdentityPools/${workloadIdentity.poolId}/providers/${workloadIdentity.providerId}`,
            subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
            token_url: "https://sts.googleapis.com/v1/token",
            service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${workloadIdentity.serviceAccountEmail}:generateAccessToken`,
            subject_token_supplier: { getSubjectToken: getVercelOidcToken }
        })
        : await new GoogleAuth({ scopes: [EARTH_ENGINE_SCOPE, "https://www.googleapis.com/auth/cloud-platform"] }).getClient();
    if (!client)
        throw new EarthEngineProviderError("EARTH_ENGINE_AUTH", "Google Earth Engine workload identity is not configured.", false);
    const headers = await client.getRequestHeaders();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), earthEngineTimeoutMs());
    try {
        return await fetch(`${endpoint}${path}`, {
            ...init,
            signal: controller.signal,
            headers: { ...headers, "x-goog-user-project": readiness.projectId, ...init.headers }
        });
    }
    catch (error) {
        if (error instanceof DOMException && error.name === "AbortError")
            throw new EarthEngineProviderError("EARTH_ENGINE_TIMEOUT", "Google Earth Engine timed out.", true);
        throw new EarthEngineProviderError("EARTH_ENGINE_NETWORK", "Google Earth Engine is unavailable.", true);
    }
    finally {
        clearTimeout(timeout);
    }
}
async function earthEngineJson(path, init) {
    const response = await authenticatedRequest(path, init);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
        const code = response.status === 401 || response.status === 403 ? "EARTH_ENGINE_AUTH" : response.status === 429 ? "EARTH_ENGINE_RATE_LIMITED" : "EARTH_ENGINE_PROVIDER";
        throw new EarthEngineProviderError(code, body.error?.message || "Google Earth Engine request failed.", response.status >= 500 || response.status === 429);
    }
    return body;
}
export async function checkEarthEngineConnection() {
    const readiness = getEarthEngineReadiness();
    if (!readiness.configured || !readiness.projectId)
        return { ...readiness, reachable: false, algorithmCount: 0 };
    try {
        const result = await earthEngineJson(`/projects/${encodeURIComponent(readiness.projectId)}/algorithms`, { method: "GET" });
        return { ...readiness, reachable: true, algorithmCount: result.algorithms?.length || 0 };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "Google Earth Engine connection failed.";
        return { ...readiness, reachable: false, authenticationStatus: "unavailable", errorCode: error instanceof EarthEngineProviderError ? error.code : "EARTH_ENGINE_PROVIDER", message, algorithmCount: 0 };
    }
}
/**
 * Computes a bounded local mean from the public Sentinel-5P NO2 collection.
 * The expression graph is sent only from the backend using ADC; no credential
 * or Earth Engine request reaches the browser.
 */
export async function getEarthEngineNo2Context(lat, lng) {
    const cacheKey = `${lat.toFixed(3)}:${lng.toFixed(3)}:${earthEngineRadiusMeters()}`;
    const cached = no2Cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now())
        return cached.value;
    const readiness = getEarthEngineReadiness();
    if (!readiness.configured || !readiness.projectId)
        throw new EarthEngineProviderError(readiness.errorCode || "EARTH_ENGINE_NOT_CONFIGURED", "Google Earth Engine is not configured.", false);
    const radiusMeters = earthEngineRadiusMeters();
    const fourteenDaysAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
    const point = invoke("GeometryConstructors.Point", { coordinates: array([lng, lat]) });
    const region = invoke("Geometry.buffer", { geometry: point, distance: constant(radiusMeters) });
    const collection = invoke("ImageCollection.load", { id: constant("COPERNICUS/S5P/OFFL/L3_NO2") });
    const recentCollection = invoke("Collection.filter", { collection, filter: constant(`system:time_start > ${fourteenDaysAgo}`) });
    const no2Image = invoke("Image.select", {
        input: invoke("ImageCollection.mosaic", { collection: recentCollection }),
        bandSelectors: array(["tropospheric_NO2_column_number_density"])
    });
    const reduced = invoke("Image.reduceRegion", {
        image: no2Image,
        reducer: invoke("Reducer.mean", {}),
        geometry: region,
        scale: constant(1000),
        bestEffort: constant(true),
        maxPixels: { integerValue: "10000" }
    });
    const result = await earthEngineJson(`/projects/${encodeURIComponent(readiness.projectId)}/value:compute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expression: { values: { result: reduced }, result: "result" }, workloadTag: "netranagar-no2-context" })
    });
    const meanNo2 = Number(result.result?.tropospheric_NO2_column_number_density);
    if (!Number.isFinite(meanNo2))
        throw new EarthEngineProviderError("EARTH_ENGINE_NO_DATA", "Earth Engine returned no recent Sentinel-5P NO₂ value for this area.", false);
    const value = { meanNo2, dataset: "COPERNICUS/S5P/OFFL/L3_NO2", radiusMeters, queriedAt: new Date().toISOString() };
    no2Cache.set(cacheKey, { value, expiresAt: Date.now() + earthEngineCacheTtlMs() });
    return value;
}
