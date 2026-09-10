// dsh-autostart — browser face.
//
// A settings card (General settings) with four controls. Talks to the host
// over same-origin fetch; no Typert manifest is required.
window.__ModuleLoader__.load({
  id: 'dsh-autostart',
  factory: (require) => {
    const react = require('react')
    const h = react.createElement

    const CSS = [
      '.dsas_card{border-bottom:1px solid var(--dsw-alias-border-l2);padding:16px 0;display:flex;flex-direction:column;gap:10px;font-size:14px;color:var(--dsw-alias-label-primary)}',
      '.dsas_head{display:flex;align-items:center;gap:8px;font-weight:400;line-height:22px}',
      '.dsas_grid{display:flex;flex-direction:column;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.dsas_row{display:flex;align-items:center;gap:8px}',
      '.dsas_url{font-family:ui-monospace,Consolas,monospace;font-size:12px;word-break:break-all;color:var(--dsw-alias-label-secondary)}',
      '.dsas_actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.dsas_btn{background:var(--dsw-alias-bg-module-platform);height:32px;color:var(--dsw-alias-label-primary);cursor:pointer;border:none;border-radius:16px;padding:0 14px;font-family:inherit;font-size:13px;display:inline-flex;align-items:center}',
      '.dsas_btn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsas_btn:disabled{cursor:default;opacity:.5}',
      '.dsas_warn{color:var(--dsw-alias-state-warning-primary)}',
      '.dsas_error{color:var(--dsw-alias-state-error-primary)}',
      '.dsas_ok{color:var(--dsw-alias-state-success-primary)}',
    ].join('')

    const CSS_TAG = 'dsh-autostart/card.css'
    if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${CSS_TAG}"]`) === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-autostart'
      tag.dataset.pluginCss = CSS_TAG
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    const zh = {
      'card.title': 'DSH 服务与开机自启',
      'card.service': '服务',
      'card.running': '运行中(端口 {port})',
      'card.stopped': '已停止',
      'card.autostart': '开机自启',
      'card.on': '已启用',
      'card.off': '未启用',
      'card.foreign': '注册表里有一条同名但非本插件的自启项,未改动它',
      'card.url': '访问地址',
      'card.urlMissing': '尚未取到(服务还没启动过)',
      'card.hook': '钩子脚本',
      'card.hookMissing': '配置了但文件不存在',
      'card.hookNone': '未配置',
      'card.copy': '复制',
      'card.copied': '已复制',
      'card.enable': '启用自启',
      'card.disable': '停用自启',
      'card.restart': '重启服务',
      'card.restarting': '正在重启…',
      'card.confirm': '重启会中断正在进行的任务,未落盘的对话可能丢失。确定继续吗?',
      'card.unsupported': '仅支持 Windows',
      'card.loadFailed': '无法读取插件状态',
    }
    const en = {
      'card.title': 'DSH service & boot autostart',
      'card.service': 'Service',
      'card.running': 'Running (port {port})',
      'card.stopped': 'Stopped',
      'card.autostart': 'Boot autostart',
      'card.on': 'Enabled',
      'card.off': 'Disabled',
      'card.foreign': 'A same-named entry owned by something else is present; left untouched',
      'card.url': 'Access URL',
      'card.urlMissing': 'Not captured yet (the service has not started)',
      'card.hook': 'Hook script',
      'card.hookMissing': 'configured, but the file is missing',
      'card.hookNone': 'not configured',
      'card.copy': 'Copy',
      'card.copied': 'Copied',
      'card.enable': 'Enable autostart',
      'card.disable': 'Disable autostart',
      'card.restart': 'Restart service',
      'card.restarting': 'Restarting…',
      'card.confirm': 'Restarting interrupts running tasks; unsaved conversation may be lost. Continue?',
      'card.unsupported': 'Windows only',
      'card.loadFailed': 'Could not read plugin state',
    }

    const NS = 'dsh-autostart'

    /** Format a dictionary entry, substituting {name} placeholders. */
    function format(template, values) {
      return template.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''))
    }

    /**
     * Read a JSON body without trusting a Content-Type header: the host's send()
     * sets none, so decode the text ourselves. An empty or non-JSON body (an
     * error page returned by a proxy, say) becomes null, letting the caller fall
     * back to the HTTP status instead of losing it to a parse failure.
     */
    function readJson(res) {
      return res.text().then((text) => {
        if (text === '') return null
        try {
          return JSON.parse(text)
        } catch {
          return null
        }
      })
    }

    function Card(props) {
      const t = props.t
      const [state, setState] = react.useState(null)
      const [error, setError] = react.useState(null)
      const [busy, setBusy] = react.useState(false)
      const [copied, setCopied] = react.useState(false)

      const load = react.useCallback(() => {
        fetch('/dsh-autostart/state')
          .then(readJson)
          .then((payload) => {
            if (payload === null) {
              setError(t('card.loadFailed'))
              return
            }
            setState(payload)
            setError(null)
          })
          .catch(() => setError(t('card.loadFailed')))
      }, [t])

      react.useEffect(() => {
        load()
      }, [load])

      const post = react.useCallback(
        (url) => {
          setBusy(true)
          return fetch(url, { method: 'POST' })
            .then((res) => readJson(res).then((body) => ({ status: res.status, body })))
            .then(({ status, body }) => {
              setBusy(false)
              if (status >= 400) setError(body?.error ?? `HTTP ${status}`)
              else setError(null)
              load()
              return status < 400
            })
            .catch(() => {
              setBusy(false)
              setError(t('card.loadFailed'))
              return false
            })
        },
        [load, t],
      )

      if (state !== null && state.supported === false) {
        return h('div', { className: 'dsas_card' }, [
          h('div', { className: 'dsas_head', key: 'title' }, t('card.title')),
          h('div', { className: 'dsas_warn', key: 'reason' }, `${t('card.unsupported')} — ${state.reason ?? ''}`),
        ])
      }

      const url = state?.accessUrl ?? null
      const hookText =
        state === undefined || state === null
          ? ''
          : state.hookScript === ''
            ? t('card.hookNone')
            : state.hookExists
              ? state.hookScript
              : `${state.hookScript} — ${t('card.hookMissing')}`

      return h('div', { className: 'dsas_card' }, [
        h('div', { className: 'dsas_head', key: 'title' }, t('card.title')),
        h('div', { className: 'dsas_grid', key: 'status' }, [
          h('div', { className: 'dsas_row', key: 's' }, [
            h('span', { key: 'k' }, `${t('card.service')}: `),
            h(
              'span',
              { key: 'v', className: state?.serviceRunning ? 'dsas_ok' : 'dsas_error' },
              state?.serviceRunning ? format(t('card.running'), { port: state.dshPort }) : t('card.stopped'),
            ),
          ]),
          h('div', { className: 'dsas_row', key: 'a' }, [
            h('span', { key: 'k' }, `${t('card.autostart')}: `),
            h('span', { key: 'v' }, state?.autostartEnabled ? t('card.on') : t('card.off')),
          ]),
          state?.autostartEnabled && state?.registryMatchesOurs === false
            ? h('div', { className: 'dsas_warn', key: 'f' }, t('card.foreign'))
            : null,
          h('div', { className: 'dsas_row', key: 'u' }, [
            h('span', { key: 'k' }, `${t('card.url')}: `),
            url === null
              ? h('span', { key: 'v' }, t('card.urlMissing'))
              : h('span', { className: 'dsas_url', key: 'v' }, url),
            url === null
              ? null
              : h(
                  'button',
                  {
                    key: 'c',
                    type: 'button',
                    className: 'dsas_btn',
                    disabled: busy,
                    onClick: () => {
                      navigator.clipboard?.writeText(url).then(() => {
                        setCopied(true)
                        setTimeout(() => setCopied(false), 2000)
                      })
                    },
                  },
                  copied ? t('card.copied') : t('card.copy'),
                ),
          ]),
          h('div', { className: 'dsas_row', key: 'h' }, [
            h('span', { key: 'k' }, `${t('card.hook')}: `),
            h(
              'span',
              { key: 'v', className: state !== null && state.hookScript !== '' && !state.hookExists ? 'dsas_warn' : '' },
              hookText,
            ),
          ]),
        ]),
        h('div', { className: 'dsas_actions', key: 'actions' }, [
          h(
            'button',
            {
              key: 'toggle',
              type: 'button',
              className: 'dsas_btn',
              disabled: busy,
              onClick: () =>
                post(
                  state?.autostartEnabled
                    ? '/dsh-autostart/autostart/disable'
                    : '/dsh-autostart/autostart/enable',
                ),
            },
            state?.autostartEnabled ? t('card.disable') : t('card.enable'),
          ),
          h(
            'button',
            {
              key: 'restart',
              type: 'button',
              className: 'dsas_btn',
              disabled: busy,
              onClick: () => {
                if (typeof window !== 'undefined' && window.confirm(t('card.confirm')) === false) return
                post('/dsh-autostart/restart')
              },
            },
            busy ? t('card.restarting') : t('card.restart'),
          ),
          error === null ? null : h('span', { key: 'err', className: 'dsas_error' }, error),
        ]),
      ])
    }

    const inject = ['slots', 'locale']

    function apply(ctx) {
      ctx.effect(
        () =>
          ctx.locale.register(NS, {
            zh,
            en,
          }),
        'dsh-autostart: dictionaries',
      )
      ctx.slots.inject('settings.general.item', () =>
        ctx.slots.register(
          {
            name: 'settings.general.item',
            id: 'dsh-autostart',
            order: Number.MAX_SAFE_INTEGER - 1,
            locale: NS,
          },
          Card,
        ),
      )
    }

    const exports = { apply, inject }
    return exports
  },
})
