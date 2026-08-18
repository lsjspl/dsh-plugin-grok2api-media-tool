/**
 * Local smoke test: exercises the grok2api client and media helpers against a
 * tiny in-process HTTP mock of the chenyme flavor. Run with `node test/smoke.mjs`.
 */

import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createAndPollVideo, createChatCompletion, createImage, FLAVOR_MODELS, rewriteMediaUrl } from '../api.js'
import { assertSafeSaveDir, decodeB64, downloadBytes, extFor, imageDataUrlForInput, saveMedia } from '../media.js'
import { apply as applyPlugin, Config, normalizeConfig, settingsFilePath, writeUserSection } from '../index.js'

/** Disposers collected from every fake effect (closed at suite teardown). */
const testDisposers = []

/**
 * Build a fake host context. The plugin reaches its settings provider through
 * `ctx.inject(['settings'], …)`, so the fake implements that seam and a
 * provider whose `update` persists into the section — the write path
 * configure_grok2api now takes.
 */
function fakeHostCtx(options = {}) {
  const registered = []
  const disposed = []
  const sections = []
  const state = {
    registered, disposed, sections,
    listeners: [],
    agentsList: [],
    registration: undefined,
    settingsValue: undefined,
    settingsWatcher: undefined,
    settingsWrites: [],
  }
  state.tools = {
    register: (definition) => {
      registered.push(definition)
      return () => disposed.push(definition.name)
    },
  }
  state.systemPrompt = { section: (section) => sections.push(section) }
  state.logger = { warn: () => {} }
  // 2 = cordis FIBER_ACTIVE.
  state.fiber = { state: 2 }
  state.on = (name, listener) => {
    state.listeners.push({ name, listener })
    return () => {}
  }
  state.get = (serviceName) => (
    serviceName === 'credentials' ? state.credentials
      : serviceName === 'attachments' ? state.attachments
        : serviceName === 'agents' ? state.agents
          : undefined
  )
  state.effect = (fn) => {
    const cleanup = fn()
    const disposer = () => cleanup?.()
    testDisposers.push(disposer)
    return disposer
  }
  // cordis's inject seam: run the callback once every named service exists.
  // The child context is the same fake, so settingsCtx.settings / webCtx.effect
  // resolve exactly as they do on a real child context.
  state.inject = (deps, callback) => {
    if (deps.every((dep) => state[dep] !== undefined)) callback(state)
  }
  // The host web server the media route mounts on (absent in headless).
  state.routes = []
  state.webServer = options.webServer === false ? undefined : {
    register: (route) => {
      state.routes.push(route)
      return () => { state.routes.splice(state.routes.indexOf(route), 1) }
    },
  }
  state.settings = options.settings === false ? undefined : {
    get documentPath() { return settingsFilePath() },
    register: (ns, schema, opts) => {
      state.registration = { ns, base: opts?.base, validate: opts?.validate }
      return {
        get: () => state.settingsValue ?? state.registration.base,
        watch: (watcher) => { state.settingsWatcher = watcher; return () => {} },
        // The real provider merges the patch into the user section and
        // persists it under a lock; persisting is what the plugin depends on.
        update: async (patch) => {
          state.settingsWrites.push(patch)
          writeUserSection(patch)
        },
        replace: async () => {},
        mutate: async () => {},
      }
    },
  }
  state.credentials = {
    resolve: async (ref) => (typeof ref === 'string' && ref.length > 0 ? { value: `cred-${ref}`, source: 'env' } : undefined),
  }
  state.attachments = {
    readImage: async (ref) => ({ data: b64PngBuffer(), ref: { mediaType: 'image/png' } }),
  }
  state.agents = {
    list: () => state.agentsList,
  }
  return state
}

const b64Png = () => 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const b64PngBuffer = () => Buffer.from(b64Png(), 'base64')

const videoPolls = new Map()
const seenAuth = []
const seenChat = []
let seenModels = 0

