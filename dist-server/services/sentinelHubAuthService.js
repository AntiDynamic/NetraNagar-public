import { getSentinelHubAccessToken, getSentinelHubAuthStatus, getSentinelVerificationReadiness, sentinelHubConfigured, sentinelCredentialState, SentinelProviderError } from "./sentinelHubClient.js";
export { getSentinelHubAccessToken, getSentinelHubAuthStatus, getSentinelVerificationReadiness, sentinelHubConfigured, sentinelCredentialState, SentinelProviderError };
export async function testTokenCheck(force = false) {
    const readiness = getSentinelVerificationReadiness();
    if (!readiness.ready && !force)
        return { ok: false, status: readiness.status, errorCode: readiness.errorCode };
    try {
        await getSentinelHubAccessToken(force);
        const status = await getSentinelHubAuthStatus();
        return { ok: true, status: "authentication_successful", tokenExpiresInSeconds: status.tokenExpiresInSeconds };
    }
    catch (error) {
        const shaped = error instanceof SentinelProviderError ? error : undefined;
        return {
            ok: false,
            status: shaped?.authenticationStatus || "provider_error",
            errorCode: shaped?.code || "SENTINEL_PROVIDER_ERROR"
        };
    }
}
