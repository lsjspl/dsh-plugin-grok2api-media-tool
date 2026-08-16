/**
 * dsh-plugin-grok2api-media-tool: model-facing image/video generation and image
 * recognition tools over a grok2api deployment (github.com/chenyme/grok2api or
 * the legacy aurora-develop/grok2api backend).
 *
 * Registers four tools on the host tool registry:
 * - `generate_image`: POST /v1/images/generations, returns urls and optional
 *   local workspace copies.
 * - `generate_video`: asynchronous job; creates, polls to completion, and
 *   returns the video url with an optional local workspace copy.
 * - `recognize_image`: POST /v1/chat/completions with an image, returning the
 *   Grok model's text answer (default model: latest advertised Grok chat model).
 * - `configure_grok2api`: edits the plugin's `grok2api-media-tool:` section in
 *   `$DSH_HOME/settings.yaml` and re-applies it live — the model-facing
 *   configuration channel, and the one a UI cannot replace here (dsh's
 *   api-proxy serves only an allowlist of settings namespaces to the browser,
 *   so a plugin-owned namespace is neither readable nor writable from the Web
 *   settings page; exposing plugin namespaces is deferred work upstream).
 *
 * Configuration layers, in increasing precedence:
 * 1. the `Config` schema defaults below,
 * 2. the bundle patch row's `config` (cordis.patch.yml) as the composition base,
 * 3. the `grok2api-media-tool:` user section of `$DSH_HOME/settings.yaml` (edited via the
 *    configure_grok2api tool or by hand).
 *
 * The plugin registers raw JSON-Schema tool definitions through
 * `ctx.tools.register()`. Its runtime imports are the harness's own peer
 * packages (@deepseek-ai/schemastery, @deepseek-ai/dsh-settings, js-yaml),
 * which resolve through the profile's healed module fallback.
 */

import z from '@deepseek-ai/schemastery'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { createAndPollVideo, createChatCompletion, createImage, FLAVOR_MODELS, FLAVORS, listModels } from './api.js'
import { assertSafeSaveDir, decodeB64, downloadBytes, imageDataUrlForInput, saveMedia } from './media.js'
import { createMediaHandler, createUploadHandler, loadMediaKey, localMediaUrl, MEDIA_ROUTE_PATH, UPLOAD_ROUTE_PATH } from './media-proxy.js'

export const name = 'grok2api-media-tool'

export const inject = ['tools', 'systemPrompt', 'agents']

const IMAGE_ASPECT_RATIOS = ['auto', '1:1', '16:9', '9:16', '4:3', '3:4']
const IMAGE_QUALITIES = ['low', 'medium']
const VIDEO_ASPECT_RATIOS = ['16:9', '9:16', '1:1']
const VISION_MODEL_DEFAULT = 'latest'
const VISION_MODEL_FALLBACK = 'grok-4.6'
/** One `/v1/models` lookup per config + session; avoids a network round-trip on every recognize_image call. */
const visionModelCache = new Map()
/** Agents already wired with the image bridge, so HMR/reload never double-registers. */
const bridgedAgents = new WeakSet()

/**
 * Settings namespace this plugin owns in `$DSH_HOME/settings.yaml`. Registering
 * it on `ctx.settings` buys the locked, atomic, comment-preserving write path
 * and hot reload on external edits; it does NOT make the section visible to the
 * Web settings page (see the module JSDoc).
 */
export const SETTINGS_NS = 'grok2api-media-tool'

/**
 * The plugin's schemastery config schema. The loader validates the patch row's
 * config against it and fills defaults; the settings service resolves the same
 * schema over the user section. `role('secret')` keeps `apiKey` out of wire
 * snapshots.
 */
export const Config = z.object({
  baseUrl: z.string().description('grok2api HTTP(S) base URL, e.g. http://127.0.0.1:8000').default('http://127.0.0.1:8000'),
  apiKey: z.string().role('secret').description('Client API key; sent as Authorization: Bearer when non-empty. Takes precedence over apiKeyEnv.').default(''),
  apiKeyEnv: z.string().description('Environment variable holding the API key, e.g. GROK_API_KEY; used when apiKey is empty.').default(''),
  apiSource: z.string().description('Config source: manual (this section) or llm-provider (reuse a provider from the llm-pi-ai settings section).').default('manual'),
  llmProvider: z.string().description('Provider name in the llm-pi-ai providers section to reuse, e.g. grok; used when apiSource is llm-provider.').default(''),
  apiFlavor: z.string().description('Backend flavor: chenyme (Go) or aurora (legacy Python).').default('chenyme'),
  image: z.object({
    enabled: z.boolean().description('Register the generate_image tool.').default(true),
    model: z.string().description('Default image model; empty selects the flavor default.').default(''),
    timeoutMs: z.number().description('generate_image overall timeout in milliseconds.').default(180000),
  }).default({ enabled: true, model: '', timeoutMs: 180000 }),
  video: z.object({
    enabled: z.boolean().description('Register the generate_video tool.').default(true),
    model: z.string().description('Default video model; empty selects the flavor default.').default(''),
    timeoutMs: z.number().description('generate_video overall timeout (creation + polling + download).').default(1200000),
    pollIntervalMs: z.number().description('Video status polling interval in milliseconds.').default(5000),
  }).default({ enabled: true, model: '', timeoutMs: 1200000, pollIntervalMs: 5000 }),
  vision: z.object({
    enabled: z.boolean().description('Register the recognize_image tool.').default(true),
    model: z.string().description('Default Grok vision model for image recognition.').default(VISION_MODEL_DEFAULT),
    timeoutMs: z.number().description('recognize_image overall timeout in milliseconds.').default(60000),
    bridgeToText: z.boolean().description('Convert uploaded images to Grok text before sending to a text-only main model.').default(true),
  }).default({ enabled: true, model: VISION_MODEL_DEFAULT, timeoutMs: 60000, bridgeToText: true }),
  saveToWorkspace: z.boolean().description('Download generated media into the session workspace.').default(true),
  saveDir: z.string().description('Workspace subdirectory for saved media; must stay relative.').default('generated'),
  requestTimeoutMs: z.number().description('Per-HTTP-request timeout in milliseconds.').default(60000),
  mediaDownloadTimeoutMs: z.number().description('Timeout for one media download (videos are large).').default(300000),
})