const server = http.createServer((req, res) => {
  seenAuth.push(req.headers.authorization ?? '')
  if (req.method === 'POST' && req.url === '/v1/images/generations') {
    if (!/^Bearer .+$/.test(req.headers.authorization ?? '')) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end('{"error":{"message":"invalid_api_key"}}')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ created: 1, data: [{ url: `http://127.0.0.1:${port}/img1.png` }, { b64_json: b64Png() }] }))
    return
  }
  if (req.method === 'GET' && req.url === '/v1/models') {
    seenModels += 1
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'grok-4.6' }, { id: 'grok-imagine-image' }] }))
    return
  }
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      const parsed = JSON.parse(body)
      seenChat.push(parsed)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        model: parsed.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'The image shows a cat.' }, finish_reason: 'stop' }],
      }))
    })
    return
  }
  if (req.method === 'POST' && req.url === '/v1/videos/generations') {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      const parsed = JSON.parse(body)
      const id = parsed.prompt === 'fail-now' ? 'vid_fail' : parsed.prompt === 'stay-pending' ? 'vid_slow' : 'vid_1'
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ request_id: id }))
    })
    return
  }
  const videoMatch = /^\/v1\/videos\/(vid_\w+)$/.exec(req.url ?? '')
  if (req.method === 'GET' && videoMatch) {
    const id = videoMatch[1]
    videoPolls.set(id, (videoPolls.get(id) ?? 0) + 1)
    res.writeHead(200, { 'content-type': 'application/json' })
    if (id === 'vid_fail') {
      res.end(JSON.stringify({ status: 'failed', error: { code: 'internal_error', message: 'boom' } }))
    } else if (id === 'vid_slow') {
      res.end(JSON.stringify({ status: 'pending', progress: 50 }))
    } else {
      res.end(JSON.stringify(videoPolls.get(id) >= 2
        ? { status: 'done', model: 'grok-imagine-video', progress: 100, video: { url: `http://127.0.0.1:${port}/v.mp4`, duration: 8 } }
        : { status: 'pending', progress: 50 }))
    }
    return
  }
  if (req.url === '/img1.png' || req.url === '/v1/media/images/x.png') {
    res.writeHead(200, { 'content-type': 'image/png' })
    res.end(b64PngBuffer())
    return
  }
  if (req.url === '/v.mp4') {
    res.writeHead(200, { 'content-type': 'video/mp4' })
    res.end(Buffer.from('00000018', 'hex'))
    return
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end('{}')
})

let port = 0
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
port = server.address().port

const cfg = {
  baseUrl: `http://127.0.0.1:${port}`,
  apiFlavor: 'chenyme',
  apiKey: 'test-key',
  image: { enabled: true, model: FLAVOR_MODELS.chenyme.image, timeoutMs: 60000 },
  video: { enabled: true, model: FLAVOR_MODELS.chenyme.video, timeoutMs: 60000, pollIntervalMs: 20 },
  vision: { enabled: true, model: 'grok-4.6', timeoutMs: 60000 },
  saveToWorkspace: true,
  saveDir: 'generated',
  requestTimeoutMs: 10000,
}

const signal = new AbortController().signal
// Keep test scratch inside the project (works under restricted sandboxes and CI).
await mkdir(join(process.cwd(), '.tmp'), { recursive: true })
const workspace = await mkdtemp(join(process.cwd(), '.tmp', 'smoke-'))
// Isolate every apply-style test from the real user home: the plugin reads
// $DSH_HOME/settings.yaml and .credentials.yaml at apply time.
const testHome = await mkdtemp(join(process.cwd(), '.tmp', 'dsh-home-'))
const previousTestHome = process.env.DSH_HOME
process.env.DSH_HOME = testHome
const exec = { agent: { session: { header: { cwd: workspace } } }, signal }

let failures = 0
function check(label, fn) {
  return Promise.resolve().then(fn).then(
    () => console.log(`PASS ${label}`),
    (error) => { failures += 1; console.error(`FAIL ${label}: ${error?.stack ?? error}`) },
  )
}

await check('auth header sent', async () => {
  assert.equal(seenAuth.length, 0)
  await createImage(cfg, { prompt: 'cat', count: 2, model: cfg.image.model }, signal)
  assert.equal(seenAuth.at(-1), 'Bearer test-key')
})

await check('createImage parses url + b64 items', async () => {
  const items = await createImage(cfg, { prompt: 'cat', count: 2, model: cfg.image.model }, signal)
  assert.equal(items.length, 2)
  assert.equal(items[0].url, `http://127.0.0.1:${port}/img1.png`)
  assert.ok(items[1].b64)
})

await check('createChatCompletion sends image and returns text', async () => {
  const result = await createChatCompletion(cfg, {
    image: `data:image/png;base64,${b64Png()}`,
    prompt: 'What is this?',
    model: 'grok-4.6',
  }, signal)
  assert.equal(result.text, 'The image shows a cat.')
  assert.equal(result.model, 'grok-4.6')
  const body = seenChat.at(-1)
  assert.equal(body.model, 'grok-4.6')
  assert.equal(body.messages[0].content[1].type, 'image_url')
  assert.equal(body.messages[0].content[1].image_url.url, `data:image/png;base64,${b64Png()}`)
})

await check('imageDataUrlForInput reads local file and media route', async () => {
  const path = join(workspace, 'pic.png')
  await writeFile(path, b64PngBuffer())
  const data = await imageDataUrlForInput(path, exec)
  assert.ok(data.startsWith('data:image/png;base64,'))
  const mediaUrl = `/grok2api-media/${encodeURIComponent(path)}?t=x`
  const data2 = await imageDataUrlForInput(mediaUrl, exec)
  assert.ok(data2.startsWith('data:image/png;base64,'))
  const remote = await imageDataUrlForInput('https://example.com/a.png', exec)
  assert.equal(remote, 'https://example.com/a.png')
})


