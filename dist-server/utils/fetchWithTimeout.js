export async function fetchWithTimeout(url, options = {}, timeoutMs = Number(process.env.SENTINEL_HUB_REQUEST_TIMEOUT_MS || "15000")) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, {
            ...options,
            signal: controller.signal
        });
    }
    finally {
        clearTimeout(timer);
    }
}