const PROMPT_SECTION = 'Use the generate_image tool when the user asks to create, draw, or generate an image, and the generate_video tool when the user asks to create a video or animation. After a successful call, show images with markdown image syntax using the returned url (the media route is public), and list saved local file paths in your reply as inline code exactly as returned. Give video urls as markdown links. When the user asks to identify, describe, read, or otherwise understand an image, use the recognize_image tool. When the grok2api connection settings (API address, key, backend flavor) are missing or wrong, use the configure_grok2api tool to set or fix them, then retry.'

/** The harness home directory: `$DSH_HOME`, else `~/.dsh`. */
export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** The user settings document path ($DSH_HOME/settings.yaml). */
export function settingsFilePath() {
  return join(dshHome(), 'settings.yaml')
}

/** The managed credentials document path ($DSH_HOME/.credentials.yaml). */
export function credentialsFilePath() {
  return join(dshHome(), '.credentials.yaml')
}

/**
 * Resolve a credential by environment-variable name: the process environment
 * first, then the managed credentials document (`$DSH_HOME/.credentials.yaml`,
 * the same file the web Models page writes). Keeps single keys out of plugin
 * config even when the process environment was not inherited.
 * @param {string} name - environment-variable-style reference, e.g. GROK_API_KEY.
 * @returns {string} the value, or '' when absent everywhere.
 */
export function resolveEnvKey(name) {
  if (typeof name !== 'string' || name.length === 0) return ''
  if (process.env[name]) return process.env[name]
  const path = credentialsFilePath()
  if (!existsSync(path)) return ''
  const value = readSettingsDocument(path)[name]
  return typeof value === 'string' ? value : ''
}

function fail(message) {
  throw new Error(`grok2api-media-tool: ${message}`)
}

function positiveInteger(value, key) {
  if (!Number.isInteger(value) || value < 1) fail(`config ${key} must be a positive integer`)
  return value
}

function stringOrEmpty(value, key) {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value !== 'string') fail(`config ${key} must be a string`)
  return value.trim()
}

/**
 * Finalize a schema-resolved config value with the constraints the schema
 * cannot express: URL shape, flavor membership, positive integers, and a
 * workspace-safe saveDir. Throwing rejects the value, so bad inputs never run.
 * @param {any} raw - schema-resolved config object (defaults already filled).
 * @returns {object} the normalized config with per-flavor model defaults resolved.
 */