await check('downloadBytes + saveMedia write with sniffed extension', async () => {
  const { bytes, contentType } = await downloadBytes(`http://127.0.0.1:${port}/img1.png`, cfg, signal)
  assert.equal(contentType, 'image/png')
  const path = await saveMedia(exec, cfg.saveDir, 'image', bytes, 7, contentType)
  assert.ok(path.endsWith('.png'))
  assert.ok((await readFile(path)).length > 0)
})

await check('extFor falls back to url extension and kind default', () => {
  assert.equal(extFor('image', 'image/png'), '.png')
  assert.equal(extFor('image', undefined, 'https://x/a.JPEG?q=1'), '.jpeg')
  assert.equal(extFor('video', undefined, undefined), '.mp4')
  assert.equal(extFor('image', undefined, undefined), '.png')
})

await check('decodeB64 tolerates data url prefix', () => {
  assert.equal(decodeB64(`data:image/png;base64,${b64Png()}`).length, b64PngBuffer().length)
})

await check('assertSafeSaveDir rejects escapes', () => {
  assert.equal(assertSafeSaveDir('generated/x'), 'generated/x')
  assert.throws(() => assertSafeSaveDir('../x'))
  assert.throws(() => assertSafeSaveDir('C:\\x'))
  assert.throws(() => assertSafeSaveDir(''))
})

await check('rewriteMediaUrl rewrites only loopback hosts', () => {
  const remote = { baseUrl: 'https://grok.example.com' }
  assert.equal(rewriteMediaUrl('http://127.0.0.1:8000/v1/media/images/x.png', remote), 'https://grok.example.com/v1/media/images/x.png')
  assert.equal(rewriteMediaUrl('http://localhost:8000/v1/media/images/x.png', remote), 'https://grok.example.com/v1/media/images/x.png')
  assert.equal(rewriteMediaUrl('/v1/media/images/x.png', remote), 'https://grok.example.com/v1/media/images/x.png')
  assert.equal(rewriteMediaUrl('https://grok.example.com/v1/media/images/x.png', remote), 'https://grok.example.com/v1/media/images/x.png')
  // Non-loopback hosts stay untouched, even when they differ from baseUrl.
  assert.equal(rewriteMediaUrl('https://other.example.com/v1/media/images/x.png', remote), 'https://other.example.com/v1/media/images/x.png')
  const local = { baseUrl: `http://127.0.0.1:${port}` }
  assert.equal(rewriteMediaUrl(`http://127.0.0.1:${port}/img1.png`, local), `http://127.0.0.1:${port}/img1.png`)
})

await check('createAndPollVideo polls to completion', async () => {
  const result = await createAndPollVideo(cfg, { prompt: 'a cat walking', model: cfg.video.model, duration: 8 }, signal)
  assert.equal(result.id, 'vid_1')
  assert.equal(result.url, `http://127.0.0.1:${port}/v.mp4`)
  assert.equal(result.duration, 8)
  assert.ok((videoPolls.get('vid_1') ?? 0) >= 2)
})

await check('createAndPollVideo surfaces server failure', async () => {
  await assert.rejects(
    () => createAndPollVideo(cfg, { prompt: 'fail-now', model: cfg.video.model }, signal),
    /vid_fail failed: boom/,
  )
})

await check('createAndPollVideo times out with a clear error', async () => {
  const slow = { ...cfg, video: { ...cfg.video, timeoutMs: 150, pollIntervalMs: 20 } }
  await assert.rejects(
    () => createAndPollVideo(slow, { prompt: 'stay-pending', model: cfg.video.model }, signal),
    /timed out after 150ms/,
  )
})

await check('HTTP error carries server detail', async () => {
  const noKey = { ...cfg, apiKey: '' }
  await assert.rejects(
    () => createImage(noKey, { prompt: 'cat', count: 1, model: cfg.image.model }, signal),
    /401 Unauthorized: invalid_api_key/,
  )
})

