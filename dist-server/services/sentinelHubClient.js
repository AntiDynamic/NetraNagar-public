import { getSentinelConfig, safeSentinelEndpointHost } from "../config/sentinelConfig.js";
import { fetchWithTimeout } from "../utils/fetchWithTimeout.js";
export class SentinelProviderError extends Error {
    code;
    status;
    retryable;
    retryAfterMs;
    requestId;
    authenticationStatus;
    constructor(code, message, status, retryable = false, retryAfterMs, requestId, authenticationStatus) {
        super(message);
        this.code = code;
        this.status = status;
        this.retryable = retryable;
        this.retryAfterMs = retryAfterMs;
        this.requestId = requestId;
        this.authenticationStatus = authenticationStatus;
        this.name = "SentinelProviderError";
    }
}
let tokenCache;
let tokenPromise;
let authFailureCache;
let lastSuccessfulAuthenticationAt;
let configFingerprint;
function timeoutMs() { return Math.max(1000, Math.min(120000, Number(process.env.SENTINEL_HUB_REQUEST_TIMEOUT_MS || 30000))); }
function maxAttempts() { return Math.max(1, Math.min(5, Number(process.env.SENTINEL_HUB_MAX_ATTEMPTS || 3))); }
function cooldownMs() { return Math.max(1, Math.min(24 * 60, Number(process.env.SENTINEL_HUB_AUTH_FAILURE_COOLDOWN_MINUTES || 15))) * 60000; }
function syncConfigurationCache() {
    const config = getSentinelConfig();
    const nextFingerprint = `${config.provider}|${config.baseUrl}|${config.tokenUrl}|${process.env.SENTINEL_HUB_CLIENT_ID || ""}|${process.env.SENTINEL_HUB_CLIENT_SECRET || ""}`;
    if (configFingerprint && configFingerprint !== nextFingerprint) {
        tokenCache = undefined;
        authFailureCache = undefined;
        lastSuccessfulAuthenticationAt = undefined;
    }
    configFingerprint = nextFingerprint;
    return config;
}
function credentialError(state) {
    if (state === "disabled")
        return new SentinelProviderError("SENTINEL_DISABLED", "Satellite context is disabled.", undefined, false, undefined, undefined, "disabled");
    if (state === "missing_credentials")
        return new SentinelProviderError("SENTINEL_NOT_CONFIGURED", "Satellite credentials are unavailable.", undefined, false, undefined, undefined, "missing_credentials");
    if (state === "placeholder_credentials")
        return new SentinelProviderError("SENTINEL_PLACEHOLDER_CREDENTIALS", "Satellite credentials are placeholders.", undefined, false, undefined, undefined, "placeholder_credentials");
    return new SentinelProviderError("SENTINEL_CONFIGURATION_MISMATCH", "Satellite configuration is invalid.", undefined, false, undefined, undefined, "invalid_configuration");
}
function assertConfigured() {
    const config = syncConfigurationCache();
    if (config.credentialState !== "configured")
        throw credentialError(config.credentialState);
    return config;
}
function classifyFetchError(error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/abort|timeout/i.test(message))
        return new SentinelProviderError("SENTINEL_TIMEOUT", "Sentinel provider request timed out.", undefined, true, undefined, undefined, "timeout");
    return new SentinelProviderError("SENTINEL_NETWORK_ERROR", "Sentinel provider could not be reached.", undefined, true, undefined, undefined, "network_error");
}
function retryAfterMs(response) {
    const raw = response.headers.get("retry-after");
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed >= 0 ? Math.min(parsed * 1000, 30000) : undefined;
}
function providerError(response, requestId) {
    const status = response.status;
    if (status === 401)
        return new SentinelProviderError("SENTINEL_AUTH_FAILED", "Sentinel provider rejected authentication.", status, false, undefined, requestId, "authentication_failed");
    if (status === 403)
        return new SentinelProviderError("SENTINEL_FORBIDDEN", "Sentinel provider denied access.", status, false, undefined, requestId, "forbidden");
    if (status === 429)
        return new SentinelProviderError("SENTINEL_RATE_LIMITED", "Sentinel provider rate limit reached.", status, true, retryAfterMs(response), requestId, "rate_limited");
    if (status >= 500)
        return new SentinelProviderError("SENTINEL_PROVIDER_ERROR", "Sentinel provider is temporarily unavailable.", status, true, undefined, requestId, "provider_error");
    return new SentinelProviderError("SENTINEL_INVALID_REQUEST", "Sentinel provider rejected the request.", status, false, undefined, requestId, "provider_error");
}
function cacheAuthenticationFailure(error) {
    if (error.code === "SENTINEL_AUTH_FAILED" || error.code === "SENTINEL_FORBIDDEN") {
        tokenCache = undefined;
        authFailureCache = { error, expiresAt: Date.now() + cooldownMs() };
    }
}
function activeAuthenticationFailure(force = false) {
    if (!authFailureCache)
        return undefined;
    if (authFailureCache.expiresAt <= Date.now()) {
        authFailureCache = undefined;
        return undefined;
    }
    return force ? undefined : authFailureCache.error;
}
async function waitBeforeRetry(error, attempt) {
    const waitMs = error.retryAfterMs ?? Math.min(500 * 2 ** (attempt - 1), 4000);
    if (waitMs > 0)
        await new Promise((resolve) => setTimeout(resolve, waitMs));
}
async function tokenRequest(forceRefresh) {
    const config = assertConfigured();
    const cachedFailure = activeAuthenticationFailure(forceRefresh);
    if (cachedFailure)
        throw cachedFailure;
    const now = Date.now();
    if (!forceRefresh && tokenCache && tokenCache.expiresAt > now + 60000)
        return tokenCache.accessToken;
    if (tokenPromise)
        return tokenPromise;
    tokenPromise = (async () => {
        const params = new URLSearchParams({
            grant_type: "client_credentials",
            client_id: process.env.SENTINEL_HUB_CLIENT_ID,
            client_secret: process.env.SENTINEL_HUB_CLIENT_SECRET
        });
        for (let attempt = 1; attempt <= maxAttempts(); attempt++) {
            let response;
            try {
                response = await fetchWithTimeout(config.tokenUrl, {
                    method: "POST",
                    headers: { "Content-Type": "application/x-www-form-urlencoded" },
                    body: params.toString()
                }, timeoutMs());
            }
            catch (error) {
                const shaped = classifyFetchError(error);
                if (attempt < maxAttempts()) {
                    await waitBeforeRetry(shaped, attempt);
                    continue;
                }
                throw shaped;
            }
            const requestId = response.headers.get("x-request-id") || response.headers.get("x-correlation-id") || undefined;
            if (!response.ok) {
                const shaped = providerError(response, requestId);
                cacheAuthenticationFailure(shaped);
                if (shaped.retryable && attempt < maxAttempts()) {
                    await waitBeforeRetry(shaped, attempt);
                    continue;
                }
                throw shaped;
            }
            let body;
            try {
                body = await response.json();
            }
            catch {
                throw new SentinelProviderError("SENTINEL_INVALID_RESPONSE", "Sentinel authentication response was malformed.", response.status, false, undefined, requestId, "invalid_response");
            }
            const accessToken = typeof body.access_token === "string" ? body.access_token : "";
            const expiresIn = typeof body.expires_in === "number" ? body.expires_in : Number(body.expires_in);
            if (!accessToken || !Number.isFinite(expiresIn))
                throw new SentinelProviderError("SENTINEL_INVALID_RESPONSE", "Sentinel authentication response was incomplete.", response.status, false, undefined, requestId, "invalid_response");
            tokenCache = { accessToken, expiresAt: Date.now() + Math.max(60, expiresIn) * 1000 };
            authFailureCache = undefined;
            lastSuccessfulAuthenticationAt = new Date().toISOString();
            return accessToken;
        }
        throw new SentinelProviderError("SENTINEL_PROVIDER_ERROR", "Sentinel authentication attempts were exhausted.", undefined, true, undefined, undefined, "provider_error");
    })().finally(() => { tokenPromise = undefined; });
    return tokenPromise;
}
export function sentinelCredentialState() { return syncConfigurationCache().credentialState; }
export function sentinelHubConfigured() { return sentinelCredentialState() === "configured"; }
export function invalidateSentinelHubToken() { tokenCache = undefined; }
export function resetSentinelHubClientForTests() { tokenCache = undefined; tokenPromise = undefined; authFailureCache = undefined; lastSuccessfulAuthenticationAt = undefined; configFingerprint = undefined; }
export function getSentinelVerificationReadiness() {
    const config = syncConfigurationCache();
    const cachedFailure = activeAuthenticationFailure();
    if (config.credentialState !== "configured")
        return { ready: false, status: credentialError(config.credentialState).authenticationStatus, errorCode: credentialError(config.credentialState).code };
    if (cachedFailure)
        return { ready: false, status: cachedFailure.authenticationStatus || "authentication_failed", errorCode: cachedFailure.code };
    return { ready: true, status: "authentication_successful", errorCode: undefined };
}
export async function getSentinelHubAccessToken(forceRefresh = false) {
    return tokenRequest(forceRefresh);
}
export async function requestSentinelHub(path, init = {}, responseType = "json") {
    const config = assertConfigured();
    const blocked = activeAuthenticationFailure();
    if (blocked)
        throw blocked;
    for (let attempt = 1; attempt <= maxAttempts(); attempt++) {
        const token = await getSentinelHubAccessToken();
        const headers = new Headers(init.headers);
        headers.set("Authorization", `Bearer ${token}`);
        headers.set("Accept", headers.get("Accept") || "application/json");
        if (init.body && !headers.has("Content-Type"))
            headers.set("Content-Type", "application/json");
        let response;
        try {
            response = await fetchWithTimeout(`${config.baseUrl}${path.startsWith("/") ? path : `/${path}`}`, { ...init, headers }, timeoutMs());
        }
        catch (error) {
            const shaped = classifyFetchError(error);
            if (attempt < maxAttempts()) {
                await waitBeforeRetry(shaped, attempt);
                continue;
            }
            throw shaped;
        }
        const requestId = response.headers.get("x-request-id") || response.headers.get("x-correlation-id") || undefined;
        if (!response.ok) {
            const shaped = providerError(response, requestId);
            cacheAuthenticationFailure(shaped);
            if (shaped.retryable && attempt < maxAttempts()) {
                await waitBeforeRetry(shaped, attempt);
                continue;
            }
            throw shaped;
        }
        try {
            const data = responseType === "buffer" ? await response.arrayBuffer().then((value) => Buffer.from(value)) : await response.json();
            return { data, response };
        }
        catch {
            throw new SentinelProviderError("SENTINEL_INVALID_RESPONSE", "Sentinel provider returned a malformed response.", response.status, false, undefined, requestId, "invalid_response");
        }
    }
    throw new SentinelProviderError("SENTINEL_PROVIDER_ERROR", "Sentinel provider request attempts were exhausted.", undefined, true, undefined, undefined, "provider_error");
}
export async function getSentinelHubAuthStatus() {
    const config = syncConfigurationCache();
    const cachedFailure = activeAuthenticationFailure();
    return {
        enabled: config.enabled,
        provider: config.provider,
        configured: config.credentialState === "configured",
        configurationValid: config.validationErrors.length === 0,
        authenticationStatus: cachedFailure?.authenticationStatus || (lastSuccessfulAuthenticationAt ? "authentication_successful" : config.credentialState),
        authenticationErrorCode: cachedFailure?.code || (config.credentialState === "configured" ? null : credentialError(config.credentialState).code),
        baseEndpointHost: safeSentinelEndpointHost(config.baseUrl),
        tokenEndpointHost: safeSentinelEndpointHost(config.tokenUrl),
        cooldownActive: Boolean(cachedFailure),
        lastSuccessfulAuthenticationAt,
        tokenExpiresInSeconds: tokenCache ? Math.max(0, Math.floor((tokenCache.expiresAt - Date.now()) / 1000)) : undefined
    };
}
