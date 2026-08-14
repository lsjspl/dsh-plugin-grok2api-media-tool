/**
 * Client half of dsh-plugin-grok2api-media-tool: the embedded media tool cards
 * and one informational settings card.
 *
 * This file IS the built client bundle. The host's client-modules registry
 * serves it at `/plugins/dsh-plugin-grok2api-media-tool/client.js` and the
 * browser loads it as a classic script; it registers its factory under the
 * package name via `window.__ModuleLoader__.load`. Inside the factory, bare
 * specifiers resolve through the browser module table (`react` is a platform
 * seed word), so the bundle needs no build step and imports nothing directly.
 *
 * Why the settings card is read-only: dsh's api-proxy serves settings
 * namespaces to the browser from a HARDCODED allowlist (`WEB_SETTINGS_NAMESPACES`
 * plus configurable model providers), so an out-of-tree plugin's namespace
 * answers `settings-not-exposed` on read and write no matter how it registered
 * on the host. Exposing plugin-owned namespaces is deferred work upstream. The
 * card therefore explains the two channels that DO work — the
 * `configure_grok2api` tool and `$DSH_HOME/settings.yaml` — instead of
 * rendering a form whose every save would fail.
 *
 * Consequently this bundle binds no `ctx.settingsScope`: that service's `bind()`
 * resolves `connection` and `remote` from the CALLER's context, which a plugin
 * must therefore inject. Declaring only `['slots']` keeps this entry's
 * activation independent of the transport — and a client entry that fails to
 * activate takes the whole web boot down with it.
 */

;(function () {
  if (typeof window === 'undefined' || !window.__ModuleLoader__) return
  window.__ModuleLoader__.load({
    id: 'dsh-plugin-grok2api-media-tool',
    factory: function (require) {
      const React = require('react')
      const { createElement: h } = React

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
      }

      /**
       * The plugin's entry in Settings -> Plugins -> Configuration. Informational
       * by necessity (see the module JSDoc): it names the two channels that
       * actually reach the host.
       */
      function Grok2ApiCard() {
        return h('div', { style: STYLE.card },
          h('h3', { style: STYLE.title }, 'Grok2API Media Tool'),
          h('p', { style: STYLE.hint }, '生成图片和视频（generate_image / generate_video）。'),
          h('p', { style: STYLE.hint }, '本页不支持直接填写，请用以下方式配置：'),
          h('ul', { style: STYLE.list },
            h('li', null, '在对话里说「配置 grok2api」，模型会写入并立即生效'),
            h('li', null,
              '或编辑 ',
              h('code', { style: STYLE.code }, 'settings.yaml'),
              ' 的 ',
              h('code', { style: STYLE.code }, 'grok2api-media-tool:'),
              ' 节点',
            ),
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
        ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
          name: 'settings.plugin.item',
          id: 'grok2api-media-tool',
          order: 30,
          label: 'Grok2API Media Tool',
        }, Grok2ApiCard))

        // Embedded media cards: the video plays and the images render inside
        // the tool-result card. The url is a same-origin route on dsh's own
        // web server, so a relative src resolves wherever the page came from.
        ctx.slots.inject('tool.call.toolview', function* () {
          yield ctx.slots.register({ name: 'tool.call.toolview', key: 'generate_video' }, VideoCard)
          yield ctx.slots.register({ name: 'tool.call.toolview', key: 'generate_image' }, ImageCard)
        })
      }

      return { name: 'grok2api-media-tool-client', inject: ['slots'], apply }
    },
  })
})()