await check('normalizeConfig validates and defaults', () => {
  const resolved = normalizeConfig({ baseUrl: 'http://127.0.0.1:1/', apiFlavor: 'chenyme', image: {}, video: {} })
  assert.equal(resolved.baseUrl, 'http://127.0.0.1:1')
  assert.equal(resolved.image.model, 'grok-imagine-image-quality')
  assert.equal(resolved.video.model, 'grok-imagine-video')
  assert.equal(resolved.vision.model, 'latest')
  assert.equal(resolved.vision.enabled, true)
  assert.equal(resolved.saveDir, 'generated')
  assert.equal(resolved.saveToWorkspace, true)
  assert.throws(() => normalizeConfig({}), /baseUrl is required/)
  assert.throws(() => normalizeConfig({ baseUrl: 'not-a-url' }), /not a valid URL/)
  assert.throws(() => normalizeConfig({ baseUrl: 'http://x', apiFlavor: 'nope' }), /apiFlavor must be one of/)
  assert.throws(() => normalizeConfig({ baseUrl: 'http://x', video: { timeoutMs: 0 } }), /positive integer/)
  assert.throws(() => normalizeConfig({ baseUrl: 'http://x', saveDir: '../escape' }), /must not contain/)
})

await check('Config schema fills defaults and validates types', () => {
  const resolved = Config({ baseUrl: 'http://x:1', image: { timeoutMs: 30000 } })
  assert.equal(resolved.apiKey, '')
  assert.equal(resolved.apiFlavor, 'chenyme')
  assert.equal(resolved.image.timeoutMs, 30000)
  assert.equal(resolved.image.enabled, true)
  assert.equal(resolved.video.timeoutMs, 1200000)
  assert.equal(resolved.vision.model, 'latest')
  assert.equal(resolved.vision.timeoutMs, 60000)
  assert.equal(resolved.mediaDownloadTimeoutMs, 300000)
  assert.throws(() => Config({ requestTimeoutMs: 'abc' }), /requestTimeoutMs/)
  assert.throws(() => Config({ baseUrl: 42 }), /baseUrl/)
})

await check('apply registers configure + media tools with sections', async () => {
  const fake = fakeHostCtx()
  applyPlugin(fake, { baseUrl: `http://127.0.0.1:${port}`, apiKey: 'test-key', video: { pollIntervalMs: 20 } })
  assert.deepEqual(fake.registered.map((tool) => tool.name), ['configure_grok2api', 'generate_image', 'generate_video', 'recognize_image'])
  assert.equal(fake.sections.length, 1)
  assert.equal(fake.sections[0].name, 'tool:grok2api-media-tool')
  assert.ok(fake.sections[0].order > 0)
  for (const tool of fake.registered) {
    assert.ok(tool.timeoutMs > 0)
    assert.equal(tool.isConcurrencySafe(), true)
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(typeof tool.output.presentationMeta, 'function')
  }
  assert.ok(fake.registered[1].parameters.required.includes('prompt'))
  assert.ok(fake.registered[2].parameters.required.includes('prompt'))
})

