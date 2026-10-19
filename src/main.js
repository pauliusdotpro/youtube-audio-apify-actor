// YouTube to MP3 & Audio Converter - Apify Actor
// Thin client for the youtube-mp3 conversion API (https://api-youtubemp3.paulius.pro).
// The API token is provided by the Actor publisher through the secret
// environment variable YTMP3_API_TOKEN and is never part of the user input.

import { Actor, log } from 'apify';

const API_BASE_URL = (process.env.YTMP3_API_BASE_URL || 'https://api-youtubemp3.paulius.pro').replace(/\/+$/, '');
const API_TOKEN = (process.env.YTMP3_API_TOKEN || '').trim();

const CHARGE_EVENT = 'audio-conversion';
const FORMATS = ['mp3', 'm4a', 'wav', 'flac', 'aac', 'opus', 'ogg', 'webm'];
const QUALITIES = ['standard', 'best', '128', '192', '256', '320'];
const TERMINAL_STATUSES = new Set(['done', 'error', 'cancelled']);

const CONVERT_WAIT_SECONDS = 25; // server-side long-poll on /convert (max 25)
const POLL_WAIT_SECONDS = 25; // server-side long-poll on /jobs/{id} (max 25)
const REQUEST_TIMEOUT_MS = 60_000; // must exceed the server-side long-poll
const MAX_RETRIES = 5; // per request, for 429/503/5xx/network errors
const MAX_RETRY_AFTER_SECONDS = 120; // cap for honoring Retry-After
const JOB_DEADLINE_MS = 45 * 60_000; // give up on a single conversion after this
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
const MAX_STORED_FILE_BYTES = Number(process.env.MAX_STORED_FILE_BYTES || 500 * 1024 * 1024);

const CONTENT_TYPES = {
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    wav: 'audio/wav',
    flac: 'audio/flac',
    aac: 'audio/aac',
    opus: 'audio/ogg',
    ogg: 'audio/ogg',
    webm: 'audio/webm',
};

class ApiError extends Error {
    constructor(message, { status = 0, code = 'API_ERROR', retryable = false } = {}) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.code = code;
        this.retryable = retryable;
    }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseRetryAfter(header, fallbackSeconds) {
    if (!header) return fallbackSeconds;
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds;
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(0, (date - Date.now()) / 1000);
    return fallbackSeconds;
}

function backoffSeconds(attempt) {
    // 2, 4, 8, 16, 32 s plus jitter
    return Math.min(60, 2 ** (attempt + 1)) + Math.random();
}

/**
 * Calls the conversion API with bounded retries.
 * - 429 / 503: waits for Retry-After (capped) and retries.
 * - 500 / 502 / 504 / network errors / timeouts: exponential backoff and retry.
 * - Other 4xx (400, 403, 404, 410, 422, ...): no retry, throws ApiError.
 * Returns { status, body, headers } for 2xx responses.
 */
