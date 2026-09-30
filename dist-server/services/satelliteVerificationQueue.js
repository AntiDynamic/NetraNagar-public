import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { verifyReportWithSatellite } from "./satelliteVerificationService.js";
import { getEarthEngineReadiness } from "./earthEngineService.js";
const jobsPath = path.join(process.cwd(), "server", "data", "cache", "satellite-jobs.json");
const jobs = new Map();
let loaded = false;
let processing = false;
const workerId = `satellite-${randomUUID()}`;
export class SatelliteQueueUnavailableError extends Error {
    status;
    code;
    constructor(status, code) {
        super("Satellite verification is unavailable.");
        this.status = status;
        this.code = code;
        this.name = "SatelliteQueueUnavailableError";
    }
}
async function persist() {
    if (process.env.NODE_ENV === "production" || process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME)
        return;
    await mkdir(path.dirname(jobsPath), { recursive: true });
    await writeFile(jobsPath, JSON.stringify(Array.from(jobs.values()), null, 2), "utf8");
}
async function hydrate() {
    if (process.env.NODE_ENV === "production" || process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME)
        return;
    if (loaded)
        return;
    loaded = true;
    try {
        const data = JSON.parse(await readFile(jobsPath, "utf8"));
        for (const job of Array.isArray(data) ? data : [])
            jobs.set(job.jobId, job);
    }
    catch { /* first local run */ }
    const now = Date.now();
    for (const job of jobs.values()) {
        if (job.status === "claimed" && job.leaseExpiresAt && Date.parse(job.leaseExpiresAt) <= now) {
            job.status = "retry_wait";
            job.nextAttemptAt = new Date().toISOString();
            job.leaseOwner = undefined;
            job.leaseExpiresAt = undefined;
            job.updatedAt = new Date().toISOString();
        }
    }
    await persist();
}
function maxAttempts() { return Math.max(1, Math.min(6, Number(process.env.EARTH_ENGINE_MAX_ATTEMPTS || 3))); }
function concurrency() { return Math.max(1, Math.min(4, Number(process.env.EARTH_ENGINE_VERIFY_CONCURRENCY || 1))); }
export async function enqueueSatelliteVerification(reportId, reportRevision = "current") {
    const readiness = getEarthEngineReadiness();
    if (!readiness.configured)
        throw new SatelliteQueueUnavailableError(readiness.authenticationStatus, readiness.errorCode);
    await hydrate();
    const active = Array.from(jobs.values()).find(job => job.reportId === reportId && job.reportRevision === reportRevision && ["pending", "claimed", "retry_wait"].includes(job.status));
    if (active) {
        void processQueue();
        return active;
    }
    const now = new Date().toISOString();
    const job = { jobId: randomUUID(), reportId, reportRevision, status: "pending", attempts: 0, maxAttempts: maxAttempts(), nextAttemptAt: now, createdAt: now, updatedAt: now };
    jobs.set(job.jobId, job);
    await persist();
    void processQueue();
    return job;
}
export async function getSatelliteQueueStatus() {
    await hydrate();
    const values = Array.from(jobs.values());
    return { pending: values.filter(job => job.status === "pending" || job.status === "retry_wait").length, running: values.filter(job => job.status === "claimed").length, completed: values.filter(job => job.status === "completed").length, failed: values.filter(job => job.status === "failed" || job.status === "dead_letter").length, deadLetter: values.filter(job => job.status === "dead_letter").length, durableStore: jobsPath };
}
async function processOne(job) {
    job.status = "claimed";
    job.attempts += 1;
    job.leaseOwner = workerId;
    job.leaseExpiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    job.updatedAt = new Date().toISOString();
    await persist();
    try {
        const result = await verifyReportWithSatellite(job.reportId);
        if (result.success) {
            job.status = "completed";
        }
        else if (result.retryable && job.attempts < job.maxAttempts) {
            job.status = "retry_wait";
            job.nextAttemptAt = new Date(Date.now() + Math.min(60000, 1000 * 2 ** (job.attempts - 1))).toISOString();
            job.lastError = result.evidence?.error?.message || "Satellite job returned a retryable failure.";
        }
        else {
            job.status = "dead_letter";
            job.lastError = result.evidence?.error?.message || "Satellite job failed permanently.";
        }
    }
    catch (error) {
        const retryable = job.attempts < job.maxAttempts;
        job.status = retryable ? "retry_wait" : "dead_letter";
        job.nextAttemptAt = new Date(Date.now() + Math.min(60000, 1000 * 2 ** (job.attempts - 1))).toISOString();
        job.lastError = error instanceof Error ? error.message : String(error);
    }
    finally {
        job.leaseOwner = undefined;
        job.leaseExpiresAt = undefined;
        job.updatedAt = new Date().toISOString();
        await persist();
    }
}
async function processQueue() {
    if (processing)
        return;
    processing = true;
    try {
        await hydrate();
        while (true) {
            const active = Array.from(jobs.values()).filter(job => job.status === "claimed").length;
            if (active >= concurrency())
                break;
            const now = Date.now();
            const next = Array.from(jobs.values()).filter(job => (job.status === "pending" || job.status === "retry_wait") && Date.parse(job.nextAttemptAt) <= now).sort((a, b) => Date.parse(a.nextAttemptAt) - Date.parse(b.nextAttemptAt))[0];
            if (!next)
                break;
            await processOne(next);
        }
    }
    finally {
        processing = false;
    }
}