export function normalizeConfig(raw) {
  const input = raw === null || raw === undefined || typeof raw !== 'object' ? {} : raw
  const baseUrl = stringOrEmpty(input.baseUrl, 'baseUrl')
  if (baseUrl.length === 0) fail('config baseUrl is required, e.g. "http://127.0.0.1:8000"')
  let parsed
  try {
    parsed = new URL(baseUrl)
  } catch {
    fail(`config baseUrl is not a valid URL: ${JSON.stringify(baseUrl)}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') fail('config baseUrl must use http:// or https://')

  const apiFlavor = stringOrEmpty(input.apiFlavor, 'apiFlavor') || 'chenyme'
  if (!FLAVORS.includes(apiFlavor)) fail(`config apiFlavor must be one of ${FLAVORS.join(', ')}`)

  const image = { ...(input.image ?? {}) }
  const video = { ...(input.video ?? {}) }
  const vision = { ...(input.vision ?? {}) }
  image.timeoutMs = image.timeoutMs ?? 180000
  video.timeoutMs = video.timeoutMs ?? 1200000
  video.pollIntervalMs = video.pollIntervalMs ?? 5000
  vision.timeoutMs = vision.timeoutMs ?? 60000
  vision.bridgeToText = vision.bridgeToText === undefined ? true : vision.bridgeToText
  positiveInteger(image.timeoutMs, 'image.timeoutMs')
  positiveInteger(video.timeoutMs, 'video.timeoutMs')
  positiveInteger(video.pollIntervalMs, 'video.pollIntervalMs')
  positiveInteger(vision.timeoutMs, 'vision.timeoutMs')
  positiveInteger(requestTimeoutMs(input), 'requestTimeoutMs')
  positiveInteger(mediaDownloadTimeoutMs(input), 'mediaDownloadTimeoutMs')

  const saveDir = assertSafeSaveDir(stringOrEmpty(input.saveDir, 'saveDir') || 'generated')
  const apiKeyEnv = stringOrEmpty(input.apiKeyEnv, 'apiKeyEnv')
  const apiKey = stringOrEmpty(input.apiKey, 'apiKey')
    || resolveEnvKey(apiKeyEnv)
  const apiSource = stringOrEmpty(input.apiSource, 'apiSource') || 'manual'
  if (!['manual', 'llm-provider'].includes(apiSource)) fail('config apiSource must be one of manual, llm-provider')
  return {
    baseUrl: parsed.toString().replace(/\/+$/, ''),
    apiFlavor,
    apiKey,
    apiKeyEnv,
    apiSource,
    llmProvider: stringOrEmpty(input.llmProvider, 'llmProvider'),
    image: {
      enabled: image.enabled === undefined ? true : image.enabled,
      model: stringOrEmpty(image.model, 'image.model') || FLAVOR_MODELS[apiFlavor].image,
      timeoutMs: image.timeoutMs,
    },
    video: {
      enabled: video.enabled === undefined ? true : video.enabled,
      model: stringOrEmpty(video.model, 'video.model') || FLAVOR_MODELS[apiFlavor].video,
      timeoutMs: video.timeoutMs,
      pollIntervalMs: video.pollIntervalMs,
    },
    vision: {
      enabled: vision.enabled === undefined ? true : vision.enabled,
      model: stringOrEmpty(vision.model, 'vision.model') || VISION_MODEL_DEFAULT,
      timeoutMs: vision.timeoutMs,
      bridgeToText: vision.bridgeToText,
    },
    saveToWorkspace: input.saveToWorkspace === undefined ? true : input.saveToWorkspace,
    saveDir,
    requestTimeoutMs: requestTimeoutMs(input),
    mediaDownloadTimeoutMs: mediaDownloadTimeoutMs(input),
    ...(typeof input.resolveApiKey === 'function' ? { resolveApiKey: input.resolveApiKey } : {}),
  }
}

function requestTimeoutMs(input) {
  return input.requestTimeoutMs ?? 60000
}

function mediaDownloadTimeoutMs(input) {
  return input.mediaDownloadTimeoutMs ?? 300000
}

/** Read the whole settings.yaml document, or an empty object. */
export function readSettingsDocument(path = settingsFilePath()) {
  if (!existsSync(path)) return {}
  const text = readFileSync(path, 'utf8')
  if (text.trim().length === 0) return {}
  const parsed = yaml.load(text)
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
}

/** Read the plugin's user section (untyped; schema resolution happens later). */
export function readUserSection(path = settingsFilePath()) {
  const section = readSettingsDocument(path)[SETTINGS_NS]
  return section !== null && typeof section === 'object' && !Array.isArray(section) ? section : {}
}

/**
 * Reuse facts from a provider configured under the `llm-pi-ai:` settings
 * section: its base URL (the `v1` chat suffix stripped), credential reference,
 * and grok image/video/vision model ids when the provider catalog lists them.
 * @param {string} providerName - key in `llm-pi-ai.providers`, e.g. 'grok'.
 * @returns {{ baseUrl?: string, apiKeyEnv?: string, imageModel?: string, videoModel?: string, visionModel?: string }} resolved facts.
 */
export function resolveProviderFacts(providerName, path = settingsFilePath()) {
  const provider = readSettingsDocument(path)['llm-pi-ai']?.providers?.[providerName]
  if (provider === undefined || typeof provider !== 'object' || provider === null) return {}
  const baseURL = typeof provider.baseURL === 'string' ? provider.baseURL.replace(/\/+$/, '') : undefined
  const baseUrl = baseURL !== undefined
    ? baseURL.replace(/\/v1$/, '')
    : undefined
  const models = Array.isArray(provider.models) ? provider.models : []
  const idOf = (needle) => {
    const entry = models.find((model) => typeof model?.id === 'string' && model.id.includes(needle))
    return entry?.id
  }
  // Prefer the higher-quality image model when the provider catalog lists it:
  // a bare "imagine-image" substring would otherwise match whichever entry
  // appears first (base, -quality, or -lite).
  const imageModel = idOf('imagine-image-quality') ?? idOf('imagine-image')
  // Pick the newest Grok chat model from the provider catalog for image
  // recognition, skipping generation-only ids (imagine/video).
  const chatModelIds = models
    .map((model) => typeof model?.id === 'string' ? model.id : '')
    .filter((id) => id.length > 0 && !/imagine|video/i.test(id))
  const visionModel = chatModelIds.find((id) => /grok-4[.-]6/i.test(id))
    ?? chatModelIds.find((id) => /grok-4/i.test(id))
    ?? chatModelIds.find((id) => /grok-3/i.test(id))
    ?? chatModelIds[0]
  return {
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(typeof provider.apiKeyEnv === 'string' && provider.apiKeyEnv.length > 0 ? { apiKeyEnv: provider.apiKeyEnv } : {}),
    ...(imageModel !== undefined ? { imageModel } : {}),
    ...(idOf('imagine-video') !== undefined ? { videoModel: idOf('imagine-video') } : {}),
    ...(visionModel !== undefined ? { visionModel } : {}),
  }
}

/**
 * Merge a patch into the plugin's user section and write the document back.
 *
 * FALLBACK PATH ONLY — it re-renders the whole document through js-yaml (losing
 * comments and key order) and takes no writer lock. `apply` prefers the
 * registered settings scope, which patches just this namespace under a lock.
 * This exists for a composition that mounts no settings provider at all.
 */
export function writeUserSection(patch, path = settingsFilePath()) {
  const document = readSettingsDocument(path)
  const merged = { ...readUserSection(path), ...patch }
  document[SETTINGS_NS] = merged
  writeFileSync(path, yaml.dump(document), 'utf8')
  return merged
}

/** Markdown render of a successful `generate_image` canonical value. */
function renderImageResult(value) {
  const lines = [`Generated ${value.count} image(s) with grok2api and saved them to the session workspace.`]
  for (const [index, image] of (value.images ?? []).entries()) {
    if (image.path) lines.push(`Image ${index + 1} local file: \`${image.path}\``)
    if (image.url) lines.push(`Image ${index + 1} url: ${image.url}`)
    if (!image.url && !image.path) lines.push(`Image ${index + 1}: unavailable${image.saveError ? ` (${image.saveError})` : ''}`)
  }
  lines.push('In your reply, show each image with markdown image syntax using its rewritten url (a public media route), and list each local file path as inline code exactly as given. If an image fails to display in the UI, fall back to the local path.')
  return lines.join('\n')
}

/** Markdown render of a successful `generate_video` canonical value. */
function renderVideoResult(value) {
  const lines = [`Generated a video with grok2api (job ${value.id}).`]
  if (value.duration !== undefined) lines.push(`Duration: ${value.duration}s.`)
  if (value.path) lines.push(`Local file: \`${value.path}\``)
  lines.push(`Video url: ${value.url}`)
  if (value.saveError) lines.push(`Note: could not save a local copy (${value.saveError}).`)
  lines.push('The video embeds and plays in the tool card below. In your reply, list the local file path as inline code exactly as given and give the video url as a plain markdown link.')
  return lines.join('\n')
}

