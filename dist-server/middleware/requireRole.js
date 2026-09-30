import { authenticate } from "./auth.js";
export const requireAuthenticatedUser = authenticate;
export function requireAnyRole(...roles) {
    return (req, res, next) => {
        if (!req.auth)
            return authenticate(req, res, () => requireAnyRole(...roles)(req, res, next));
        if (!roles.includes(req.auth.role))
            return res.status(403).json({ error: "You do not have permission to perform this action.", reasonCode: "forbidden" });
        if (req.auth.role === "municipal" && !req.auth.municipalTeamId)
            return res.status(403).json({ error: "A Municipal team is required.", reasonCode: "municipal_team_not_configured" });
        next();
    };
}
export const requireRole = (role) => requireAnyRole(role);
export const requireCitizen = requireRole("citizen");
export const requireMunicipal = requireRole("municipal");
export const requireOfficer = requireRole("officer");
