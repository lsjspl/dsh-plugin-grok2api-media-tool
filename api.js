/**
 * grok2api HTTP client for image and video generation.
 *
 * Supports two API flavors:
 * - `chenyme`: the current Go backend (github.com/chenyme/grok2api). Image
 *   generation is OpenAI-compatible; video generation is asynchronous:
 *   `POST /v1/videos/generations` -> `{ request_id }`, polled through
 *   `GET /v1/videos/{request_id}` -> `{ status: pending|done|failed, video: { url } }`.
 * - `aurora`: the legacy Python backend (github.com/aurora-develop/grok2api).
 *   Image generation is OpenAI-compatible; video generation is asynchronous:
 *   `POST /v1/videos/generations` -> `{ id }`, polled through
 *   `GET /v1/videos/result/{id}` -> `{ state: processing|completed|failed, url }`.
 *
 * All parsing is tolerant: the client reads either field name where the two
 * flavors disagree, so a mislabeled flavor degrades to a clear error instead
 * of a silent wrong parse.
 *
 * This module has zero runtime dependencies: it uses the Node global `fetch`
 * (Node >= 22) and passes caller-owned abort signals through to every request.
 */

/** Per-flavor default model names used when the plugin config omits one. */
export const FLAVOR_MODELS = {
  chenyme: { image: 'grok-imagine-image-quality', video: 'grok-imagine-video' },
  aurora: { image: 'grok-2-image', video: 'grok-2-video-2025-10-01' },
}

/** Supported flavors; validated at plugin load. */
export const FLAVORS = Object.keys(FLAVOR_MODELS)

/** Video poll endpoint per flavor. */
function videoPollPath(flavor, id) {
  const encoded = encodeURIComponent(id)
  return flavor === 'aurora' ? `/v1/videos/result/${encoded}` : `/v1/videos/${encoded}`
}

/** Truncate long payloads for error messages. */
function truncate(text, max) {
  const value = String(text)
  return value.length > max ? `${value.slice(0, max)}…` : value
}

/** Abortable sleep; the returned promise settles with `signal` already consulted. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Issue one grok2api JSON request.
 *
 * @param {object} cfg - normalized plugin config (`baseUrl`, `apiKey`, `requestTimeoutMs`).
 * @param {string} path - endpoint path, starting with `/`.
 * @param {RequestInit} init - fetch init; headers are merged with auth and content type.
 * @param {AbortSignal} signal - caller-owned signal; aborts the request.
 * @returns {Promise<any>} the parsed JSON payload.
 * @throws {Error} on network failure, HTTP error status (with server detail), or unparsable body.
 */
