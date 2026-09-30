import { getAdminAuth } from "../services/adminApp.js";
let loggedDemo = false;
function demoOverrides() {
    if (process.env.ENABLE_DEMO_AUTH !== "true")
        return {};
    if (!loggedDemo) {
        console.warn("[Auth] Demo authorization overrides are enabled.");
        loggedDemo = true;
    }
    try {
        const value = JSON.parse(process.env.DEMO_ROLE_OVERRIDES_JSON || "{}");
        return value && typeof value === "object" ? value : {};
    }
    catch {
        return {};
    }
}
function role(value) { return value === "municipal" || value === "officer" || value === "citizen" ? value : "citizen"; }
export async function authenticate(req, res, next) {
    const header = req.header("authorization");
    if (!header)
        return res.status(401).json({ error: "Authentication is required.", reasonCode: "authentication_required" });
    const match = /^Bearer\s+(.+)$/.exec(header);
    if (!match || !match[1].trim())
        return res.status(401).json({ error: "A valid Bearer token is required.", reasonCode: "invalid_authorization_header" });
    const auth = getAdminAuth();
    if (!auth)
        return res.status(401).json({ error: "The authentication token is invalid or expired.", reasonCode: "invalid_authentication_token" });
    try {
        const token = await auth.verifyIdToken(match[1]);
        const override = demoOverrides()[token.uid];
        const resolvedRole = role(override?.role ?? token.role);
        const municipalTeamId = resolvedRole === "municipal" ? (override?.municipalTeamId ?? (typeof token.municipalTeamId === "string" ? token.municipalTeamId : undefined)) : undefined;
        req.auth = { uid: token.uid, role: resolvedRole, ...(municipalTeamId ? { municipalTeamId } : {}) };
        next();
    }
    catch {
        return res.status(401).json({ error: "The authentication token is invalid or expired.", reasonCode: "invalid_authentication_token" });
    }
}
/** Attach a verified Firebase identity when a Bearer token is supplied, but
 * retain explicit local/demo operation when no token exists. Invalid supplied
 * tokens are rejected rather than silently treated as anonymous. */
export async function optionalAuthenticate(req, res, next) {
    if (!req.header("authorization"))
        return next();
    return authenticate(req, res, next);
}