function presentImageCall(args) {
  return { card: 'generic', title: `Generate image: ${args.prompt}`, rawInput: args.prompt }
}

function presentVideoCall(args) {
  return { card: 'generic', title: `Generate video: ${args.prompt}`, rawInput: args.prompt }
}

/**
 * UI-facing result content. `GenericResultView.content` is a ContentBlock list,
 * not a string, and the view carries no `locations` — only a `diff` call view or
 * a `generic` call view with `kind: 'edit'` feeds the produced-files surface, and
 * neither shape fits a generation whose paths exist only after execute returns.
 */
function textContent(text) {
  return [{ type: 'text', text }]
}

function presentImageResult(_args, result) {
  if (result.isError) return undefined
  const count = typeof result.meta?.count === 'number' ? result.meta.count : 0
  return {
    card: 'generic',
    title: 'Generated images',
    content: textContent(`${count} image(s) generated`),
  }
}

function presentVideoResult(_args, result) {
  if (result.isError) return undefined
  const url = typeof result.meta?.url === 'string' ? result.meta.url : undefined
  return {
    card: 'generic',
    title: 'Generated video',
    content: textContent(url ?? 'Video generated'),
  }
}

/** Record one generated image: materialize bytes, then hand out the served URL. */
async function collectImage(cfg, item, index, exec) {
  const entry = {}
  if (item.url) entry.url = item.url
  try {
    if (item.b64) {
      entry.path = await saveMedia(exec, cfg.saveDir, 'image', decodeB64(item.b64), index, undefined, undefined)
    } else if (cfg.saveToWorkspace && item.url) {
      const { bytes, contentType } = await downloadBytes(item.url, cfg, exec.signal)
      entry.path = await saveMedia(exec, cfg.saveDir, 'image', bytes, index, contentType, item.url)
    }
  } catch (error) {
    if (!item.url) entry.saveError = String(error?.message ?? error)
  }
  if (entry.path) {
    // Prefer the host-served copy; without the route the remote url stands.
    const served = cfg.mediaUrlFor?.(entry.path)
    if (served !== undefined) entry.url = served
  }
  return entry
}

function imageTool(cfg) {
  return {
    name: 'generate_image',
    description: 'Generate an image with Grok through grok2api. Returns the image url(s) and, when saving is enabled, the local file path(s).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['prompt'],
      properties: {
        prompt: { type: 'string', description: 'Detailed description of the image to generate.' },
        count: { type: 'integer', minimum: 1, maximum: 4, description: 'Number of images to generate, 1 to 4. Default 1.' },
        aspect_ratio: { type: 'string', enum: IMAGE_ASPECT_RATIOS, description: 'Image aspect ratio; supported values depend on the model. Omit for the model default.' },
        quality: { type: 'string', enum: IMAGE_QUALITIES, description: 'Quality tier; omit for the model default.' },
        model: { type: 'string', description: 'Optional model override; defaults to the configured image model.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer' },
          images: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                url: { type: 'string' },
                path: { type: 'string' },
                saveError: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderImageResult(value) }],
      presentationMeta: (_args, value) => ({
        count: value.count,
        urls: (value.images ?? []).filter((image) => image.url).map((image) => image.url),
        locations: (value.images ?? []).filter((image) => image.path).map((image) => ({ path: image.path })),
      }),
    },
    timeoutMs: cfg.image.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
      if (prompt.length === 0) throw new Error('prompt must be a non-empty string')
      const count = args.count === undefined ? 1 : args.count
      if (!Number.isInteger(count) || count < 1 || count > 4) throw new Error('count must be an integer between 1 and 4')
      if (args.aspect_ratio !== undefined && !IMAGE_ASPECT_RATIOS.includes(args.aspect_ratio)) {
        throw new Error(`aspect_ratio must be one of ${IMAGE_ASPECT_RATIOS.join(', ')}`)
      }
      if (args.quality !== undefined && !IMAGE_QUALITIES.includes(args.quality)) {
        throw new Error(`quality must be one of ${IMAGE_QUALITIES.join(', ')}`)
      }
      const model = typeof args.model === 'string' && args.model.trim() ? args.model.trim() : cfg.image.model
      const items = await createImage(cfg, {
        prompt,
        count,
        model,
        ...(args.aspect_ratio !== undefined ? { aspectRatio: args.aspect_ratio } : {}),
        ...(args.quality !== undefined ? { quality: args.quality } : {}),
      }, exec.signal)
      const images = []
      for (const [index, item] of items.entries()) {
        images.push(await collectImage(cfg, item, index + 1, exec))
      }
      return { count: images.length, images }
    },
    presentCall: presentImageCall,
    presentResult: presentImageResult,
  }
}