async function apiRequest(path, { label = path } = {}) {
    const url = `${API_BASE_URL}${path}`;
    let lastError;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        let response;
        try {
            response = await fetch(url, {
                headers: {
                    Authorization: `Bearer ${API_TOKEN}`,
                    Accept: 'application/json',
                    'User-Agent': 'apify-youtube-audio-converter/1.0',
                },
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
        } catch (error) {
            lastError = new ApiError(`Network error calling conversion service: ${error.message}`, {
                code: 'NETWORK_ERROR',
                retryable: true,
            });
            if (attempt < MAX_RETRIES) {
                const wait = backoffSeconds(attempt);
                log.warning(`${label}: ${lastError.message}. Retrying in ${wait.toFixed(0)}s (${attempt + 1}/${MAX_RETRIES}).`);
                await sleep(wait * 1000);
                continue;
            }
            throw lastError;
        }

        let body = null;
        const text = await response.text();
        if (text) {
            try {
                body = JSON.parse(text);
            } catch {
                body = { raw: text.slice(0, 500) };
            }
        }

        if (response.ok) return { status: response.status, body, headers: response.headers };

        const apiErr = body?.error || {};
        const message = apiErr.message || `HTTP ${response.status}`;
        const code = apiErr.code || `HTTP_${response.status}`;
        const status = response.status;

        if (status === 401 || status === 403) {
            // Misconfigured publisher token: not the user's fault, not retryable.
            throw new ApiError('The conversion service rejected the Actor credentials. Please contact the Actor developer.', {
                status,
                code: 'SERVICE_AUTH_FAILED',
            });
        }

        const retryable = status === 429 || status === 503 || status === 500 || status === 502 || status === 504;
        lastError = new ApiError(message, { status, code, retryable });
        if (!retryable || attempt >= MAX_RETRIES) throw lastError;

        const wait = (status === 429 || status === 503)
            ? Math.min(MAX_RETRY_AFTER_SECONDS, parseRetryAfter(response.headers.get('retry-after'), backoffSeconds(attempt)))
            : backoffSeconds(attempt);
        log.warning(`${label}: ${status} ${code} - ${message}. Retrying in ${Math.ceil(wait)}s (${attempt + 1}/${MAX_RETRIES}).`);
        await sleep(Math.max(1, wait) * 1000);
    }

    throw lastError || new ApiError('Request failed', { code: 'UNKNOWN' });
}

function buildConvertQuery(url, opts) {
    const params = new URLSearchParams({
        url,
        format: opts.format,
        quality: opts.quality,
        wait: String(CONVERT_WAIT_SECONDS),
    });
    if (opts.startTime !== undefined) params.set('startTime', String(opts.startTime));
    if (opts.endTime !== undefined) params.set('endTime', String(opts.endTime));
    return params.toString();
}

function jobFailure(job) {
    const status = job?.status === 'cancelled' ? 'cancelled' : 'error';
    return new ApiError(job?.error?.message || `Conversion ${status}`, {
        code: job?.error?.code || (status === 'cancelled' ? 'JOB_CANCELLED' : 'CONVERSION_FAILED'),
    });
}

/** Converts one URL; resolves to { job, link } where link is the API's result link object. */
async function convert(url, opts) {
    const label = `[${url}]`;
    const first = await apiRequest(`/api/v2/convert?${buildConvertQuery(url, opts)}`, { label });

    if (first.status === 200 && first.body?.status === 'done') {
        const link = first.body.result || { url: first.body.link, direct: true };
        return { job: first.body, link };
    }

    let job = first.body;
    if (!job?.jobId) throw new ApiError('Unexpected response from conversion service', { code: 'UNEXPECTED_RESPONSE' });
    log.info(`${label} Conversion queued as job ${job.jobId} (status: ${job.status}). Waiting...`);

    const deadline = Date.now() + JOB_DEADLINE_MS;
    let lastProgressLog = 0;
    while (!TERMINAL_STATUSES.has(job.status)) {
        if (Date.now() > deadline) {
            throw new ApiError(`Conversion did not finish within ${JOB_DEADLINE_MS / 60_000} minutes`, { code: 'TIMEOUT' });
        }
        const polled = await apiRequest(
            `/api/v2/jobs/${encodeURIComponent(job.jobId)}?waitSeconds=${POLL_WAIT_SECONDS}`,
            { label },
        );
        job = polled.body || job;
        if (!TERMINAL_STATUSES.has(job.status)) {
            if (Date.now() - lastProgressLog > 60_000) {
                const pos = job.queuePosition ? `, queue position ${job.queuePosition}` : '';
                log.info(`${label} Still ${job.status}${typeof job.progress === 'number' ? ` (${job.progress}%)` : ''}${pos}.`);
                lastProgressLog = Date.now();
            }
            // Server already long-polls; a short pause guards against tight loops.
            await sleep(Math.max(1, Number(polled.headers.get('retry-after')) || 1) * 1000);
        }
    }

    if (job.status !== 'done') throw jobFailure(job);

    const result = await apiRequest(`/api/v2/jobs/${encodeURIComponent(job.jobId)}/result-url`, { label });
    return { job, link: result.body };
}

function absoluteUrl(maybeRelative) {
    if (!maybeRelative) return null;
    return new URL(maybeRelative, `${API_BASE_URL}/`).toString();
}

const usedStoreKeys = new Set();

function storeKeyFor(job, opts, index) {
    const base = job.videoId || `item-${index + 1}`;
    const clip = opts.startTime !== undefined || opts.endTime !== undefined
        ? `-${opts.startTime ?? 0}-${opts.endTime ?? 'end'}`
        : '';
    let key = `${base}${clip}-${opts.quality}`.replace(/[^a-zA-Z0-9!\-_.'()]/g, '_').slice(0, 230);
    // The same video may appear twice in the input (e.g. as URL and as ID).
    if (usedStoreKeys.has(key)) key = `${key}-${index + 1}`;
    usedStoreKeys.add(key);
    return `${key}.${opts.format}`;
}

async function downloadToStore(fileUrl, { needsAuth, key, contentType, expectedSize, store }) {
    if (expectedSize && expectedSize > MAX_STORED_FILE_BYTES) {
        throw new ApiError(
            `File is ${(expectedSize / 1048576).toFixed(1)} MB, above the ${(MAX_STORED_FILE_BYTES / 1048576).toFixed(0)} MB storage limit of this Actor`,
            { code: 'FILE_TOO_LARGE_TO_STORE' },
        );
    }

    let lastError;
    for (let attempt = 0; attempt <= 2; attempt++) {
        try {
            const response = await fetch(fileUrl, {
                headers: needsAuth ? { Authorization: `Bearer ${API_TOKEN}` } : {},
                signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
            });
            if (!response.ok) {
                const retryable = response.status >= 500 || response.status === 429;
                throw new ApiError(`Download failed with HTTP ${response.status}`, {
                    status: response.status,
                    code: 'DOWNLOAD_FAILED',
                    retryable,
                });
            }
            const buffer = Buffer.from(await response.arrayBuffer());
            await store.setValue(key, buffer, { contentType });
            return buffer.length;
        } catch (error) {
            lastError = error;
            const retryable = error instanceof ApiError ? error.retryable : true;
            if (!retryable || attempt >= 2) break;
            log.warning(`Download of ${key} failed (${error.message}); retrying.`);
            await sleep(backoffSeconds(attempt) * 1000);
        }
    }
    throw lastError instanceof ApiError
        ? lastError
        : new ApiError(`Download failed: ${lastError?.message}`, { code: 'DOWNLOAD_FAILED' });
}

function normalizeInput(input) {
    const errors = [];
    const rawUrls = Array.isArray(input?.urls) ? input.urls : [];
    const urls = [...new Set(
        rawUrls
            .map((u) => (typeof u === 'string' ? u : u?.url)) // also accept requestListSources-style objects
            .filter((u) => typeof u === 'string')
            .map((u) => u.trim())
            .filter(Boolean),
    )];
    if (urls.length === 0) errors.push('Input "urls" must contain at least one YouTube URL or video ID.');

    const format = String(input?.format || 'mp3').toLowerCase();
    if (!FORMATS.includes(format)) errors.push(`Input "format" must be one of: ${FORMATS.join(', ')}.`);

    const quality = String(input?.quality || 'standard').toLowerCase();
    if (!QUALITIES.includes(quality)) errors.push(`Input "quality" must be one of: ${QUALITIES.join(', ')}.`);

    const toTime = (value, name) => {
        if (value === undefined || value === null || value === '') return undefined;
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0) {
            errors.push(`Input "${name}" must be a non-negative number of seconds.`);
            return undefined;
        }
        return n;
    };
    const startTime = toTime(input?.startTime, 'startTime');
    const endTime = toTime(input?.endTime, 'endTime');
    if (endTime !== undefined && endTime <= (startTime ?? 0)) {
        errors.push('Input "endTime" must be greater than "startTime".');
    }

    const maxConcurrency = Math.min(5, Math.max(1, Math.floor(Number(input?.maxConcurrency) || 3)));

    return {
        errors,
        urls,
        opts: { format, quality, startTime, endTime },
        storeFile: input?.storeFile === true,
        maxConcurrency,
    };
}

/** Pay-per-event helpers, safe when the Actor is not monetized or runs locally. */
function chargingManager() {
    try {
        return typeof Actor.getChargingManager === 'function' ? Actor.getChargingManager() : null;
    } catch {
        return null;
    }
}

function remainingChargeBudget() {
    try {
        const n = chargingManager()?.calculateMaxEventChargeCountWithinLimit?.(CHARGE_EVENT);
        return typeof n === 'number' ? n : Infinity;
    } catch {
        return Infinity;
    }
}

async function chargeConversion() {
    if (typeof Actor.charge !== 'function') return { limitReached: false };
    try {
        const result = await Actor.charge({ eventName: CHARGE_EVENT, count: 1 });
        return { limitReached: Boolean(result?.eventChargeLimitReached) };
    } catch (error) {
        log.warning(`Could not record "${CHARGE_EVENT}" charge: ${error.message}`);
        return { limitReached: false };
    }
}

await Actor.init();

try {
    if (!API_TOKEN) {
        log.error('Missing YTMP3_API_TOKEN environment variable. The Actor owner must set it as a secret environment variable in the Actor settings.');
        await Actor.fail('This Actor is not configured: the conversion service token (YTMP3_API_TOKEN) is missing. Please contact the Actor developer.');
    }

    const input = (await Actor.getInput()) || {};
    const { errors, urls, opts, storeFile, maxConcurrency } = normalizeInput(input);
    if (errors.length) {
        for (const e of errors) log.error(e);
        await Actor.fail(`Invalid input: ${errors.join(' ')}`);
    }

    log.info(`Converting ${urls.length} video(s) to ${opts.format} (${opts.quality})`
        + `${opts.startTime !== undefined || opts.endTime !== undefined ? `, clip ${opts.startTime ?? 0}-${opts.endTime ?? 'end'}s` : ''}`
        + `, concurrency ${maxConcurrency}${storeFile ? ', storing files in key-value store' : ''}.`);

    const store = await Actor.openKeyValueStore();
    const stats = { succeeded: 0, failed: 0, skipped: 0, authFailed: false };
    let stopCharging = false;
    let reserved = 0; // conversions in flight that may still be charged
    let nextIndex = 0;

    const processOne = async (index) => {
        const url = urls[index];
        const item = {
            url,
            status: 'failed',
            videoId: null,
            link: null,
            linkExpiresAt: null,
            fileName: null,
            format: opts.format,
            quality: opts.quality,
            contentType: null,
            fileSize: null,
            durationSeconds: null,
            keyValueStoreKey: null,
            keyValueStoreUrl: null,
            error: null,
            errorCode: null,
        };

        try {
            const { job, link } = await convert(url, opts);
            item.videoId = job.videoId ?? null;
            item.fileName = link?.fileName || job.fileName || null;
            item.contentType = link?.contentType || job.contentType || CONTENT_TYPES[opts.format] || null;
            item.fileSize = link?.fileSize ?? job.fileSize ?? null;
            item.durationSeconds = job.mediaDurationSeconds ?? null;
            item.format = job.format || opts.format;
            item.quality = job.quality || opts.quality;

            // A non-direct link requires the publisher's API token, so it is never
            // exposed to the user; the file is stored in the key-value store instead.
            const isDirect = link?.direct !== false && link?.requiresAuthentication !== true;
            const fileUrl = absoluteUrl(link?.url || job.link);
            if (!fileUrl) throw new ApiError('Conversion finished but no download link was returned', { code: 'NO_RESULT_LINK' });

            if (isDirect) {
                item.link = fileUrl;
                item.linkExpiresAt = link?.expiresAt || job.expiresAt || null;
            }

            if (storeFile || !isDirect) {
                const key = storeKeyFor(job, opts, index);
                const size = await downloadToStore(fileUrl, {
                    needsAuth: !isDirect,
                    key,
                    contentType: item.contentType || 'application/octet-stream',
                    expectedSize: item.fileSize,
                    store,
                });
                item.fileSize = item.fileSize ?? size;
                item.keyValueStoreKey = key;
                try {
                    item.keyValueStoreUrl = typeof store.getPublicUrl === 'function' ? store.getPublicUrl(key) : null;
                } catch {
                    item.keyValueStoreUrl = null;
                }
            }

            item.status = 'succeeded';
            stats.succeeded++;
            log.info(`[${url}] Done: ${item.fileName || item.keyValueStoreKey} (${item.fileSize ?? '?'} bytes).`);
        } catch (error) {
            stats.failed++;
            item.error = error.message || String(error);
            item.errorCode = error.code || 'UNEXPECTED_ERROR';
            if (error.status === 422) {
                log.warning(`[${url}] Not convertible: ${item.error}`);
            } else {
                log.error(`[${url}] Failed: ${item.errorCode} - ${item.error}`);
            }
        }

        await Actor.pushData(item);

        if (item.status === 'succeeded') {
            const { limitReached } = await chargeConversion();
            if (limitReached) stopCharging = true;
        }
        if (item.errorCode === 'SERVICE_AUTH_FAILED') {
            stats.authFailed = true;
            stopCharging = true; // publisher misconfiguration: no point continuing
        }
    };

    const worker = async () => {
        while (nextIndex < urls.length && !stopCharging) {
            // Do not start conversions the user's max-charge budget cannot pay for.
            if (remainingChargeBudget() - reserved <= 0) {
                stopCharging = true;
                break;
            }
            const index = nextIndex++;
            reserved++;
            try {
                await processOne(index);
            } finally {
                reserved--;
            }
            await Actor.setStatusMessage(
                `Processed ${stats.succeeded + stats.failed}/${urls.length}: ${stats.succeeded} succeeded, ${stats.failed} failed.`,
            );
        }
    };

    await Promise.all(Array.from({ length: Math.min(maxConcurrency, urls.length) }, worker));

    stats.skipped = urls.length - nextIndex;
    if (stats.skipped > 0) {
        log.warning(`${stats.skipped} URL(s) were not processed because the run's maximum charge limit was reached or the service is unavailable.`);
    }

    if (stats.authFailed && stats.succeeded === 0) {
        await Actor.fail('The conversion service rejected the Actor credentials. Please contact the Actor developer.');
    }

    const summary = `Finished: ${stats.succeeded} succeeded, ${stats.failed} failed${stats.skipped ? `, ${stats.skipped} skipped (limit reached)` : ''}.`;
    log.info(summary);
    await Actor.setStatusMessage(summary, { isStatusMessageTerminal: true });
    await Actor.exit();
} catch (error) {
    log.exception(error, 'Actor crashed');
    await Actor.fail(`Unexpected error: ${error.message}`);
}