export async function request(cfg, path, init, signal) {
  const headers = {
    'content-type': 'application/json',
    ...(init.headers ?? {}),
  }
  // The key may come from static config (apiKey) or a resolver (credentials
  // seam when reusing a configured LLM provider).
  const apiKey = typeof cfg.resolveApiKey === 'function'
    ? await cfg.resolveApiKey()
    : cfg.apiKey
  if (apiKey) headers.authorization = `Bearer ${apiKey}`
  let response
  try {
    response = await fetch(`${cfg.baseUrl}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.any([signal, AbortSignal.timeout(cfg.requestTimeoutMs)]),
    })
  } catch (error) {
    if (signal.aborted) throw new Error('cancelled')
    throw new Error(`grok2api request failed (${path}): ${String(error?.cause?.message ?? error?.message ?? error)}`)
  }
  const text = await response.text()
  let payload
  try {
    payload = text ? JSON.parse(text) : {}
  } catch {
    payload = null
  }
  if (!response.ok) {
    const detail = payload?.error?.message ?? payload?.message ?? payload?.detail
      ?? (payload ? truncate(text, 300) : truncate(text, 300))
    throw new Error(`grok2api ${response.status} ${response.statusText}${detail ? `: ${truncate(detail, 400)}` : ''}`)
  }
  if (payload === null) throw new Error(`grok2api returned a non-JSON body for ${path}: ${truncate(text, 300)}`)
  return payload
}

/**
 * Parse an OpenAI-style image generation response into `{ url?, b64? }` items.
 * Accepts `data: [{ url | b64_json }]` and a bare `{ url }` as fallback.
 */
/** Hostnames that can never be a client-reachable media host. */
const LOCAL_MEDIA_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0'])

/**
 * Rewrite a remote media url returned by grok2api so the plugin can download
 * it: relative urls and loopback hostnames resolve against the configured
 * baseUrl (path preserved). Any other host is left untouched. Note: this is
 * the DOWNLOAD url; files saved to the workspace get their own loopback
 * local-media url instead.
 * @param {string} url - the media url from the API response.
 * @param {object} cfg - normalized config carrying baseUrl.
 * @returns {string} the reachable download url.
 */
export function rewriteMediaUrl(url, cfg) {
  if (typeof url !== 'string' || url.length === 0) return url
  let absolute
  try {
    absolute = new URL(url, `${cfg.baseUrl}/`)
  } catch {
    return url
  }
  if (absolute.protocol !== 'http:' && absolute.protocol !== 'https:') return url
  const host = absolute.hostname.toLowerCase()
  if (!LOCAL_MEDIA_HOSTS.has(host)) return absolute.toString()
  const base = new URL(cfg.baseUrl)
  absolute.protocol = base.protocol
  absolute.hostname = base.hostname
  absolute.port = base.port
  return absolute.toString()
}

export function parseImageResponse(payload) {
  const items = []
  if (Array.isArray(payload?.data)) {
    for (const entry of payload.data) {
      if (entry === null || typeof entry !== 'object') continue
      const url = typeof entry.url === 'string' && entry.url.length > 0 ? entry.url : undefined
      const b64 = typeof entry.b64_json === 'string' && entry.b64_json.length > 0 ? entry.b64_json : undefined
      if (url !== undefined || b64 !== undefined) items.push({ url, b64 })
    }
  }
  if (items.length === 0 && typeof payload?.url === 'string' && payload.url.length > 0) {
    items.push({ url: payload.url })
  }
  if (items.length === 0) {
    throw new Error(`grok2api returned no image data: ${truncate(JSON.stringify(payload), 500)}`)
  }
  return items
}

/**
 * Generate one or more images.
 *
 * @param {object} cfg - normalized plugin config.
 * @param {{ prompt: string, count: number, model: string, aspectRatio?: string, quality?: string }} input
 * @param {AbortSignal} signal - caller-owned signal.
 * @returns {Promise<Array<{ url?: string, b64?: string }>>}
 */
export async function createImage(cfg, input, signal) {
  const body = {
    model: input.model,
    prompt: input.prompt,
    n: input.count,
    response_format: 'url',
  }
  if (input.quality) body.quality = input.quality
  if (cfg.apiFlavor === 'chenyme' && input.aspectRatio) body.aspect_ratio = input.aspectRatio
  const payload = await request(cfg, '/v1/images/generations', { method: 'POST', body: JSON.stringify(body) }, signal)
  return parseImageResponse(payload).map((item) => ({
    ...item,
    ...(item.url !== undefined ? { url: rewriteMediaUrl(item.url, cfg) } : {}),
  }))
}

/**
 * Create an asynchronous video job and poll it to completion.
 *
 * @param {object} cfg - normalized plugin config (`video.timeoutMs`, `video.pollIntervalMs`).
 * @param {{ prompt?: string, model: string, duration?: number, aspectRatio?: string }} input
 * @param {AbortSignal} signal - caller-owned signal.
 * @returns {Promise<{ id: string, url: string, duration?: number }>}
 * @throws {Error} when the job fails server-side or the poll deadline passes.
 */
export async function createAndPollVideo(cfg, input, signal) {
  const body = { model: input.model }
  if (input.prompt !== undefined) body.prompt = input.prompt
  if (cfg.apiFlavor === 'chenyme') {
    if (input.duration !== undefined) body.duration = input.duration
    if (input.aspectRatio) body.aspect_ratio = input.aspectRatio
  }
  const created = await request(cfg, '/v1/videos/generations', { method: 'POST', body: JSON.stringify(body) }, signal)
  const id = created?.request_id ?? created?.id
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`grok2api video response is missing the job id: ${truncate(JSON.stringify(created), 300)}`)
  }
  const pollPath = videoPollPath(cfg.apiFlavor, id)
  // Reserve a download window inside the tool-level budget: polling ends
  // `mediaDownloadTimeoutMs` before the deadline so a large video file still
  // has time to reach the workspace before the timeout policy aborts.
  const downloadBudget = cfg.mediaDownloadTimeoutMs ?? 300000
  const deadline = Date.now() + Math.max(1000, cfg.video.timeoutMs - 2000 - downloadBudget)
  for (;;) {
    if (signal.aborted) throw new Error('video generation cancelled')
    const poll = await request(cfg, pollPath, { method: 'GET' }, signal)
    const status = poll?.status ?? poll?.state ?? 'pending'
    if (status === 'done' || status === 'completed' || status === 'succeeded') {
      const url = poll?.video?.url ?? poll?.url
      if (typeof url !== 'string' || url.length === 0) {
        throw new Error(`grok2api video job ${id} completed without a url`)
      }
      const duration = poll?.video?.duration ?? poll?.duration
      return { id, url: rewriteMediaUrl(url, cfg), ...(typeof duration === 'number' ? { duration } : {}) }
    }
    if (status === 'failed' || status === 'error') {
      const raw = poll?.error?.message ?? poll?.error ?? poll?.message ?? 'unknown error'
      const message = typeof raw === 'string' ? raw : truncate(JSON.stringify(raw), 300)
      throw new Error(`grok2api video job ${id} failed: ${message}`)
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new Error(`video generation timed out after ${cfg.video.timeoutMs}ms (job ${id} still pending)`)
    }
    await sleep(Math.min(cfg.video.pollIntervalMs, remaining))
  }
}