function videoTool(cfg) {
  return {
    name: 'generate_video',
    description: 'Generate a video with Grok through grok2api. This is asynchronous and can take several minutes; the tool waits for completion. Returns the video url and, when saving is enabled, the local file path.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['prompt'],
      properties: {
        prompt: { type: 'string', description: 'Detailed description of the video to generate.' },
        duration: { type: 'integer', description: 'Video length in seconds; supported values depend on the model (common: 4, 8, 12). Omit for the API default.' },
        aspect_ratio: { type: 'string', enum: VIDEO_ASPECT_RATIOS, description: 'Video aspect ratio. Omit for the model default.' },
        model: { type: 'string', description: 'Optional model override; defaults to the configured video model.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          url: { type: 'string' },
          path: { type: 'string' },
          duration: { type: 'number' },
          saveError: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderVideoResult(value) }],
      presentationMeta: (_args, value) => ({
        id: value.id,
        url: value.url,
        ...(value.path ? { locations: [{ path: value.path }] } : {}),
      }),
    },
    timeoutMs: cfg.video.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
      if (prompt.length === 0) throw new Error('prompt must be a non-empty string')
      if (args.duration !== undefined && (!Number.isInteger(args.duration) || args.duration < 1)) {
        throw new Error('duration must be a positive integer of seconds')
      }
      if (args.aspect_ratio !== undefined && !VIDEO_ASPECT_RATIOS.includes(args.aspect_ratio)) {
        throw new Error(`aspect_ratio must be one of ${VIDEO_ASPECT_RATIOS.join(', ')}`)
      }
      const model = typeof args.model === 'string' && args.model.trim() ? args.model.trim() : cfg.video.model
      const result = await createAndPollVideo(cfg, {
        prompt,
        model,
        ...(args.duration !== undefined ? { duration: args.duration } : {}),
        ...(args.aspect_ratio !== undefined ? { aspectRatio: args.aspect_ratio } : {}),
      }, exec.signal)
      const value = { id: result.id, url: result.url, ...(result.duration !== undefined ? { duration: result.duration } : {}) }
      if (cfg.saveToWorkspace) {
        try {
          const { bytes, contentType } = await downloadBytes(result.url, cfg, exec.signal)
          value.path = await saveMedia(exec, cfg.saveDir, 'video', bytes, 1, contentType, result.url)
        } catch (error) {
          value.saveError = String(error?.message ?? error)
        }
      }
      if (value.path) {
        const served = cfg.mediaUrlFor?.(value.path)
        if (served !== undefined) value.url = served
      }
      return value
    },
    presentCall: presentVideoCall,
    presentResult: presentVideoResult,
  }
}

function presentVisionCall(args) {
  return { card: 'generic', title: `Recognize image: ${args.prompt}`, rawInput: args.prompt }
}

function presentVisionResult(_args, result) {
  if (result.isError) return undefined
  const text = typeof result.meta?.text === 'string' ? result.meta.text : undefined
  return {
    card: 'generic',
    title: 'Recognized image',
    content: textContent(text ?? 'Image recognized'),
  }
}


/**
 * Resolve the vision model to actually use. `latest` (or an empty value) asks
 * grok2api for `/v1/models` and picks the newest Grok chat model it advertises;
 * on any listing failure it falls back to {@link VISION_MODEL_FALLBACK}.
 *
 * The lookup is cached per `baseUrl + apiKey + session` so a session does not
 * hit `/v1/models` on every recognize_image call. A settings-provided provider
 * usually resolves to a concrete `cfg.vision.model` already, in which case this
 * function is never invoked.
 * @param {object} cfg - normalized plugin config.
 * @param {AbortSignal} signal - caller-owned signal.
 * @param {string} [sessionKey] - session-scoped cache key; defaults to `'default'`.
 * @returns {Promise<string>} a concrete model id.
 */
async function resolveLatestVisionModel(cfg, signal, sessionKey = 'default') {
  const cacheKey = `${cfg.baseUrl}|${cfg.apiKey ? 'set' : 'unset'}|${sessionKey}`
  const cached = visionModelCache.get(cacheKey)
  if (cached !== undefined) return cached
  let model = VISION_MODEL_FALLBACK
  try {
    const models = await listModels(cfg, signal)
    const chatModelIds = models.filter((id) => !/imagine|video/i.test(id))
    const picked = chatModelIds.find((id) => /grok-4[.-]6/i.test(id))
      ?? chatModelIds.find((id) => /grok-4/i.test(id))
      ?? chatModelIds.find((id) => /grok-3/i.test(id))
      ?? chatModelIds[0]
    model = picked ?? VISION_MODEL_FALLBACK
  } catch {
    model = VISION_MODEL_FALLBACK
  }
  visionModelCache.set(cacheKey, model)
  return model
}

/**
 * The model-facing image-recognition tool: sends one image to a Grok chat
 * model through grok2api and returns its text answer. Local files are read and
 * uploaded as data URLs; media-route URLs are resolved back to the local file
 * they sign so the backend never needs to reach the dsh web server.
 */
function visionTool(cfg) {
  return {
    name: 'recognize_image',
    description: 'Analyze an image with Grok through grok2api. Provide an image (local file path, data URL, or http(s) URL) and a prompt/question; returns the model’s text answer.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['image', 'prompt'],
      properties: {
        image: { type: 'string', description: 'Image to analyze: an http(s) URL, a data URL, or a local file path (absolute or relative to the session workspace).' },
        prompt: { type: 'string', description: 'Question or instruction about the image.' },
        model: { type: 'string', description: 'Optional Grok model override; defaults to the configured vision model.' },
        maxTokens: { type: 'integer', minimum: 1, description: 'Optional maximum number of output tokens.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
          model: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
      presentationMeta: (_args, value) => ({ text: value.text, model: value.model }),
    },
    timeoutMs: cfg.vision.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const image = typeof args.image === 'string' ? args.image.trim() : ''
      const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
      if (image.length === 0) throw new Error('image must be a non-empty URL, data URL, or local path')
      if (prompt.length === 0) throw new Error('prompt must be a non-empty string')
      const maxTokens = args.maxTokens === undefined ? undefined : args.maxTokens
      if (maxTokens !== undefined && (!Number.isInteger(maxTokens) || maxTokens < 1)) {
        throw new Error('maxTokens must be a positive integer')
      }
      const requestedModel = typeof args.model === 'string' && args.model.trim() ? args.model.trim() : cfg.vision.model
      const sessionKey = exec?.agent?.session?.id ?? 'default'
      const model = requestedModel === 'latest' || requestedModel === ''
        ? await resolveLatestVisionModel(cfg, exec.signal, sessionKey)
        : requestedModel
      const imageDataUrl = await imageDataUrlForInput(image, exec)
      const result = await createChatCompletion(cfg, {
        image: imageDataUrl,
        prompt,
        model,
        ...(maxTokens !== undefined ? { maxTokens } : {}),
      }, exec.signal)
      return { text: result.text, model: result.model }
    },
    presentCall: presentVisionCall,
    presentResult: presentVisionResult,
  }
}


