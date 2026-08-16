/**
 * Media route: files this plugin saved into a session workspace, served to the
 * browser over dsh's OWN web server (`ctx.webServer`) rather than a private
 * listener of ours.
 *
 * Why the host server: the URL is then same-origin with the UI, so it resolves
 * wherever the browser reached dsh from (loopback, LAN bind, SSH tunnel), it
 * rides the deployment's existing host binding instead of opening a second
 * unauthenticated port, and its path is stable — no random port to go stale.
 *
 * Authorization is a capability in the URL: each path is signed with an HMAC
 * keyed by `$DSH_HOME/.grok2api-media-key`. Only a path this plugin itself
 * signed can be read, so the route can never be walked into arbitrary files —
 * and because the key persists, yesterday's session still renders its images
 * after a restart (an in-memory allowlist could not).
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { createReadStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'

/** Route path registered on the host web server (prefix match, no trailing slash). */
export const MEDIA_ROUTE_PATH = '/grok2api-media'

/** Upload route used by the composer button to turn a picked file into a local path. */
export const UPLOAD_ROUTE_PATH = '/grok2api-upload'

/** Signing key file inside the harness home. */
export const MEDIA_KEY_FILE = '.grok2api-media-key'

const CONTENT_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
}

/**
 * Load the media signing key, creating it on first use.
 *
 * The exclusive create keeps two dsh processes starting at once from handing
 * out URLs signed with different keys: whoever loses the race reads the
 * winner's key instead of overwriting it.
 * @param {string} homeDir - the harness home ($DSH_HOME).
 * @returns {Buffer} the 32-byte key.
 */
export function loadMediaKey(homeDir) {
  const path = join(homeDir, MEDIA_KEY_FILE)
  try {
    return readFileSync(path)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  mkdirSync(homeDir, { recursive: true })
  const key = randomBytes(32)
  try {
    // 0600: the key authorizes reads of generated media.
    writeFileSync(path, key, { mode: 0o600, flag: 'wx' })
    return key
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    return readFileSync(path)
  }
}

/**
 * Sign one absolute file path.
 * @param {Buffer} key - the media signing key.
 * @param {string} filePath - absolute path of a saved media file.
 * @returns {string} the URL-safe token.
 */
export function mediaToken(key, filePath) {
  return createHmac('sha256', key).update(filePath).digest('base64url')
}

/**
 * Build the browser URL serving one saved media file.
 *
 * Root-relative on purpose: the browser resolves it against whatever origin it
 * reached dsh on, which an absolute url baked at save time cannot predict
 * (bind address, reverse proxy, tunnel).
 * @param {Buffer} key - the media signing key.
 * @param {string} filePath - absolute path of the saved file.
 * @returns {string} a same-origin URL under {@link MEDIA_ROUTE_PATH}.
 */
export function localMediaUrl(key, filePath) {
  return `${MEDIA_ROUTE_PATH}/${encodeURIComponent(filePath)}?t=${encodeURIComponent(mediaToken(key, filePath))}`
}

/** Constant-time token comparison that tolerates a missing or short candidate. */
function tokenMatches(expected, candidate) {
  const left = Buffer.from(expected, 'utf8')
  const right = Buffer.from(candidate ?? '', 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * Build the route handler serving signed media paths.
 * @param {Buffer} key - the media signing key.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createMediaHandler(key) {
  return async (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'content-type': 'application/json' })
        res.end('{"error":"method not allowed"}')
        return
      }
      let url
      try {
        url = new URL(req.url ?? '/', 'http://media')
      } catch {
        res.writeHead(400)
        res.end()
        return
      }
      const prefix = `${MEDIA_ROUTE_PATH}/`
      if (!url.pathname.startsWith(prefix)) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end('{"error":"not a media route"}')
        return
      }
      let filePath
      try {
        filePath = decodeURIComponent(url.pathname.slice(prefix.length))
      } catch {
        res.writeHead(400)
        res.end()
        return
      }
      // The signature IS the authorization: an unsigned path is indistinguishable
      // from a missing file, so the route leaks nothing about the filesystem.
      if (!tokenMatches(mediaToken(key, filePath), url.searchParams.get('t'))) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end('{"error":"unknown media file"}')
        return
      }
      const info = await stat(filePath).catch(() => undefined)
      if (info === undefined || !info.isFile()) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end('{"error":"media file missing"}')
        return
      }
      res.writeHead(200, {
        'content-type': CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
        'content-length': String(info.size),
        'cache-control': 'private, max-age=31536000, immutable',
      })
      if (req.method === 'HEAD') {
        res.end()
        return
      }
      const stream = createReadStream(filePath)
      stream.on('error', () => {
        if (!res.headersSent) {
          res.writeHead(404)
          res.end()
        } else {
          res.end()
        }
      })
      stream.pipe(res)
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: String(error?.message ?? error) }))
      } else {
        res.end()
      }
    }
  }
}

/** Maximum bytes accepted by the composer upload route. */
const UPLOAD_MAX_BYTES = 50 * 1024 * 1024

/** Keep only a safe filename fragment for the on-disk upload. */
function sanitizeUploadName(value) {
  const base = basename(String(value ?? 'image')).replace(/[^\w.-]+/g, '_').slice(0, 80)
  return base.length > 0 ? base : 'image'
}

/**
 * Build the upload route handler. It accepts a raw binary POST body, stores it
 * under `$DSH_HOME/uploads`, and returns the absolute path the agent can hand
 * to `recognize_image` (or any file-aware tool).
 * @param {string} homeDir - the harness home ($DSH_HOME).
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createUploadHandler(homeDir) {
  return async (req, res) => {
    try {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'application/json' })
        res.end('{"error":"method not allowed"}')
        return
      }
      let url
      try {
        url = new URL(req.url ?? '/', 'http://upload')
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end('{"error":"bad request"}')
        return
      }
      const name = sanitizeUploadName(url.searchParams.get('name'))
      const ext = extname(name) || '.img'
      const dir = join(homeDir, 'uploads')
      mkdirSync(dir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)
      const filePath = join(dir, `grok2api-upload-${stamp}-${Math.random().toString(36).slice(2, 8)}${ext}`)
      const chunks = []
      let size = 0
      for await (const chunk of req) {
        chunks.push(chunk)
        size += chunk.length
        if (size > UPLOAD_MAX_BYTES) {
          res.writeHead(413, { 'content-type': 'application/json' })
          res.end('{"error":"upload too large"}')
          return
        }
      }
      writeFileSync(filePath, Buffer.concat(chunks))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ path: filePath, name }))
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: String(error?.message ?? error) }))
      } else {
        res.end()
      }
    }
  }
}