await check('apply registers the settings namespace and re-registers tools live', async () => {
  const dshHome = await mkdtemp(join(process.cwd(), '.tmp', 'dsh-home-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = dshHome
  try {
    const fake = fakeHostCtx()
    applyPlugin(fake, { baseUrl: `http://127.0.0.1:${port}`, apiKey: 'test-key' })
    assert.equal(fake.registration.ns, 'grok2api-media-tool')
    assert.equal(fake.registration.base.baseUrl, `http://127.0.0.1:${port}`)
    assert.equal(typeof fake.registration.validate, 'function')
    assert.throws(() => fake.registration.validate({ baseUrl: 'not-a-url' }), /not a valid URL/)
    assert.deepEqual(fake.registered.map((tool) => tool.name), ['configure_grok2api', 'generate_image', 'generate_video', 'recognize_image'])
    assert.deepEqual(fake.disposed, [])
    // A settings-service commit triggers reload (which re-reads disk and re-registers).
    fake.settingsWatcher()
    assert.deepEqual(fake.disposed, ['configure_grok2api', 'generate_image', 'generate_video', 'recognize_image'])
    assert.equal(fake.registered.length, 8)
    assert.equal(fake.registered.at(-1).name, 'recognize_image')
  } finally {
    process.env.DSH_HOME = previousHome
    await rm(dshHome, { recursive: true, force: true })
  }
})

await check('configure_grok2api persists to settings.yaml and re-applies live', async () => {
  const dshHome = await mkdtemp(join(process.cwd(), '.tmp', 'dsh-home-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = dshHome
  try {
    const fake = fakeHostCtx()
    applyPlugin(fake, { baseUrl: `http://127.0.0.1:${port}`, apiKey: 'test-key' })
    const tool = fake.registered.find((entry) => entry.name === 'configure_grok2api')
    // Read-only call first.
    const current = await tool.execute({})
    assert.equal(current.updated, false)
    assert.equal(current.config.baseUrl, `http://127.0.0.1:${port}`)
    // Update the base url and key; verify the file and the live re-registration.
    const next = await tool.execute({ baseUrl: `http://127.0.0.1:12345/v2`, apiKey: 'new-key', saveDir: 'media' })
    assert.equal(next.updated, true)
    assert.equal(next.config.baseUrl, `http://127.0.0.1:12345/v2`)
    assert.equal(next.config.apiKey, '(set)')
    assert.equal(next.config.saveDir, 'media')
    assert.ok(next.savedTo.startsWith(dshHome))
    // The write went through the registered scope, not the raw document write.
    assert.equal(fake.settingsWrites.length, 1)
    assert.deepEqual(fake.settingsWrites[0], { baseUrl: `http://127.0.0.1:12345/v2`, apiKey: 'new-key', saveDir: 'media' })
    const { readSettingsDocument } = await import('../index.js')
    const document = readSettingsDocument(next.savedTo)
    assert.deepEqual(document['grok2api-media-tool'], { baseUrl: `http://127.0.0.1:12345/v2`, apiKey: 'new-key', saveDir: 'media' })
    assert.equal(fake.disposed.length, 4)
    assert.equal(fake.registered.length, 8)
    const imageToolEntry = fake.registered.find((entry) => entry.name === 'generate_image')
    assert.equal(imageToolEntry.name, 'generate_image')
    // A fresh apply in the same home picks the persisted section up.
    const fake2 = fakeHostCtx()
    applyPlugin(fake2, { baseUrl: 'http://unused.example' })
    const fresh = fake2.registered.find((entry) => entry.name === 'configure_grok2api')
    const view = await fresh.execute({})
    assert.equal(view.config.baseUrl, `http://127.0.0.1:12345/v2`)
    assert.equal(view.config.apiKey, '(set)')
  } finally {
    process.env.DSH_HOME = previousHome
    await rm(dshHome, { recursive: true, force: true })
  }
})

await check('configure_grok2api falls back to the direct document write with no settings provider', async () => {
  const dshHome = await mkdtemp(join(process.cwd(), '.tmp', 'dsh-home-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = dshHome
  try {
    const fake = fakeHostCtx({ settings: false })
    applyPlugin(fake, { baseUrl: `http://127.0.0.1:${port}` })
    assert.equal(fake.registration, undefined, 'no provider, no namespace registration')
    const tool = fake.registered.find((entry) => entry.name === 'configure_grok2api')
    const next = await tool.execute({ baseUrl: 'http://127.0.0.1:9/' })
    assert.equal(next.updated, true)
    const { readSettingsDocument } = await import('../index.js')
    assert.deepEqual(readSettingsDocument(next.savedTo), { 'grok2api-media-tool': { baseUrl: 'http://127.0.0.1:9/' } })
  } finally {
    process.env.DSH_HOME = previousHome
    await rm(dshHome, { recursive: true, force: true })
  }
})

await check('switching apiSource back to manual drops the provider key resolver', async () => {
  const dshHome = await mkdtemp(join(process.cwd(), '.tmp', 'dsh-home-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = dshHome
  try {
    await writeFile(join(dshHome, 'settings.yaml'), [
      'llm-pi-ai:',
      '  providers:',
      '    grok:',
      '      displayName: grok',
      '      apiKeyEnv: GROK_API_KEY',
      `      baseURL: http://127.0.0.1:${port}/v1`,
      'grok2api-media-tool:',
      '  apiSource: llm-provider',
      '  llmProvider: grok',
      '',
    ].join('\n'), 'utf8')
    const fake = fakeHostCtx()
    applyPlugin(fake, {})
    const live = fake.registered.find((entry) => entry.name === 'generate_image')
    // The provider-derived resolver is what authenticates while llm-provider is active.
    await live.execute({ prompt: 'cat', count: 1 }, exec)
    assert.equal(seenAuth.at(-1), 'Bearer cred-GROK_API_KEY')
    // Back to manual with an explicit key: the stale resolver must not shadow it.
    const cfgTool = fake.registered.find((entry) => entry.name === 'configure_grok2api')
    await cfgTool.execute({ apiSource: 'manual', apiKey: 'manual-key', baseUrl: `http://127.0.0.1:${port}` })
    const rebound = fake.registered.findLast((entry) => entry.name === 'generate_image')
    await rebound.execute({ prompt: 'cat', count: 1 }, exec)
    assert.equal(seenAuth.at(-1), 'Bearer manual-key')
  } finally {
    process.env.DSH_HOME = previousHome
    await rm(dshHome, { recursive: true, force: true })
  }
})

await check('resolveEnvKey falls back to .credentials.yaml', async () => {
  const dshHome = await mkdtemp(join(process.cwd(), '.tmp', 'dsh-home-'))
  const previousHome = process.env.DSH_HOME
  const previousKey = process.env.GROK_API_KEY
  process.env.DSH_HOME = dshHome
  delete process.env.GROK_API_KEY
  try {
    await writeFile(join(dshHome, '.credentials.yaml'), 'GROK_API_KEY: g2a_test_value\n', 'utf8')
    const { resolveEnvKey } = await import('../index.js')
    assert.equal(resolveEnvKey('GROK_API_KEY'), 'g2a_test_value')
    assert.equal(resolveEnvKey('MISSING_KEY'), '')
  } finally {
    process.env.DSH_HOME = previousHome
    if (previousKey !== undefined) process.env.GROK_API_KEY = previousKey
    await rm(dshHome, { recursive: true, force: true })
  }
})

await check('llm-provider source reuses llm-pi-ai provider facts', async () => {
  const dshHome = await mkdtemp(join(process.cwd(), '.tmp', 'dsh-home-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = dshHome
  try {
    await writeFile(join(dshHome, 'settings.yaml'), [
      'llm-pi-ai:',
      '  providers:',
      '    grok:',
      '      displayName: grok',
      '      apiKeyEnv: GROK_API_KEY',
      '      api: openai-responses',
      `      baseURL: http://127.0.0.1:${port}/v1`,
      '      models:',
      '        - id: grok-imagine-image',
      '        - id: grok-imagine-image-quality',
      '        - id: grok-imagine-video',
      'grok2api-media-tool:',
      '  apiSource: llm-provider',
      '  llmProvider: grok',
      '',
    ].join('\n'), 'utf8')
    const fake = fakeHostCtx()
    applyPlugin(fake, {})
    const cfgTool = fake.registered.find((entry) => entry.name === 'configure_grok2api')
    const view = await cfgTool.execute({})
    assert.equal(view.config.apiSource, 'llm-provider')
    assert.equal(view.config.baseUrl, `http://127.0.0.1:${port}`)
    assert.equal(view.config.image.model, 'grok-imagine-image-quality')
    assert.equal(view.config.video.model, 'grok-imagine-video')
    // The image request authenticates through the credentials seam.
    const imageTool = fake.registered.find((entry) => entry.name === 'generate_image')
    const value = await imageTool.execute({ prompt: 'cat', count: 1 }, exec)
    assert.match(value.images[0].url, /^\/grok2api-media\/.+\?t=/)
    assert.equal(seenAuth.at(-1), 'Bearer cred-GROK_API_KEY')
    // A provider without baseURL fails loud.
    await writeFile(join(dshHome, 'settings.yaml'), [
      'llm-pi-ai:',
      '  providers:',
      '    broken:',
      '      displayName: broken',
      '      apiKeyEnv: X',
      'grok2api-media-tool:',
      '  apiSource: llm-provider',
      '  llmProvider: broken',
      '',
    ].join('\n'), 'utf8')
    assert.throws(() => applyPlugin(fakeHostCtx(), {}), /no baseURL/)
  } finally {
    process.env.DSH_HOME = previousHome
    await rm(dshHome, { recursive: true, force: true })
  }
})

await check('generate_image execute saves url + b64 into session workspace', async () => {
  const fake = fakeHostCtx()
  applyPlugin(fake, {
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey: 'test-key',
    saveDir: 'generated',
  })
  const tool = fake.registered.find((entry) => entry.name === 'generate_image')
  const value = await tool.execute({ prompt: 'cat', count: 2 }, exec)
  assert.equal(value.count, 2)
  // Saved files are served same-origin from the host web server's media route.
  assert.match(value.images[0].url, /^\/grok2api-media\/.+\?t=/)
  assert.ok(value.images[0].path.startsWith(workspace))
  assert.ok(value.images[1].path.endsWith('.png'))
  assert.match(value.images[1].url, /^\/grok2api-media\//)
  // The routes the plugin mounted: media serving plus the composer upload path.
  assert.equal(fake.routes.length, 2)
  assert.equal(fake.routes[0].kind, 'prefix')
  assert.equal(fake.routes[0].path, '/grok2api-media')
  assert.equal(fake.routes[1].kind, 'prefix')
  assert.equal(fake.routes[1].path, '/grok2api-upload')
  const rendered = tool.output.render({ prompt: 'cat' }, value)
  assert.match(rendered[0].text, /Generated 2 image\(s\)/)
  assert.match(rendered[0].text, /list each local file path/)
  const meta = tool.output.presentationMeta({ prompt: 'cat' }, value)
  assert.equal(meta.locations.length, 2)
})

await check('without a webServer the media url stays remote', async () => {
  const fake = fakeHostCtx({ webServer: false })
  applyPlugin(fake, {
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey: 'test-key',
    saveDir: 'generated',
  })
  assert.deepEqual(fake.routes, [], 'no route mounted without a host web server')
  const tool = fake.registered.find((entry) => entry.name === 'generate_image')
  const value = await tool.execute({ prompt: 'cat', count: 1 }, exec)
  // The file is still saved; only the browser-facing rewrite is skipped.
  assert.ok(value.images[0].path.endsWith('.png'))
  assert.equal(value.images[0].url, `http://127.0.0.1:${port}/img1.png`)
})

await check('generate_video execute polls and saves the video', async () => {
  const fake = fakeHostCtx()
  applyPlugin(fake, {
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey: 'test-key',
    saveDir: 'generated',
    video: { pollIntervalMs: 20 },
  })
  const tool = fake.registered.find((entry) => entry.name === 'generate_video')
  const value = await tool.execute({ prompt: 'a cat walking', duration: 8 }, exec)
  assert.equal(value.id, 'vid_1')
  assert.match(value.url, /^\/grok2api-media\/.+\?t=/)
  assert.equal(value.duration, 8)
  assert.ok(value.path.endsWith('.mp4'))
  const rendered = tool.output.render({ prompt: 'a cat walking' }, value)
  assert.match(rendered[0].text, /Generated a video/)
})

await check('recognize_image execute sends local image and returns text', async () => {
  const path = join(workspace, 'recognize.png')
  await writeFile(path, b64PngBuffer())
  const fake = fakeHostCtx()
  applyPlugin(fake, {
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey: 'test-key',
    saveDir: 'generated',
  })
  const tool = fake.registered.find((entry) => entry.name === 'recognize_image')
  const value = await tool.execute({ image: path, prompt: 'What is this?' }, exec)
  assert.equal(value.text, 'The image shows a cat.')
  assert.equal(value.model, 'grok-4.6')
  // `latest` model resolution is cached per session: a second call must not
  // hit /v1/models again.
  const again = await tool.execute({ image: path, prompt: 'What is this?' }, exec)
  assert.equal(again.text, 'The image shows a cat.')
  assert.equal(seenModels, 1)
  const body = seenChat.at(-1)
  assert.ok(body.messages[0].content[1].image_url.url.startsWith('data:image/png;base64,'))
  const rendered = tool.output.render({ image: path, prompt: 'What is this?' }, value)
  assert.match(rendered[0].text, /The image shows a cat/)
})

await check('agent/pre-step bridge converts uploaded images to text', async () => {
  const fake = fakeHostCtx()
  const agentListeners = []
  const fakeAgent = {
    ctx: {
      on: (name, listener) => {
        agentListeners.push({ name, listener })
        return () => {}
      },
    },
  }
  fake.agentsList.push(fakeAgent)
  applyPlugin(fake, {
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey: 'test-key',
    saveDir: 'generated',
  })
  const preStep = agentListeners.find((entry) => entry.name === 'agent/pre-step')
  assert.ok(preStep, 'agent/pre-step listener is registered on the agent scope')
  const userMessage = {
    role: 'user',
    content: [
      { type: 'text', text: '看看这张图' },
      { type: 'image', attachment: { attachmentId: 'a1' } },
    ],
  }
  const decision = await preStep.listener(
    { turn: 1, step: 0, signal },
    async () => ({ kind: 'enter', messages: [userMessage] }),
  )
  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages.length, 1)
  assert.equal(decision.messages[0].content.length, 2)
  assert.equal(decision.messages[0].content[0].type, 'text')
  assert.equal(decision.messages[0].content[1].type, 'text')
  assert.match(decision.messages[0].content[1].text, /用户上传的图片内容：The image shows a cat/)
})



await check('client bundle registers the info card and the media toolviews', async () => {
  let handoff
  globalThis.window = { __ModuleLoader__: { load: (value) => { handoff = value } } }
  await import('../client.js')
  assert.ok(handoff, 'factory handoff registered')
  assert.equal(handoff.id, 'dsh-plugin-grok2api-media-tool')
  // The bundle only requires react; it deliberately does not bind
  // ctx.settingsScope or the conversation service (the upload button uses the
  // plugin's own host route instead of draft-image attachments).
  const requires = {
    react: { createElement: () => ({}), useState: (init) => [init, () => {}], useRef: () => ({ current: null }) },
  }
  const client = handoff.factory((spec) => {
    if (!(spec in requires)) throw new Error(`unexpected require: ${spec}`)
    return requires[spec]
  })
  assert.equal(client.name, 'grok2api-media-tool-client')
  assert.deepEqual(client.inject, ['slots'])

  const slots = []
  const slotGenerators = []
  const fakeCtx = {
    slots: {
      inject: (name, generator) => { slotGenerators.push({ name, generator }) },
      register: (options, component) => { slots.push({ options, component }); return slots.at(-1) },
    },
    effect: (fn) => { fn(); return () => {} },
  }
  client.apply(fakeCtx)
  const settingsInject = slotGenerators.find((entry) => entry.name === 'settings.plugin.item')
  assert.ok(settingsInject)
  settingsInject.generator()
  assert.equal(slots.length, 1)
  assert.equal(slots[0].options.key, 'grok2api-media-tool')
  // No `inject` face: the card owns no host-backed state to project.
  assert.equal(slots[0].options.inject, undefined)
  assert.equal(typeof slots[0].component, 'function')
  // The composer upload entry is registered in the conversation input row.
  const uploadInject = slotGenerators.find((entry) => entry.name === 'conversation.input.left')
  assert.ok(uploadInject)
  uploadInject.generator()
  const uploadSlot = slots[1]
  assert.equal(uploadSlot.options.id, 'grok2api-upload')
  assert.equal(uploadSlot.options.order, 30)
  assert.equal(uploadSlot.options.inject, undefined)
  assert.equal(typeof uploadSlot.component, 'function')
  // The embedded media toolviews register under the two wire tool names.
  const toolviewInject = slotGenerators.find((entry) => entry.name === 'tool.call.toolview')
  assert.ok(toolviewInject)
  const generator = toolviewInject.generator()
  let next = generator.next()
  while (!next.done) { next = generator.next() }
  const keys = slots.slice(2).map((entry) => entry.options.key).sort()
  assert.deepEqual(keys, ['generate_image', 'generate_video'])
  const videoCard = slots.find((entry) => entry.options.key === 'generate_video')
  assert.equal(typeof videoCard.component, 'function')
})

await check('media route serves only signed paths, and the signature survives a restart', async () => {
  const { createMediaHandler, loadMediaKey, localMediaUrl, MEDIA_ROUTE_PATH } = await import('../media-proxy.js')
  const keyHome = await mkdtemp(join(process.cwd(), '.tmp', 'dsh-home-'))
  const saved = join(workspace, 'generated', 'grok2api-video-test.mp4')
  await mkdir(join(workspace, 'generated'), { recursive: true })
  await writeFile(saved, 'FAKEMP4')
  // The key is created on first use and re-read afterwards: a second process
  // (here, a second load) signs and verifies identically, which is what keeps
  // an old session's media urls working after dsh restarts.
  const key = loadMediaKey(keyHome)
  const reloadedKey = loadMediaKey(keyHome)
  assert.ok(key.equals(reloadedKey), 'key is persisted, not regenerated')
  const server = http.createServer(createMediaHandler(reloadedKey))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  try {
    const url = localMediaUrl(key, saved)
    assert.ok(url.startsWith(`${MEDIA_ROUTE_PATH}/`), 'url is root-relative for same-origin embedding')
    const response = await fetch(`${origin}${url}`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'video/mp4')
    assert.equal(await response.text(), 'FAKEMP4')
    // An unsigned path is refused even though the file exists.
    const unsigned = await fetch(`${origin}${MEDIA_ROUTE_PATH}/${encodeURIComponent(saved)}`)
    assert.equal(unsigned.status, 404)
    // A token signed for one path does not authorize another.
    const swapped = new URL(`${origin}${url}`)
    swapped.pathname = `${MEDIA_ROUTE_PATH}/${encodeURIComponent(join(workspace, 'secret.txt'))}`
    assert.equal((await fetch(swapped)).status, 404)
    // Non-media prefixes are refused.
    assert.equal((await fetch(`${origin}/v1/responses`)).status, 404)
    // POST is refused.
    assert.equal((await fetch(`${origin}${url}`, { method: 'POST' })).status, 405)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(keyHome, { recursive: true, force: true })
  }
})

await check('upload route saves a file and returns its local path', async () => {
  const { createUploadHandler, UPLOAD_ROUTE_PATH } = await import('../media-proxy.js')
  const uploadHome = await mkdtemp(join(process.cwd(), '.tmp', 'dsh-upload-'))
  const uploadServer = http.createServer(createUploadHandler(uploadHome))
  await new Promise((resolve) => uploadServer.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${uploadServer.address().port}`
  try {
    const response = await fetch(`${origin}${UPLOAD_ROUTE_PATH}?name=test.png`, {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: Buffer.from('FAKEPNG'),
    })
    assert.equal(response.status, 200)
    const data = await response.json()
    assert.ok(data.path.startsWith(uploadHome))
    assert.equal(await readFile(data.path, 'utf8'), 'FAKEPNG')
  } finally {
    await new Promise((resolve) => uploadServer.close(resolve))
    await rm(uploadHome, { recursive: true, force: true })
  }
})


server.close()
for (const dispose of testDisposers) {
  try { dispose() } catch { /* teardown only */ }
}
process.env.DSH_HOME = previousTestHome
try {
  await rm(workspace, { recursive: true, force: true })
  await rm(testHome, { recursive: true, force: true })
} catch {
  // Windows may hold transient handles on test scratch; leave cleanup to the OS.
}
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exitCode = failures === 0 ? 0 : 1
