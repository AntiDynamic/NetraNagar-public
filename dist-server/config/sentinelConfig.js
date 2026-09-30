const presets = {
    cdse: {
        baseUrl: "https://sh.dataspace.copernicus.eu",
        tokenUrl: "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token"
    },
    commercial: {
        baseUrl: "https://services.sentinel-hub.com",
        tokenUrl: "https://services.sentinel-hub.com/auth/realms/main/protocol/openid-connect/token"
    }
};
function isEnabled() {
    return (process.env.ENABLE_SENTINEL_HUB_VERIFICATION || "false").trim().toLowerCase() === "true";
}
function isPlaceholder(value) {
    if (!value?.trim())
        return false;
    const upper = value.trim().toUpperCase();
    return upper.includes("YOUR_") || upper.includes("PLACEHOLDER") || upper === "EXAMPLE" || upper === "CHANGE_ME";
}
function normalizeUrl(value) {
    return value?.trim().replace(/\/$/, "") || "";
}
function parseHttpsUrl(value, label, errors) {
    try {
        const url = new URL(value);
        if (process.env.NODE_ENV === "production" && url.protocol !== "https:")
            errors.push(`${label} must use HTTPS in production.`);
        return url;
    }
    catch {
        errors.push(`${label} is malformed.`);
        return undefined;
    }
}
function providerFromEnvironment(errors) {
    const raw = (process.env.SENTINEL_HUB_PROVIDER || "commercial").trim().toLowerCase();
    if (raw === "cdse" || raw === "commercial" || raw === "custom")
        return raw;
    errors.push("SENTINEL_HUB_PROVIDER must be cdse, commercial, or custom.");
    return "custom";
}
function expectedEndpoint(provider, base, token, errors) {
    const expected = presets[provider];
    const expectedBase = new URL(expected.baseUrl);
    const expectedToken = new URL(expected.tokenUrl);
    if (base.host !== expectedBase.host || token.host !== expectedToken.host || token.pathname !== expectedToken.pathname) {
        errors.push("SENTINEL_CONFIGURATION_MISMATCH: provider endpoints do not match the selected provider.");
    }
}
/** Resolves and validates the server-only Sentinel provider configuration. */
export function getSentinelConfig() {
    const validationErrors = [];
    const provider = providerFromEnvironment(validationErrors);
    const explicitBase = normalizeUrl(process.env.SENTINEL_HUB_BASE_URL);
    const explicitToken = normalizeUrl(process.env.SENTINEL_HUB_TOKEN_URL);
    const hasAnyExplicitEndpoint = Boolean(explicitBase || explicitToken);
    const hasBothExplicitEndpoints = Boolean(explicitBase && explicitToken);
    if (hasAnyExplicitEndpoint && !hasBothExplicitEndpoints) {
        validationErrors.push("SENTINEL_HUB_BASE_URL and SENTINEL_HUB_TOKEN_URL must be set together.");
    }
    if (provider === "custom" && !hasBothExplicitEndpoints) {
        validationErrors.push("Custom Sentinel provider requires both endpoint URLs.");
    }
    const preset = provider === "custom" ? undefined : presets[provider];
    const baseUrl = hasBothExplicitEndpoints ? explicitBase : preset?.baseUrl || "";
    const tokenUrl = hasBothExplicitEndpoints ? explicitToken : preset?.tokenUrl || "";
    const base = baseUrl ? parseHttpsUrl(baseUrl, "SENTINEL_HUB_BASE_URL", validationErrors) : undefined;
    const token = tokenUrl ? parseHttpsUrl(tokenUrl, "SENTINEL_HUB_TOKEN_URL", validationErrors) : undefined;
    if (base && token && provider !== "custom")
        expectedEndpoint(provider, base, token, validationErrors);
    const enabled = isEnabled();
    const clientId = process.env.SENTINEL_HUB_CLIENT_ID;
    const clientSecret = process.env.SENTINEL_HUB_CLIENT_SECRET;
    const credentialState = !enabled
        ? "disabled"
        : validationErrors.length > 0
            ? "invalid_configuration"
            : !clientId?.trim() || !clientSecret?.trim()
                ? "missing_credentials"
                : isPlaceholder(clientId) || isPlaceholder(clientSecret)
                    ? "placeholder_credentials"
                    : "configured";
    return { enabled, provider, baseUrl, tokenUrl, credentialState, validationErrors };
}
export function safeSentinelEndpointHost(value) {
    try {
        return new URL(value).host;
    }
    catch {
        return undefined;
    }
}
