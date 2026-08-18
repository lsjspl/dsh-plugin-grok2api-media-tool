/**
 * Client half of dsh-plugin-grok2api-media-tool: the embedded media tool cards
 * and an editable settings card.
 *
 * This file IS the built client bundle. The host's client-modules registry
 * serves it at `/plugins/dsh-plugin-grok2api-media-tool/client.js` and the
 * browser loads it as a classic script; it registers its factory under the
 * package name via `window.__ModuleLoader__.load`. Inside the factory, bare
 * specifiers resolve through the browser module table (`react` is a platform
 * seed word), so the bundle needs no build step and imports nothing directly.
 *
 * The settings card reads and writes the `grok2api-media-tool` settings
 * namespace through `ctx.settingsScope` (rc.7 serves every registered
 * namespace to the browser), and lists configured LLM providers / their model
 * catalogs through the `llm.providers` and `llm.discoverModels` RPCs on
 * `ctx.connection.api`. The card owns its own staged form (draft → save) and
 * revision fencing — an out-of-tree bundle cannot import the host's form
 * chrome or its staged-form model, so it renders its own with
 * `React.createElement` and subscribes to the scope with React's built-in
 * `useSyncExternalStore`.
 */

;(function () {
  if (typeof window === 'undefined' || !window.__ModuleLoader__) return
  window.__ModuleLoader__.load({
    id: 'dsh-plugin-grok2api-media-tool',
    factory: function (require) {
      const React = require('react')
      const { createElement: h } = React

      // Per-flavor default model ids the form selects by default (mirrors
      // api.js FLAVOR_MODELS and index.js VISION_MODEL_DEFAULT; the client
      // bundle cannot import the host package, so the values are spelled here).
      const FLAVOR_DEFAULTS = {
        chenyme: { image: 'grok-imagine-image-quality', video: 'grok-imagine-video' },
        aurora: { image: 'grok-2-image', video: 'grok-2-video-2025-10-01' },
      }
      const FLAVORS = Object.keys(FLAVOR_DEFAULTS)
      const VISION_DEFAULT = 'latest'
      const LLM_PI_AI_NS = 'llm-pi-ai'
      const SETTINGS_NS = 'grok2api-media-tool'
      const PURPOSES = ['image', 'video', 'vision']

      const STYLE = {
        card: {
          display: 'flex', flexDirection: 'column', gap: '10px',
          padding: '16px 18px', border: '1px solid var(--dsw-alias-border, #333)',
          borderRadius: '10px', maxWidth: '560px',
        },
        title: { margin: 0, fontSize: '15px', fontWeight: 600 },
        hint: { margin: 0, fontSize: '12px', opacity: 0.75, lineHeight: 1.6 },
        list: { margin: 0, paddingInlineStart: '18px', fontSize: '12px', opacity: 0.75, lineHeight: 1.8 },
        code: {
          fontFamily: 'var(--dsw-font-mono, monospace)', fontSize: '12px',
          padding: '1px 5px', borderRadius: '4px',
          background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.16))',
        },
        section: {
          display: 'flex', flexDirection: 'column', gap: '8px',
          padding: '10px 0', borderTop: '1px solid var(--dsw-alias-border, #333)',
        },
        sectionTitle: { margin: 0, fontSize: '13px', fontWeight: 600 },
        field: { display: 'flex', flexDirection: 'column', gap: '4px' },
        fieldRow: { display: 'flex', alignItems: 'center', gap: '8px' },
        label: { fontSize: '12px', fontWeight: 500, minWidth: '90px' },
        input: {
          flex: 1, padding: '4px 8px', fontSize: '12px',
          border: '1px solid var(--dsw-alias-border, #333)', borderRadius: '6px',
          background: 'var(--dsw-alias-bg-layer-1, transparent)',
          color: 'var(--dsw-alias-label-primary, inherit)',
        },
        select: {
          flex: 1, padding: '4px 8px', fontSize: '12px',
          border: '1px solid var(--dsw-alias-border, #333)', borderRadius: '6px',
          background: 'var(--dsw-alias-bg-layer-1, transparent)',
          color: 'var(--dsw-alias-label-primary, inherit)',
        },
        checkbox: { width: '16px', height: '16px', margin: 0 },
        badge: {
          fontSize: '10px', padding: '1px 6px', borderRadius: '8px',
          background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.2))',
          color: 'var(--dsw-alias-label-secondary, #999)',
        },
        resetBtn: {
          fontSize: '11px', padding: '2px 8px', border: 'none', borderRadius: '4px',
          background: 'transparent', color: 'var(--dsw-alias-link, #4ea1ff)',
          cursor: 'pointer',
        },
        actions: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '4px' },
        btn: {
          padding: '6px 14px', fontSize: '12px', fontWeight: 600, border: 'none',
          borderRadius: '6px', cursor: 'pointer',
        },
        btnPrimary: {
          background: 'var(--dsw-alias-accent, #4ea1ff)', color: '#fff',
        },
        btnSecondary: {
          background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.16))',
          color: 'var(--dsw-alias-label-primary, inherit)',
        },
        status: { fontSize: '11px', opacity: 0.75 },
        overrideRow: { display: 'flex', alignItems: 'center', gap: '6px', marginLeft: '98px' },
      }

      /**
       * The plugin's entry in Settings -> Plugins -> Configuration. Editable:
       * reads/writes the `grok2api-media-tool` settings namespace through the
       * bound settings scope, and lists configured providers / model catalogs
       * through the llm RPCs. Owns its own staged form and revision fencing.
       */
      function Grok2ApiCard(props) {
        const { scope, connection } = props
        const snap = React.useSyncExternalStore(
          (cb) => scope.subscribe(cb),
          () => scope.getSnapshot()
        )
        const value = (snap && snap.status === 'ready' && snap.value) || {}
        const userLayer = (snap && snap.user && typeof snap.user === 'object' ? snap.user : {})
        const writable = snap ? snap.writable : false

        // Draft edits keyed by flat field path: 'baseUrl', 'image.model', ...
        const [draft, setDraft] = React.useState({})
        const [saving, setSaving] = React.useState(false)
        const [failed, setFailed] = React.useState(false)
        const [providers, setProviders] = React.useState(null)
        // Per-purpose discovered model lists: { image: [{id,name}], video: ..., vision: ... }
        const [modelLists, setModelLists] = React.useState({})
        // Per-purpose override-provider checkbox + selected provider.
        const [overrideProvider, setOverrideProvider] = React.useState({})

        const apiFlavor = pick(value, 'apiFlavor') || 'chenyme'
        const apiSource = pick(value, 'apiSource') || 'manual'

        // Load the configured provider directory once.
        React.useEffect(() => {
          if (!connection || !connection.api || !connection.api.llm) return
          let cancelled = false
          connection.api.llm.providers({}).then((res) => {
            if (cancelled) return
            const rows = res && res.result && res.result.ok ? res.result.value.providers : []
            setProviders(Array.isArray(rows) ? rows : [])
          }).catch(() => { if (!cancelled) setProviders([]) })
          return () => { cancelled = true }
        }, [connection])

        // The provider whose catalog each purpose draws models from: the
        // purpose's own override when set, else the global llmProvider.
        const globalProvider = pick(value, 'llmProvider') || ''
        const purposeProvider = (purpose) => {
          if (overrideProvider[purpose]) {
            return draft[`${purpose}.provider`] !== undefined
              ? draft[`${purpose}.provider`] : pick(value, `${purpose}.provider`) || ''
          }
          return globalProvider
        }

        // Discover models for a purpose's resolved provider whenever it changes.
        React.useEffect(() => {
          if (!connection || !connection.api || !connection.api.llm) return
          if (apiSource !== 'llm-provider') return
          let cancelled = false
          const next = { ...modelLists }
          let pending = 0
          const done = () => { if (!--pending && !cancelled) setModelLists(next) }
          for (const purpose of PURPOSES) {
            const providerName = purposeProvider(purpose)
            if (!providerName) continue
            if (modelLists[providerName + ':' + purpose]) { next[purpose] = modelLists[providerName + ':' + purpose]; continue }
            pending++
            connection.api.llm.discoverModels({ settingsNs: LLM_PI_AI_NS, provider: providerName }).then((res) => {
              if (cancelled) return
              const rows = res && res.result && res.result.ok ? res.result.value.models : []
              const list = Array.isArray(rows) ? rows : []
              next[providerName + ':' + purpose] = list
              next[purpose] = list
              done()
            }).catch(() => { if (!cancelled) { next[purpose] = []; done() } })
          }
          if (!pending) setModelLists(next)
          return () => { cancelled = true }
        }, [connection, apiSource, globalProvider, draft, overrideProvider])

        // Resolve what a control shows: the staged draft text, else the stored value.
        const displayValue = (fieldPath) => {
          if (draft[fieldPath] !== undefined) return draft[fieldPath]
          return pick(value, fieldPath) || ''
        }
        const isOverridden = (fieldPath) => hasOwnPath(userLayer, fieldPath)
        const isDirty = Object.keys(draft).length > 0

        const edit = (fieldPath, text) => {
          setDraft((d) => ({ ...d, [fieldPath]: text }))
          setFailed(false)
        }
        const resetField = (fieldPath) => {
          // Stage a clear: the draft empties; save() will unset the field.
          setDraft((d) => ({ ...d, [fieldPath]: '' }))
          setFailed(false)
        }
        const discard = () => { if (isDirty || failed) { setDraft({}); setFailed(false) } }

        const save = async () => {
          if (!isDirty || saving) return
          setSaving(true)
          setFailed(false)
          try {
            // Group nested writes: collect set/unset per top-level key, building
            // whole sub-objects for image/video/vision from their staged leaves.
            const sets = {} // topKey -> merged object value
            const unsets = new Set() // topKeys to clear wholesale
            const topLevel = new Set() // topKeys touched, to set or unset
            for (const path of Object.keys(draft)) {
              const text = draft[path]
              const topKey = path.includes('.') ? path.split('.')[0] : path
              topLevel.add(topKey)
              if (path.includes('.')) {
                const [, leaf] = path.split('.', 2)
                const current = sets[topKey] || { ...pick(value, topKey) }
                if (text === '') delete current[leaf]
                else current[leaf] = text
                sets[topKey] = current
              } else {
                if (text === '') unsets.add(topKey)
                else sets[topKey] = text
              }
            }
            let landed = true
            for (const topKey of topLevel) {
              if (unsets.has(topKey) && !sets[topKey]) {
                await scope.unset(topKey); landed = landed && !isStored(userLayer, topKey)
              } else if (sets[topKey] !== undefined) {
                await scope.set(topKey, sets[topKey])
                landed = landed && true
              }
            }
            if (landed) setDraft({})
            else setFailed(true)
          } catch (e) {
            setFailed(true)
          } finally {
            setSaving(false)
          }
        }

        const providerOptions = Array.isArray(providers) ? providers.filter((p) => p && p.provider) : []

        const renderField = (fieldPath, label, hint, opts) => {
          const val = displayValue(fieldPath)
          const overridden = isOverridden(fieldPath)
          const common = {
            value: val,
            onChange: (e) => edit(fieldPath, e.target.value),
            disabled: !writable || saving,
            style: STYLE.input,
          }
          let control
          if (opts && opts.type === 'select') {
            control = h('select', {
              value: val, disabled: !writable || saving, style: STYLE.select,
              onChange: (e) => edit(fieldPath, e.target.value),
            },
              ...(opts.allowBlank ? [h('option', { value: '' }, opts.blankLabel || '（用默认）')] : []),
              ...opts.options.map((o) => h('option', { value: o.value }, o.label))
            )
          } else if (opts && opts.type === 'password') {
            control = h('input', { type: 'password', placeholder: opts.placeholder || '', ...common })
          } else if (opts && opts.type === 'checkbox') {
            control = h('input', {
              type: 'checkbox', checked: !!val, disabled: !writable || saving, style: STYLE.checkbox,
              onChange: (e) => edit(fieldPath, e.target.checked ? 'true' : 'false'),
            })
          } else {
            control = h('input', { type: opts && opts.numeric ? 'number' : 'text', ...common })
          }
          return h('div', { style: STYLE.field },
            h('div', { style: STYLE.fieldRow },
              h('label', { style: STYLE.label }, label),
              control,
              overridden ? h('span', { style: STYLE.badge }, '已覆盖') : null,
              overridden ? h('button', { style: STYLE.resetBtn, onClick: () => resetField(fieldPath), disabled: !writable || saving }, '重置') : null,
            ),
            hint ? h('p', { style: STYLE.hint }, hint) : null,
          )
        }

        const renderPurpose = (purpose, label, hint) => {
          const enabledVal = displayValue(`${purpose}.enabled`)
          const enabledOverridden = isOverridden(`${purpose}.enabled`)
          const modelVal = displayValue(`${purpose}.model`)
          const modelOverridden = isOverridden(`${purpose}.model`)
          const hasOverride = !!overrideProvider[purpose]
          const providerVal = purposeProvider(purpose)
          const modelOptions = (modelLists[purpose] || []).map((m) => ({ value: m.id, label: m.name || m.id }))
          const defaultModel = purpose === 'vision' ? VISION_DEFAULT : (FLAVOR_DEFAULTS[apiFlavor] || {})[purpose] || ''
          const optionsWithDefault = modelOptions.length && !modelOptions.some((o) => o.value === modelVal)
            ? [{ value: modelVal, label: modelVal + '（当前）' }, ...modelOptions] : modelOptions
          return h('div', { style: STYLE.section },
            h('h4', { style: STYLE.sectionTitle }, label),
            h('div', { style: STYLE.fieldRow },
              h('label', { style: STYLE.label }, '启用'),
              h('input', {
                type: 'checkbox', style: STYLE.checkbox, checked: enabledVal === 'true' || enabledVal === true,
                disabled: !writable || saving,
                onChange: (e) => edit(`${purpose}.enabled`, e.target.checked ? 'true' : 'false'),
              }),
              enabledOverridden ? h('span', { style: STYLE.badge }, '已覆盖') : null,
            ),
            h('div', { style: STYLE.field },
              h('div', { style: STYLE.fieldRow },
                h('label', { style: STYLE.label }, '模型'),
                apiSource === 'llm-provider' && modelOptions.length
                  ? h('select', {
                      value: modelVal || defaultModel, disabled: !writable || saving, style: STYLE.select,
                      onChange: (e) => edit(`${purpose}.model`, e.target.value),
                    }, optionsWithDefault.map((o) => h('option', { value: o.value }, o.label)))
                  : h('input', {
                      type: 'text', value: modelVal, disabled: !writable || saving, style: STYLE.input,
                      placeholder: defaultModel,
                      onChange: (e) => edit(`${purpose}.model`, e.target.value),
                    }),
                modelOverridden ? h('span', { style: STYLE.badge }, '已覆盖') : null,
                modelOverridden ? h('button', { style: STYLE.resetBtn, onClick: () => resetField(`${purpose}.model`), disabled: !writable || saving }, '重置') : null,
              ),
            ),
            apiSource === 'llm-provider'
              ? h('div', { style: STYLE.overrideRow },
                  h('label', { style: { ...STYLE.label, minWidth: 'auto' } },
                    h('input', {
                      type: 'checkbox', style: STYLE.checkbox, checked: hasOverride,
                      disabled: !writable || saving,
                      onChange: (e) => setOverrideProvider((o) => ({ ...o, [purpose]: e.target.checked })),
                    }),
                    ' 单独指定 provider',
                  ),
                )
              : null,
            hasOverride && apiSource === 'llm-provider'
              ? renderField(`${purpose}.provider`, 'provider', null, {
                  type: 'select', allowBlank: true, blankLabel: '（用全局）',
                  options: providerOptions.map((p) => ({ value: p.provider, label: p.displayName || p.provider })),
                })
              : null,
            hint ? h('p', { style: STYLE.hint }, hint) : null,
          )
        }

        if (snap && snap.status === 'unavailable') {
          return h('div', { style: STYLE.card },
            h('h3', { style: STYLE.title }, 'Grok2API Media Tool'),
            h('p', { style: STYLE.hint }, '配置命名空间不可用（settings 未挂载或只读模式）。'),
          )
        }

        const manual = apiSource === 'manual'
        return h('div', { style: STYLE.card },
          h('h3', { style: STYLE.title }, 'Grok2API Media Tool'),
          h('p', { style: STYLE.hint }, '生成图片/视频，并用 Grok 识别图片（generate_image / generate_video / recognize_image）。'),
          // --- 全局连接区 ---
          h('div', { style: STYLE.section },
            h('h4', { style: STYLE.sectionTitle }, '连接配置'),
            renderField('apiSource', '配置来源', null, {
              type: 'select',
              options: [{ value: 'manual', label: '手动填写' }, { value: 'llm-provider', label: '复用 dsh 模型提供方' }],
            }),
            apiSource === 'llm-provider'
              ? renderField('llmProvider', 'provider', '选择已配置的 LLM 提供方，连接与默认模型将取自它。', {
                  type: 'select', allowBlank: true, blankLabel: '（未选）',
                  options: providerOptions.map((p) => ({ value: p.provider, label: p.displayName || p.provider })),
                })
              : null,
            manual ? renderField('baseUrl', '地址', 'grok2api HTTP(S) 地址', { numeric: false }) : null,
            manual ? renderField('apiKey', '密钥', '留空清除；非空以 Bearer 发送', { type: 'password', placeholder: '(未设置)' }) : null,
            manual ? renderField('apiKeyEnv', '密钥环境变量', 'apiKey 为空时从此环境变量读取', {}) : null,
            renderField('apiFlavor', '后端类型', null, {
              type: 'select',
              options: FLAVORS.map((f) => ({ value: f, label: f })),
            }),
          ),
          // --- 各用途区 ---
          renderPurpose('image', '图片生成', 'generate_image 使用的模型。'),
          renderPurpose('video', '视频生成', 'generate_video 使用的模型。'),
          renderPurpose('vision', '图片识别', 'recognize_image 使用的 Grok 语言模型。'),
          // --- 全局开关 ---
          h('div', { style: STYLE.section },
            h('div', { style: STYLE.fieldRow },
              h('label', { style: STYLE.label }, '保存到工作区'),
              h('input', {
                type: 'checkbox', style: STYLE.checkbox,
                checked: displayValue('saveToWorkspace') === 'true' || displayValue('saveToWorkspace') === true,
                disabled: !writable || saving,
                onChange: (e) => edit('saveToWorkspace', e.target.checked ? 'true' : 'false'),
              }),
              isOverridden('saveToWorkspace') ? h('span', { style: STYLE.badge }, '已覆盖') : null,
            ),
            visionOverrideNote(value, displayValue, isOverridden, 'vision.bridgeToText', edit, writable, saving),
          ),
          // --- 操作区 ---
          h('div', { style: STYLE.actions },
            h('button', {
              style: { ...STYLE.btn, ...STYLE.btnPrimary },
              disabled: !isDirty || saving || !writable,
              onClick: () => { void save() },
            }, saving ? '保存中…' : '保存'),
            h('button', {
              style: { ...STYLE.btn, ...STYLE.btnSecondary },
              disabled: (!isDirty && !failed) || saving,
              onClick: discard,
            }, '放弃'),
            failed ? h('span', { style: { ...STYLE.status, color: 'var(--dsw-alias-danger, #e57373)' } }, '保存未生效，请检查输入') : null,
            saving ? h('span', { style: STYLE.status }, '正在写入 settings.yaml…') : null,
          ),
          h('p', { style: STYLE.hint },
            '或编辑 ',
            h('code', { style: STYLE.code }, 'settings.yaml'),
            ' 的 ',
            h('code', { style: STYLE.code }, 'grok2api-media-tool:'),
            ' 节点；也可在对话里说「配置 grok2api」。',
          ),
          h('p', { style: STYLE.hint },
            'Github：',
            h('a', {
              href: 'https://github.com/lsjspl/dsh-plugin-grok2api-media-tool',
              target: '_blank',
              rel: 'noopener noreferrer',
              style: { color: 'var(--dsw-alias-link, #4ea1ff)' },
            }, 'dsh-plugin-grok2api-media-tool'),
          ),
        )
      }

      // Helpers: dotted-path read/presence on the nested user layer.
      function pick(obj, path) {
        const parts = path.split('.')
        let cur = obj
        for (const p of parts) {
          if (cur === null || cur === undefined || typeof cur !== 'object') return undefined
          cur = cur[p]
        }
        return cur
      }
      function hasOwnPath(obj, path) {
        const parts = path.split('.')
        let cur = obj
        for (let i = 0; i < parts.length; i++) {
          if (cur === null || cur === undefined || typeof cur !== 'object') return false
          if (!Object.prototype.hasOwnProperty.call(cur, parts[i])) return false
          cur = cur[parts[i]]
        }
        return true
      }
      function isStored(userLayer, topKey) {
        return !!userLayer && Object.prototype.hasOwnProperty.call(userLayer, topKey)
      }
      // The vision.bridgeToText checkbox rendered inline (kept out of the
      // generic purpose loop because it has no model/provider).
      function visionOverrideNote(value, displayValue, isOverridden, fieldPath, edit, writable, saving) {
        return h('div', { style: STYLE.fieldRow },
          h('label', { style: STYLE.label }, '图片转文字桥'),
          h('input', {
            type: 'checkbox', style: STYLE.checkbox,
            checked: displayValue(fieldPath) === 'true' || displayValue(fieldPath) === true,
            disabled: !writable || saving,
            onChange: (e) => edit(fieldPath, e.target.checked ? 'true' : 'false'),
          }),
          isOverridden(fieldPath) ? h('span', { style: STYLE.badge }, '已覆盖') : null,
        )
      }

      const UPLOAD_BUTTON_STYLE = {
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: '28px', height: '28px', padding: 0, border: 'none', borderRadius: '8px',
        background: 'transparent', color: 'var(--dsw-alias-label-secondary, #999)',
        cursor: 'pointer', fontSize: '15px', lineHeight: 1,
      }

      /**
       * An image-upload entry in the composer's left tool row. Instead of
       * attaching the image (which many text-only main models reject), this
       * uploads the picked file to the plugin's host route, gets back a local
       * path, and inserts that path into the input draft. The agent can then
       * call `recognize_image` with the path for Grok multimodal recognition.
       */
      function UploadImageButton(props) {
        const inputRef = React.useRef(null)
        const uploadAndInsert = async (file) => {
          if (!file || !props.inputActions) return
          try {
            const response = await fetch(`/grok2api-upload?name=${encodeURIComponent(file.name)}`, {
              method: 'POST',
              headers: { 'content-type': file.type || 'application/octet-stream' },
              body: file,
            })
            if (!response.ok) {
              const text = await response.text().catch(() => '')
              throw new Error(`upload failed (${response.status}): ${text}`)
            }
            const data = await response.json()
            if (!data.path) throw new Error('upload response missing path')
            const draft = props.input?.draft ?? ''
            props.inputActions.setDraft(draft === '' ? data.path : `${draft} ${data.path}`)
          } catch (error) {
            console.warn('[grok2api-media-tool] upload failed:', error)
          }
        }
        return h('span', { style: { display: 'inline-flex', alignItems: 'center' } },
          h('input', {
            ref: inputRef,
            type: 'file',
            accept: 'image/*',
            style: { display: 'none' },
            onChange: (event) => {
              const file = event.target.files?.[0]
              if (file) uploadAndInsert(file)
              event.target.value = ''
            },
          }),
          h('button', {
            type: 'button',
            title: '上传图片并插入路径',
            'aria-label': '上传图片并插入路径',
            style: UPLOAD_BUTTON_STYLE,
            onClick: () => inputRef.current?.click(),
          }, '🖼️'),
        )
      }


      /** Media urls a settled tool result carries, preferring the host-computed meta. */
      function extractUrls(block) {
        const meta = block && typeof block === 'object' ? block.meta : undefined
        if (meta && typeof meta === 'object') {
          if (typeof meta.url === 'string' && meta.url.length > 0) return [meta.url]
          if (Array.isArray(meta.urls) && meta.urls.every((entry) => typeof entry === 'string')) return meta.urls
        }
        const texts = (block?.content ?? [])
          .filter((blockItem) => blockItem && blockItem.type === 'text')
          .map((blockItem) => blockItem.text)
          .join('\n')
        const match = /(?:Video|Image \d+) url: (\S+)/.exec(texts)
        return match ? [match[1]] : []
      }

      function VideoCard(props) {
        const block = props.block
        if (!block || block.kind !== 'tool-result') {
          return h('div', { style: { padding: '10px 0' } }, h('p', { style: { margin: 0, opacity: 0.8 } }, '视频生成中…'))
        }
        const urls = extractUrls(block)
        if (urls.length === 0) {
          return h('p', { style: { margin: 0, opacity: 0.8 } }, '视频已生成（详见结果文本）。')
        }
        return h('div', { style: { padding: '10px 0' } },
          h('video', {
            key: urls[0],
            src: urls[0],
            controls: true,
            playsInline: true,
            style: { width: '100%', maxWidth: '520px', borderRadius: '8px', display: 'block', background: '#000' },
          }),
        )
      }

      function ImageCard(props) {
        const block = props.block
        if (!block || block.kind !== 'tool-result') {
          return h('div', { style: { padding: '10px 0' } }, h('p', { style: { margin: 0, opacity: 0.8 } }, '图片生成中…'))
        }
        const urls = extractUrls(block)
        if (urls.length === 0) {
          return h('p', { style: { margin: 0, opacity: 0.8 } }, '图片已生成（详见结果文本）。')
        }
        return h('div', { style: { padding: '10px 0', display: 'flex', flexWrap: 'wrap', gap: '8px' } },
          urls.map((url) => h('img', {
            key: url,
            src: url,
            alt: 'generated image',
            style: { maxWidth: '100%', maxHeight: '420px', borderRadius: '8px' },
          })),
        )
      }

      function apply(ctx) {
        const scope = ctx.settingsScope && ctx.settingsScope.bind({ namespace: SETTINGS_NS })
        const connection = ctx.connection
        ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
          name: 'settings.plugin.item',
          key: 'grok2api-media-tool',
        }, (props) => h(Grok2ApiCard, { ...props, scope, connection })))

        // A visible image-upload entry in the composer's left tool row. The
        // slot is session-scoped, so the component receives `inputActions` from
        // the session standard kit. Picking a file uploads it to the plugin's
        // host route and inserts the returned local path into the draft.
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: 'grok2api-upload',
          order: 30,
        }, UploadImageButton))

        // Embedded media cards: the video plays and the images render inside
        // the tool-result card. The url is a same-origin route on dsh's own
        // web server, so a relative src resolves wherever the page came from.
        ctx.slots.inject('tool.call.toolview', function* () {
          yield ctx.slots.register({ name: 'tool.call.toolview', key: 'generate_video' }, VideoCard)
          yield ctx.slots.register({ name: 'tool.call.toolview', key: 'generate_image' }, ImageCard)
        })
      }

      return { name: 'grok2api-media-tool-client', inject: ['slots', 'connection', 'remote', 'settingsScope'], apply }
    },
  })
})()