/** True when a content block list contains a top-level image block. */
function hasImageBlocks(content) {
  return Array.isArray(content) && content.some((block) => block && typeof block === 'object' && block.type === 'image')
}

/**
 * Recognize one durable attachment through grok2api and return a text
 * description suitable for a text-only main model.
 * @param {object} cfg - normalized plugin config.
 * @param {object} attachment - durable image attachment reference.
 * @param {object} attachments - the host attachment service (`ctx.attachments`).
 * @param {AbortSignal} [signal] - optional cancellation.
 * @returns {Promise<string>} the Grok model's text answer.
 */
async function recognizeAttachment(cfg, attachment, attachments, signal) {
  const stored = await attachments.readImage(attachment)
  const bytes = Buffer.from(stored?.data ?? [])
  const mime = stored?.ref?.mediaType ?? 'image/png'
  const dataUrl = `data:${mime};base64,${bytes.toString('base64')}`
  const requestedModel = cfg.vision.model
  const model = requestedModel === 'latest' || requestedModel === ''
    ? await resolveLatestVisionModel(cfg, signal ?? new AbortController().signal, 'image-bridge')
    : requestedModel
  const result = await createChatCompletion(cfg, {
    image: dataUrl,
    prompt: 'Describe this image in detail for a text-only language model. Include all visible text, objects, people, actions, and context.',
    model,
  }, signal ?? new AbortController().signal)
  return result.text
}


/** Fields `configure_grok2api` accepts; every field is optional. */
const CONFIGURE_FIELDS = {
  baseUrl: { type: 'string', description: 'grok2api HTTP(S) base URL, e.g. http://127.0.0.1:8000.' },
  apiKey: { type: 'string', description: 'Client API key (sent as Authorization: Bearer). Empty string clears it.' },
  apiFlavor: { type: 'string', enum: FLAVORS, description: 'Backend flavor: chenyme (Go) or aurora (legacy Python).' },
  apiSource: { type: 'string', enum: ['manual', 'llm-provider'], description: "Config source: manual (this section's fields) or llm-provider (reuse a provider from the llm-pi-ai settings section)." },
  llmProvider: { type: 'string', description: 'Provider name in the llm-pi-ai providers section to reuse, e.g. grok; used when apiSource is llm-provider.' },
  imageModel: { type: 'string', description: 'Default image model; empty selects the flavor default.' },
  videoModel: { type: 'string', description: 'Default video model; empty selects the flavor default.' },
  visionModel: { type: 'string', description: 'Default Grok vision model used by recognize_image.' },
  visionBridgeToText: { type: 'boolean', description: 'Convert uploaded images to Grok text before sending to a text-only main model.' },
  imageEnabled: { type: 'boolean', description: 'Whether generate_image is available.' },
  videoEnabled: { type: 'boolean', description: 'Whether generate_video is available.' },
  visionEnabled: { type: 'boolean', description: 'Whether recognize_image is available.' },
  saveToWorkspace: { type: 'boolean', description: 'Download generated media into the session workspace.' },
  saveDir: { type: 'string', description: 'Workspace subdirectory for saved media; must stay relative.' },
}

/** Build the model-facing configuration tool, bound to the live config holder. */
function configureTool(holder) {
  return {
    name: 'configure_grok2api',
    description: 'Read or update the grok2api connection settings for the image/video/vision tools. Changes persist to settings.yaml and apply immediately. Call without arguments to view the current configuration.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: CONFIGURE_FIELDS,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          config: { type: 'object', additionalProperties: true },
          updated: { type: 'boolean' },
          savedTo: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.updated
          ? `grok2api configuration saved to ${value.savedTo} and applied live:\n${JSON.stringify(value.config, null, 2)}`
          : `Current grok2api configuration:\n${JSON.stringify(value.config, null, 2)}`,
      }],
      presentationMeta: (_args, value) => ({ updated: value.updated }),
    },
    timeoutMs: 30000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const current = holder.current()
      const patch = {}
      for (const key of Object.keys(CONFIGURE_FIELDS)) {
        if (args[key] === undefined) continue
        if (key === 'baseUrl') patch.baseUrl = typeof args.baseUrl === 'string' ? args.baseUrl.trim() : ''
        else if (key === 'apiKey') patch.apiKey = typeof args.apiKey === 'string' ? args.apiKey.trim() : ''
        else if (key === 'apiFlavor') patch.apiFlavor = args.apiFlavor
        else if (key === 'apiSource') patch.apiSource = args.apiSource
        else if (key === 'llmProvider') patch.llmProvider = typeof args.llmProvider === 'string' ? args.llmProvider.trim() : ''
        else if (key === 'imageModel') patch.image = { ...current.image, model: typeof args.imageModel === 'string' ? args.imageModel.trim() : '' }
        else if (key === 'videoModel') patch.video = { ...current.video, model: typeof args.videoModel === 'string' ? args.videoModel.trim() : '' }
        else if (key === 'visionModel') patch.vision = { ...current.vision, model: typeof args.visionModel === 'string' ? args.visionModel.trim() : '' }
        else if (key === 'visionBridgeToText') patch.vision = { ...current.vision, bridgeToText: Boolean(args.visionBridgeToText) }
        else if (key === 'imageEnabled') patch.image = { ...current.image, enabled: Boolean(args.imageEnabled) }
        else if (key === 'videoEnabled') patch.video = { ...current.video, enabled: Boolean(args.videoEnabled) }
        else if (key === 'visionEnabled') patch.vision = { ...current.vision, enabled: Boolean(args.visionEnabled) }
        else if (key === 'saveToWorkspace') patch.saveToWorkspace = Boolean(args.saveToWorkspace)
        else if (key === 'saveDir') patch.saveDir = typeof args.saveDir === 'string' ? args.saveDir.trim() : ''
      }
      const updated = Object.keys(patch).length > 0
      if (updated) {
        const savedTo = await holder.write(patch)
        // Reload from disk so provider-derived facts re-resolve too. A
        // registered scope's watcher reloads as well; both paths rebuild the
        // same config object, so the second reload is a no-op in effect.
        const next = holder.reload()
        return { config: displayConfig(next), updated: true, savedTo }
      }
      return { config: displayConfig(current), updated: false, savedTo: holder.documentPath() }
    },
    presentCall: () => ({ card: 'generic', title: 'Configure grok2api' }),
  }
}

