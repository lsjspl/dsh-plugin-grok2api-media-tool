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

 // Styles mirror the shipped plugin cards (PluginCard / ValueField CSS in
      // ui-settings-plugins) so this out-of-tree card reads as one of them: the
      // --dsw-alias-* tokens, the 12px-radius layered card, the 34px field input,
      // and the discard/save footer. Inline because the bundle has no CSS module.
      const STYLE = {
        // --- card (collapsible, like PluginCard) ---
        card: {
          listStyle: 'none',
          border: '1px solid var(--dsw-alias-border-l2)',
          borderRadius: '12px',
          background: 'var(--dsw-alias-bg-layer-3)',
          maxWidth: '760px',
          color: 'var(--dsw-alias-label-primary)',
        },
        cardOpen: {
          background: 'var(--dsw-alias-bg-layer-2)',
          borderColor: 'var(--dsw-alias-label-dimmed)',
        },
        header: {
          width: '100%', appearance: 'none', border: 0, background: 'none',
          font: 'inherit', color: 'inherit', textAlign: 'left', cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: '12px',
          padding: '14px 16px', borderRadius: '12px',
        },
        headText: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '4px' },
        name: { fontSize: '15px', fontWeight: 600, lineHeight: 1.4, color: 'var(--dsw-alias-label-primary)' },
        description: { fontSize: '13px', lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' },
        chevron: { flex: 'none', color: 'var(--dsw-alias-label-tertiary)' },
        pending: {
          flex: 'none', borderRadius: '999px', padding: '1px 8px',
          fontSize: '11px', lineHeight: '17px', fontWeight: 500, whiteSpace: 'nowrap',
          background: 'var(--dsw-alias-bg-module-platform)', color: 'var(--dsw-alias-label-secondary)',
        },
        body: { borderTop: '1px solid var(--dsw-alias-border-l2)', margin: '0 16px', paddingBottom: '8px' },
        // --- field (like ValueField) ---
        field: { display: 'flex', flexDirection: 'column', gap: '6px', padding: '12px 0' },
        head: { display: 'flex', alignItems: 'center', gap: '8px' },
        label: { flex: 1, minWidth: 0, fontSize: '13px', fontWeight: 500, lineHeight: 1.5, color: 'var(--dsw-alias-label-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
        badges: { display: 'inline-flex', alignItems: 'center', gap: '8px' },
        badge: {
          borderRadius: '999px', padding: '1px 8px', fontSize: '11px', lineHeight: '17px',
          whiteSpace: 'nowrap', fontWeight: 500,
          background: 'var(--dsw-alias-bg-module-platform)', color: 'var(--dsw-alias-label-secondary)',
        },
        reset: {
          border: 'none', background: 'none', padding: 0, font: 'inherit',
          fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer',
        },
        input: {
          height: '34px', padding: '0 12px',
          border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '8px',
          background: 'var(--dsw-alias-bg-layer-3)', font: 'inherit',
          fontSize: '13px', lineHeight: 1.5, color: 'var(--dsw-alias-label-primary)',
        },
        select: {
          height: '34px', padding: '0 8px',
          border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '8px',
          background: 'var(--dsw-alias-bg-layer-3)', font: 'inherit',
          fontSize: '13px', color: 'var(--dsw-alias-label-primary)',
        },
        checkbox: { width: '16px', height: '16px', margin: 0, cursor: 'pointer' },
        hint: { margin: 0, fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' },
        // --- section (a labelled group of fields inside the body) ---
        sectionTitle: { margin: '12px 0 0', fontSize: '13px', fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' },
        // --- footer (discard / save, like PluginCard) ---
        footer: {
          display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '8px',
          padding: '12px 0 4px', borderTop: '1px solid var(--dsw-alias-border-l2)',
        },
        failed: { flex: 1, minWidth: 0, margin: 0, fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-label-error)' },
        discard: {
          appearance: 'none', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '8px',
          padding: '5px 14px', font: 'inherit', fontSize: '13px', lineHeight: 1.5, cursor: 'pointer',
          background: 'none', color: 'var(--dsw-alias-label-secondary)',
        },
        save: {
          appearance: 'none', border: '1px solid transparent', borderRadius: '8px',
          padding: '5px 14px', font: 'inherit', fontSize: '13px', lineHeight: 1.5, cursor: 'pointer',
          background: 'var(--dsw-alias-label-primary)', color: 'var(--dsw-alias-bg-layer-3)',
        },
        disabled: { opacity: 0.4, cursor: 'default' },
        readOnly: { margin: '12px 0 0', fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' },
        code: {
          fontFamily: 'var(--dsw-font-mono, monospace)', fontSize: '12px',
          padding: '1px 5px', borderRadius: '4px',
          background: 'var(--dsw-alias-bg-module-platform)',
        },
        subField: { display: 'flex', flexDirection: 'column', gap: '6px', padding: '12px 0 0 0', marginLeft: '24px' },
      }

      /**
       * The plugin's entry in Settings -> Plugins -> Configuration. Editable:
       * reads/writes the `grok2api-media-tool` settings namespace through the
       * bound settings scope, and lists configured providers / model catalogs
       * through the llm RPCs. Owns its own staged form and revision fencing.
       */
      function Grok2ApiCard(props) {
        const { scope, connection, llmPiAiScope } = props
        const snap = React.useSyncExternalStore(
          (cb) => scope.subscribe(cb),
          () => scope.getSnapshot()
        )
        const value = (snap && snap.status === 'ready' && snap.value) || {}
        const userLayer = (snap && snap.user && typeof snap.user === 'object' ? snap.user : {})
        const writable = snap ? snap.writable : false
        // The llm-pi-ai namespace carries each provider's `models` array as
        // the user entered it on the Models page. A provider hand-configured
        // there lists its models here directly — no endpoint probe, so it works
        // for providers whose /v1/models is unreachable or unanswered.
        const piAiSnap = llmPiAiScope
          ? React.useSyncExternalStore(
              (cb) => llmPiAiScope.subscribe(cb),
              () => llmPiAiScope.getSnapshot()
            )
          : { status: 'unavailable', value: undefined }
        const piAiProviders = (piAiSnap && piAiSnap.status === 'ready' && piAiSnap.value && piAiSnap.value.providers) || {}

        // Draft edits keyed by flat field path: 'baseUrl', 'image.model', ...
        const [draft, setDraft] = React.useState({})
        const [saving, setSaving] = React.useState(false)
        const [failed, setFailed] = React.useState(false)
        const [open, setOpen] = React.useState(false)
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
        // purpose's own override when set, else the global llmProvider. Both
        // read the draft first so switching the provider in the form (before
        // save) re-runs model discovery for the newly chosen provider.
        const globalProvider = draft.llmProvider !== undefined ? draft.llmProvider : (pick(value, 'llmProvider') || '')
        const purposeProvider = (purpose) => {
          if (overrideProvider[purpose]) {
            return draft[`${purpose}.provider`] !== undefined
              ? draft[`${purpose}.provider`] : pick(value, `${purpose}.provider`) || ''
          }
          return globalProvider
        }

        // Pull each purpose's model list from the provider's `models` array in
        // the llm-pi-ai namespace (hand-entered on the Models page). This is a
        // direct config read, not an endpoint probe, so it works for providers
        // whose /v1/models is unreachable. Falls back to discoverModels RPC
        // only when the namespace carries no models array for the provider.
        React.useEffect(() => {
          let cancelled = false
          const next = {}
          let pending = 0
          const done = () => { if (!--pending && !cancelled) setModelLists(next) }
          for (const purpose of PURPOSES) {
            const providerName = purposeProvider(purpose)
            if (!providerName) { next[purpose] = []; continue }
            const providerCfg = piAiProviders[providerName]
            const configured = providerCfg && Array.isArray(providerCfg.models)
              ? providerCfg.models.map((m) => ({ id: typeof m?.id === 'string' ? m.id : '', name: m?.name }))
                  .filter((m) => m.id)
              : []
            if (configured.length) { next[purpose] = configured; continue }
            // No models array on the provider config: try probing the endpoint.
            if (connection && connection.api && connection.api.llm && apiSource === 'llm-provider') {
              pending++
              connection.api.llm.discoverModels({ settingsNs: LLM_PI_AI_NS, provider: providerName }).then((res) => {
                if (cancelled) return
                const rows = res && res.result && res.result.ok ? res.result.value.models : []
                next[purpose] = Array.isArray(rows) ? rows : []
                done()
              }).catch(() => { if (!cancelled) { next[purpose] = []; done() } })
            } else {
              next[purpose] = []
            }
          }
          if (!pending) setModelLists(next)
          return () => { cancelled = true }
        }, [piAiProviders, globalProvider, draft, overrideProvider, apiSource, connection])

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

        // One labelled field row, laid out like the shipped ValueField:
        // label (flex:1) + badges, then the control, then the hint.
        const renderField = (fieldPath, label, hint, opts) => {
          const val = displayValue(fieldPath)
          const overridden = isOverridden(fieldPath)
          const disabled = !writable || saving
          let control
          if (opts && opts.type === 'select') {
            control = h('select', {
              value: val, disabled, style: STYLE.select,
              onChange: (e) => edit(fieldPath, e.target.value),
            },
              ...(opts.allowBlank ? [h('option', { value: '' }, opts.blankLabel || '（用默认）')] : []),
              ...opts.options.map((o) => h('option', { value: o.value }, o.label))
            )
          } else if (opts && opts.type === 'password') {
            control = h('input', { type: 'password', placeholder: opts.placeholder || '', value: val, disabled, style: STYLE.input, onChange: (e) => edit(fieldPath, e.target.value) })
          } else if (opts && opts.type === 'checkbox') {
            control = h('input', { type: 'checkbox', checked: !!val, disabled, style: STYLE.checkbox, onChange: (e) => edit(fieldPath, e.target.checked ? 'true' : 'false') })
          } else {
            control = h('input', { type: opts && opts.numeric ? 'number' : 'text', value: val, disabled, style: STYLE.input, onChange: (e) => edit(fieldPath, e.target.value) })
          }
          return h('div', { style: STYLE.field },
            h('div', { style: STYLE.head },
              h('span', { style: STYLE.label }, label),
              h('span', { style: STYLE.badges },
                overridden ? h('span', { style: STYLE.badge }, '已覆盖') : null,
                overridden ? h('button', { style: STYLE.reset, onClick: () => resetField(fieldPath), disabled }, '重置') : null,
              ),
            ),
            control,
            hint ? h('p', { style: STYLE.hint }, hint) : null,
          )
        }

        // One purpose (image/video/vision): an enabled toggle, the model field
        // (select when a provider catalog is available, else text), and an
        // optional per-purpose provider override.
        const renderPurpose = (purpose, label, hint, extraFields) => {
          const enabledVal = displayValue(`${purpose}.enabled`)
          const enabledOverridden = isOverridden(`${purpose}.enabled`)
          const modelVal = displayValue(`${purpose}.model`)
          const modelOverridden = isOverridden(`${purpose}.model`)
          const hasOverride = !!overrideProvider[purpose]
          const modelOptions = (modelLists[purpose] || []).map((m) => ({ value: m.id, label: m.name || m.id }))
          const defaultModel = purpose === 'vision' ? VISION_DEFAULT : (FLAVOR_DEFAULTS[apiFlavor] || {})[purpose] || ''
          // Always a dropdown. When the catalog is empty (provider not yet
          // picked, or discovery not done), the list is the default value alone.
          const currentVal = modelVal || defaultModel
          const selectOptions = modelOptions.some((o) => o.value === currentVal)
            ? modelOptions
            : [{ value: currentVal, label: currentVal + '（默认）' }, ...modelOptions]
          const disabled = !writable || saving
          return h('div', { style: { ...STYLE.field, borderTop: '1px solid var(--dsw-alias-border-l2)' } },
            // Title row carries the enabled toggle on its right (label + badge
            // + checkbox share one line, so "启用" never stands alone).
            h('div', { style: { ...STYLE.head, justifyContent: 'space-between' } },
              h('span', { style: STYLE.sectionTitle }, label),
              h('span', { style: STYLE.badges },
                enabledOverridden ? h('span', { style: STYLE.badge }, '已覆盖') : null,
                h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap', cursor: 'pointer' } },
                  h('input', {
                    type: 'checkbox', style: STYLE.checkbox,
                    checked: enabledVal === 'true' || enabledVal === true, disabled,
                    onChange: (e) => edit(`${purpose}.enabled`, e.target.checked ? 'true' : 'false'),
                  }),
                  '启用',
                ),
              ),
            ),
            h('div', { style: STYLE.head },
              h('span', { style: STYLE.label }, '模型'),
              h('span', { style: STYLE.badges },
                modelOverridden ? h('span', { style: STYLE.badge }, '已覆盖') : null,
                modelOverridden ? h('button', { style: STYLE.reset, onClick: () => resetField(`${purpose}.model`), disabled }, '重置') : null,
              ),
            ),
            // Model: an input backed by a datalist so the catalog drops down
            // when discovery returns models, and the user can still type an id
            // by hand when discovery is empty/fails (some endpoints do not
            // answer /v1/models, and the browser-side probe may be blocked).
            h('input', {
              type: 'text', list: `grok2api-models-${purpose}`,
              value: modelVal, disabled, style: STYLE.input, placeholder: defaultModel,
              onChange: (e) => edit(`${purpose}.model`, e.target.value),
            }),
            h('datalist', { id: `grok2api-models-${purpose}` },
              modelOptions.map((o) => h('option', { value: o.value }, o.label))
            ),
            hint ? h('p', { style: STYLE.hint }, hint) : null,
            ...(extraFields || []).map((f) => renderField(`${purpose}.${f[0]}`, f[1], f[2], { numeric: true })),
            // "单独指定 provider" aligns with the fields above (no indent):
            // same head layout (label + badges) then the control below.
            h('div', { style: STYLE.head },
              h('span', { style: STYLE.label }, '单独指定 provider'),
              h('span', { style: STYLE.badges }),
              h('input', {
                type: 'checkbox', style: STYLE.checkbox, checked: hasOverride, disabled,
                onChange: (e) => setOverrideProvider((o) => ({ ...o, [purpose]: e.target.checked })),
              }),
            ),
            hasOverride
              ? h('div', { style: STYLE.field },
                  h('div', { style: STYLE.head },
                    h('span', { style: STYLE.label }, 'provider'),
                    h('span', { style: STYLE.badges }),
                  ),
                  h('select', {
                    value: draft[`${purpose}.provider`] !== undefined ? draft[`${purpose}.provider`] : (pick(value, `${purpose}.provider`) || ''),
                    disabled, style: STYLE.select, onChange: (e) => edit(`${purpose}.provider`, e.target.value),
                  },
                    h('option', { value: '' }, '（用全局）'),
                    ...providerOptions.map((p) => h('option', { value: p.provider }, p.displayName || p.provider)),
                  ),
                )
              : null,
          )
        }

        if (snap && snap.status === 'unavailable') {
          return h('li', { style: STYLE.card },
            h('div', { style: STYLE.header },
              h('div', { style: STYLE.headText },
                h('span', { style: STYLE.name }, 'Grok2API Media Tool'),
                h('span', { style: STYLE.description }, '配置命名空间不可用（settings 未挂载或只读模式）。'),
              ),
            ),
          )
        }

        return h('li', { style: { ...STYLE.card, ...(open ? STYLE.cardOpen : {}) } },
          // Collapsible header: name + description, a pending badge when dirty,
          // and a chevron that flips when open.
          h('button', { type: 'button', style: STYLE.header, onClick: () => setOpen((v) => !v) },
            h('div', { style: STYLE.headText },
              h('span', { style: STYLE.name }, 'Grok2API Media Tool'),
              h('span', { style: STYLE.description }, '生成图片/视频，并用 Grok 识别图片（generate_image / generate_video / recognize_image）。'),
            ),
            isDirty ? h('span', { style: STYLE.pending }, '待保存') : null,
            h('span', { style: { ...STYLE.chevron, transform: open ? 'rotate(180deg)' : 'none' } }, '▾'),
          ),
          open ? h('div', { style: STYLE.body },
            // --- 连接配置：始终复用 dsh 已配置的 LLM 提供方 ---
            renderField('llmProvider', 'provider', '选择已配置的 LLM 提供方，连接与默认模型将取自它。', {
              type: 'select', allowBlank: true, blankLabel: '（未选）',
              options: providerOptions.map((p) => ({ value: p.provider, label: p.displayName || p.provider })),
            }),
            renderField('apiFlavor', '后端类型', null, {
              type: 'select',
              options: FLAVORS.map((f) => ({ value: f, label: f })),
            }),
            // --- 各用途（含各自超时）---
            renderPurpose('image', '图片生成', 'generate_image 使用的模型。',
              [['timeoutMs', '超时 (ms)', 'generate_image 总超时。']]),
            renderPurpose('video', '视频生成', 'generate_video 使用的模型。',
              [['timeoutMs', '超时 (ms)', '视频生成+轮询+下载总超时。'], ['pollIntervalMs', '轮询间隔 (ms)', '视频状态轮询间隔。']]),
            renderPurpose('vision', '图片识别', 'recognize_image 使用的 Grok 语言模型。',
              [['timeoutMs', '超时 (ms)', 'recognize_image 总超时。']]),
            // --- 其它（全局开关与路径/超时）---
            h('div', { style: { ...STYLE.field, borderTop: '1px solid var(--dsw-alias-border-l2)' } },
              h('div', { style: STYLE.sectionTitle }, '其它'),
              h('div', { style: STYLE.head },
                h('span', { style: STYLE.label }, '保存到工作区'),
                h('span', { style: STYLE.badges }, isOverridden('saveToWorkspace') ? h('span', { style: STYLE.badge }, '已覆盖') : null),
                h('input', {
                  type: 'checkbox', style: STYLE.checkbox,
                  checked: displayValue('saveToWorkspace') === 'true' || displayValue('saveToWorkspace') === true,
                  disabled: !writable || saving,
                  onChange: (e) => edit('saveToWorkspace', e.target.checked ? 'true' : 'false'),
                }),
              ),
              h('div', { style: STYLE.head },
                h('span', { style: STYLE.label }, '图片转文字桥'),
                h('span', { style: STYLE.badges }, isOverridden('vision.bridgeToText') ? h('span', { style: STYLE.badge }, '已覆盖') : null),
                h('input', {
                  type: 'checkbox', style: STYLE.checkbox,
                  checked: displayValue('vision.bridgeToText') === 'true' || displayValue('vision.bridgeToText') === true,
                  disabled: !writable || saving,
                  onChange: (e) => edit('vision.bridgeToText', e.target.checked ? 'true' : 'false'),
                }),
              ),
              renderField('saveDir', '保存目录', '工作区下的子目录，须相对路径。'),
              renderField('requestTimeoutMs', '单次请求超时 (ms)', '单个 HTTP 请求超时。', { numeric: true }),
              renderField('mediaDownloadTimeoutMs', '下载超时 (ms)', '单个媒体文件下载超时（视频较大）。', { numeric: true }),
            ),
            // --- footer ---
            h('div', { style: STYLE.footer },
              failed ? h('p', { style: STYLE.failed }, '保存未生效，请检查输入') : null,
              saving ? h('p', { style: STYLE.failed }, '正在写入 settings.yaml…') : null,
              h('button', {
                style: { ...STYLE.discard, ...(((!isDirty && !failed) || saving) ? STYLE.disabled : {}) },
                disabled: (!isDirty && !failed) || saving,
                onClick: discard,
              }, '放弃'),
              h('button', {
                style: { ...STYLE.save, ...((!isDirty || saving || !writable) ? STYLE.disabled : {}) },
                disabled: !isDirty || saving || !writable,
                onClick: () => { void save() },
              }, saving ? '保存中…' : '保存'),
            ),
            h('p', { style: { ...STYLE.hint, marginTop: '8px' } },
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
                target: '_blank', rel: 'noopener noreferrer',
                style: { color: 'var(--dsw-alias-brand-primary)' },
              }, 'dsh-plugin-grok2api-media-tool'),
            ),
          ) : null,
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
        // The provider directory lives in the llm-pi-ai namespace; binding its
        // scope lets the card read each provider's `models` array directly
        // (hand-entered models are stored there, not discovered by probing).
        const llmPiAiScope = ctx.settingsScope && ctx.settingsScope.bind({ namespace: LLM_PI_AI_NS })
        const connection = ctx.connection
        ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
          name: 'settings.plugin.item',
          key: 'grok2api-media-tool',
        }, (props) => h(Grok2ApiCard, { ...props, scope, connection, llmPiAiScope })))

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
