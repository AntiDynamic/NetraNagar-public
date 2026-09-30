import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parse } from "dotenv";
function keyMetadata(value) {
    const trimmed = value?.trim() || "";
    return {
        configured: Boolean(trimmed),
        rawLength: value?.length || 0,
        trimmedLength: trimmed.length,
        fingerprint: trimmed
            ? crypto.createHash("sha256").update(trimmed).digest("hex").slice(0, 12)
            : null
    };
}
function repositoryDotenv(cwd) {
    const repositoryRoot = path.resolve(cwd);
    const dotenvPath = path.join(repositoryRoot, ".env");
    if (!fs.existsSync(dotenvPath)) {
        return { repositoryRoot, dotenvPath, exists: false, value: undefined };
    }
    const parsed = parse(fs.readFileSync(dotenvPath, "utf8"));
    return { repositoryRoot, dotenvPath, exists: true, value: parsed.OPENAQ_API_KEY };
}
export function inspectOpenAqEnvironment(options = {}) {
    const cwd = options.cwd || process.cwd();
    const file = repositoryDotenv(cwd);
    const processKey = options.processKey === undefined ? process.env.OPENAQ_API_KEY : options.processKey;
    const dotenvKey = options.dotenvKey === undefined ? file.value : options.dotenvKey;
    const processTrimmed = processKey?.trim() || "";
    const dotenvTrimmed = dotenvKey?.trim() || "";
    const bothConfigured = Boolean(processTrimmed && dotenvTrimmed);
    const valuesMatch = bothConfigured && processTrimmed === dotenvTrimmed;
    const conflictDetected = bothConfigured && !valuesMatch;
    const effectiveSource = conflictDetected
        ? "process_environment"
        : processTrimmed && !dotenvTrimmed
            ? "process_environment"
            : dotenvTrimmed
                ? "repository_dotenv"
                : "unavailable";
    return {
        cwd,
        repositoryRoot: file.repositoryRoot,
        dotenvPath: file.dotenvPath,
        processEnvironment: keyMetadata(processKey),
        dotenvFile: { ...keyMetadata(dotenvKey), exists: file.exists },
        valuesMatch,
        effectiveSource,
        conflictDetected
    };
}
export function getEffectiveOpenAqApiKey() {
    const diagnostics = inspectOpenAqEnvironment();
    if (diagnostics.conflictDetected) {
        throw new Error("OPENAQ_ENV_CONFLICT");
    }
    const current = process.env.OPENAQ_API_KEY?.trim();
    if (current)
        return current;
    if (diagnostics.effectiveSource === "repository_dotenv") {
        const parsed = parse(fs.readFileSync(diagnostics.dotenvPath, "utf8"));
        const fromFile = parsed.OPENAQ_API_KEY?.trim();
        if (fromFile)
            return fromFile;
    }
    throw new Error("OPENAQ_NOT_CONFIGURED");
}