/** User-facing config summary: never the raw API key. */
function displayConfig(cfg) {
  return {
    baseUrl: cfg.baseUrl,
    apiFlavor: cfg.apiFlavor,
    apiSource: cfg.apiSource,
    llmProvider: cfg.llmProvider,
    apiKey: cfg.apiKey ? '(set)' : (cfg.apiKeyEnv ? `(from env ${cfg.apiKeyEnv})` : '(unset)'),
    image: cfg.image,
    video: cfg.video,
    vision: cfg.vision,
    saveToWorkspace: cfg.saveToWorkspace,
    saveDir: cfg.saveDir,
  }
}

/**
 * Register the grok2api guidance section and tools.
 * Config resolution: schema defaults, then the patch-row config (base), then
 * the `grok2api-media-tool:` user section of $DSH_HOME/settings.yaml. When the composition
 * mounts a settings provider the plugin registers its namespace on it, which
 * supplies the safe write path and hot reload; `configure_grok2api` is the
 * model-facing edit surface either way.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {any} config - the patch row's config, schema-validated by the loader.
 */
export function apply(ctx, config) {
  const entry = config ?? {}
  const schemaEntry = Config(entry)
  const credentials = ctx.get?.('credentials')
  let cfg = normalizeConfig(schemaEntry)

  ctx.systemPrompt.section({ name: 'tool:grok2api-media-tool', order: 112, text: PROMPT_SECTION })

  // Image bridge: when a user message carries image attachments, convert each
  // image to a Grok-generated text description before the step reaches the main
  // model. This lets a text-only main model (e.g. DeepSeek) still answer image
  // questions: the uploaded image is recognized by Grok first, and DeepSeek
  // receives only the resulting text.
  //
  // agent/* events are scoped to each agent, so the bridge must be registered
  // on every agent's own context (`agent.ctx`) — a root `ctx.on` listener does
  // not see agent-scoped waterfalls.
  if (typeof ctx.on === 'function') {
    const attachBridge = (agent) => {
      if (!agent || !agent.ctx || typeof agent.ctx.on !== 'function' || bridgedAgents.has(agent)) return
      bridgedAgents.add(agent)
      agent.ctx.on('agent/pre-step', async (payload, next) => {
        const decision = await next()
        if (!decision || decision.kind !== 'enter' || !Array.isArray(decision.messages)) return decision
        if (cfg.vision.bridgeToText === false) return decision
        const attachments = ctx.get?.('attachments')
        if (!attachments) return decision
        let changed = false
        const messages = []
        for (const message of decision.messages) {
          if (!message || message.role !== 'user' || !hasImageBlocks(message.content)) {
            messages.push(message)
            continue
          }
          const content = []
          for (const block of message.content) {
            if (block && block.type === 'image') {
              changed = true
              try {
                const text = await recognizeAttachment(cfg, block.attachment, attachments, payload?.signal)
                content.push({ type: 'text', text: `[用户上传的图片内容：${text}]` })
              } catch (error) {
                content.push({ type: 'text', text: `[图片识别失败：${String(error?.message ?? error)}]` })
              }
            } else {
              content.push(block)
            }
          }
          messages.push({ ...message, content })
        }
        if (!changed) return decision
        return { ...decision, messages }
      })
    }
    ctx.on('agent/created', ({ agent }) => { attachBridge(agent) })
    const agents = ctx.get?.('agents')
    if (agents && typeof agents.list === 'function') {
      for (const agent of agents.list()) attachBridge(agent)
    }
  }

  const disposers = []
  const rejudge = () => {
    for (const dispose of disposers.splice(0)) dispose()
    disposers.push(ctx.tools.register(configureTool(holder)))
    if (cfg.image.enabled) disposers.push(ctx.tools.register(imageTool(cfg)))
    if (cfg.video.enabled) disposers.push(ctx.tools.register(videoTool(cfg)))
    if (cfg.vision.enabled) disposers.push(ctx.tools.register(visionTool(cfg)))
  }

  // Saved media is served from dsh's own web server (see media-proxy.js): the
  // url is same-origin with the UI and its signing key outlives the process, so
  // it survives a LAN bind, a tunnel, and a restart alike. Without a webServer
  // in the composition (headless) no route mounts and urls stay remote.
  let mediaKey
  try {
    mediaKey = loadMediaKey(dshHome())
  } catch (error) {
    ctx.logger?.warn?.('grok2api-media-tool: media signing key unavailable; media urls fall back to the remote host', error)
  }
  let mediaRouteMounted = false
  const mediaUrlFor = (filePath) => (
    mediaRouteMounted && mediaKey !== undefined ? localMediaUrl(mediaKey, filePath) : undefined
  )
  ctx.inject?.(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const disposers = []
      if (mediaKey !== undefined) {
        disposers.push(webCtx.webServer.register({
          kind: 'prefix',
          path: MEDIA_ROUTE_PATH,
          handler: createMediaHandler(mediaKey),
        }))
        mediaRouteMounted = true
      }
      // Composer upload route: stores the picked file and returns its local path.
      disposers.push(webCtx.webServer.register({
        kind: 'prefix',
        path: UPLOAD_ROUTE_PATH,
        handler: createUploadHandler(dshHome()),
      }))
      return () => {
        mediaRouteMounted = false
        for (const dispose of disposers) dispose()
      }
    })
  })

  // Rebuild cfg from the layered sources: schema defaults, then the patch-row
  // entry, then the grok2api user section, then (for apiSource=llm-provider)
  // facts derived from the named llm-pi-ai provider (baseUrl, key reference,
  // grok image/video/vision model ids). Re-registers tools after every rebuild.
  const reload = () => {
    const u = readUserSection()
    const source = u.apiSource ?? schemaEntry.apiSource
    const providerName = u.llmProvider ?? schemaEntry.llmProvider
    const facts = source === 'llm-provider' ? resolveProviderFacts(providerName) : {}
    if (source === 'llm-provider' && facts.baseUrl === undefined) {
      fail(`config apiSource is llm-provider but provider ${JSON.stringify(providerName)} has no baseURL in the llm-pi-ai settings section`)
    }
    const imageUser = u.image ?? {}
    const videoUser = u.video ?? {}
    const visionUser = u.vision ?? {}
    const next = normalizeConfig({
      ...schemaEntry,
      ...u,
      ...(u.baseUrl === undefined && facts.baseUrl !== undefined ? { baseUrl: facts.baseUrl } : {}),
      image: {
        ...schemaEntry.image,
        ...imageUser,
        ...(facts.imageModel !== undefined && !imageUser.model ? { model: facts.imageModel } : {}),
      },
      video: {
        ...schemaEntry.video,
        ...videoUser,
        ...(facts.videoModel !== undefined && !videoUser.model ? { model: facts.videoModel } : {}),
      },
      vision: {
        ...schemaEntry.vision,
        ...visionUser,
        ...(facts.visionModel !== undefined && !visionUser.model ? { model: facts.visionModel } : {}),
      },
      ...(u.apiKey === undefined && facts.apiKeyEnv !== undefined
        ? {

          apiKeyEnv: facts.apiKeyEnv,
          resolveApiKey: async () => {
            const resolved = await credentials?.resolve?.(facts.apiKeyEnv)
            if (resolved?.value) return resolved.value
            // Fallback: the managed credentials document, same as resolveEnvKey.
            return resolveEnvKey(facts.apiKeyEnv) || undefined
          },
        }
        : {}),
    })
    next.mediaUrlFor = mediaUrlFor
    // Object.assign only adds and overwrites. A resolver left behind by an
    // earlier apiSource=llm-provider config would keep shadowing a manually set
    // apiKey — request() prefers resolveApiKey and its fallback resolves to
    // undefined, so the call would silently go out unauthenticated.
    if (next.resolveApiKey === undefined) delete cfg.resolveApiKey
    // Mutate the stable cfg object in place so tool closures registered
    // earlier keep observing proxy/settings updates without re-registration.
    Object.assign(cfg, next)
    rejudge()
    return cfg
  }

  // The settings provider owns the document when one is mounted (below).
  let settingsService
  let settingsScope

  /** Absolute path of the document configure_grok2api reports having written. */
  const documentPath = () => settingsService?.documentPath ?? settingsFilePath()

  /**
   * Persist a patch into the `grok2api-media-tool:` user section.
   *
   * The registered scope is the path that keeps the document intact: the
   * provider takes a writer lock, reconciles from disk, patches only this one
   * namespace of the parsed YAML tree, and writes atomically — so comments, key
   * order, and a concurrent writer's sections (the Web Models page writes the
   * same file) all survive. The direct write is the fallback for a composition
   * that mounts no settings provider; it re-renders the whole document through
   * js-yaml and holds no lock.
   * @param {object} patch - partial `grok2api-media-tool:` section.
   * @returns {Promise<string>} the document path written.
   */
  const write = async (patch) => {
    if (settingsScope !== undefined) {
      await settingsScope.update(patch)
      return documentPath()
    }
    const path = settingsFilePath()
    writeUserSection(patch, path)
    return path
  }

  // Late binding: reload is initialized by the time any tool executes.
  const holder = { current: () => cfg, reload, write, documentPath }
  reload()

  // Register the namespace on the host settings provider, when the composition
  // mounts one. `ctx.inject` WAITS for the service instead of racing it: a bare
  // ctx.get() at apply time sees only providers whose fiber is already ACTIVE,
  // and the file provider's init reads and starts watching the document first.
  //
  // Registering buys two things: the locked, atomic, comment-preserving write
  // path `write()` uses, and a watcher that re-applies a hand edit of
  // settings.yaml without a restart. It does NOT put the section on the Web
  // settings page — that surface serves a hardcoded namespace allowlist (see
  // the module JSDoc), which no host-side registration can join.
  ctx.inject?.(['settings'], (settingsCtx) => {
    let scope
    try {
      scope = settingsCtx.settings.register(SETTINGS_NS, Config, {
        base: entry,
        validate: (value) => { normalizeConfig(value) },
      })
    } catch (error) {
      // A stored section the schema or validate() rejects fails the
      // registration itself. The tools stay up on the last good config, and
      // configure_grok2api remains the way to repair the document.
      ctx.logger?.warn?.('grok2api-media-tool: settings namespace registration failed; configure_grok2api remains available', error)
      return
    }
    settingsCtx.effect(() => {
      settingsService = settingsCtx.settings
      settingsScope = scope
      const unwatch = scope.watch(() => {
        try {
          holder.reload()
        } catch (error) {
          ctx.logger?.warn?.('grok2api-media-tool: rejected settings change', error)
        }
      })
      return () => {
        unwatch()
        // The scope dies with the provider's fiber; writes fall back to the
        // direct document write rather than calling a disposed scope.
        settingsService = undefined
        settingsScope = undefined
      }
    })
  })
}
