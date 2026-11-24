/**
 * A-Hallucination Web settings page.
 *
 * Plain language first: the panel says what the plugin does, what it recorded,
 * and how to change the strictness. Technical identifiers live behind a
 * collapsible section so the page is readable without knowing the internals.
 */

window.__ModuleLoader__.load({
  id: '@jasper_alaric/dsh-a-hallucination',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const API_BASE = '/a-hallucination'

    /** Whether the page should speak Chinese. */
    function zh() {
      const doc = typeof document === 'undefined' ? undefined : document.documentElement
      const lang = doc && doc.lang ? String(doc.lang) : String(navigator.language || '')
      return lang.toLowerCase().startsWith('zh')
    }

    /** Bilingual label. */
    function pick(en, cn) {
      return zh() ? cn : en
    }

    /** Same-origin JSON request. GET never reuses a cached body. */
    async function api(path, body) {
      const options = body === undefined
        ? { method: 'GET', headers: { accept: 'application/json' }, cache: 'no-store' }
        : {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body),
          cache: 'no-store',
        }
      // A unique query keeps any intermediate cache from replaying an old body.
      const url = body === undefined ? `${API_BASE}${path}?t=${Date.now()}` : `${API_BASE}${path}`
      const response = await fetch(url, options)
      const text = await response.text()
      let value = {}
      if (text.length > 0) {
        try {
          value = JSON.parse(text)
        } catch {
          throw new Error(`${path}: invalid JSON response`)
        }
      }
      if (!response.ok) throw new Error(`${path}: ${value.error || response.status}`)
      return value
    }

    const styles = {
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
        padding: '18px',
        borderRadius: '12px',
        border: '1px solid rgba(127,127,127,0.25)',
        color: 'inherit',
      },
      header: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '12px' },
      title: { margin: 0, fontSize: '1rem', fontWeight: 600 },
      hint: { margin: 0, fontSize: '0.8125rem', opacity: 0.75, lineHeight: 1.6 },
      sectionLabel: { margin: 0, fontSize: '0.75rem', letterSpacing: '0.04em', opacity: 0.55 },
      modes: { display: 'flex', flexWrap: 'wrap', gap: '8px' },
      rows: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '8px 16px', fontSize: '0.875rem' },
      key: { opacity: 0.75 },
      value: { fontWeight: 600 },
      foot: { display: 'flex', alignItems: 'center', gap: '10px' },
      button: {
        padding: '5px 12px',
        borderRadius: '8px',
        border: '1px solid rgba(127,127,127,0.35)',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        cursor: 'pointer',
      },
      error: { margin: 0, color: '#c0392b', fontSize: '0.8125rem' },
      details: { fontSize: '0.75rem', opacity: 0.8 },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace' },
    }

    /** Mode button style. */
    function modeStyle(active) {
      return {
        padding: '6px 14px',
        borderRadius: '999px',
        border: `1px solid ${active ? 'currentColor' : 'rgba(127,127,127,0.35)'}`,
        background: active ? 'rgba(127,127,127,0.18)' : 'transparent',
        color: 'inherit',
        font: 'inherit',
        cursor: 'pointer',
        opacity: active ? 1 : 0.85,
      }
    }

    /** One label/value row. */
    function Row(props) {
      return h(React.Fragment, null,
        h('div', { style: styles.key }, props.label),
        h('div', { style: props.mono ? { ...styles.value, ...styles.mono } : styles.value }, props.value))
    }

    /** The settings page. */
    function Panel() {
      const [state, setState] = React.useState(null)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      // Shown next to the title: if the panel is alive this clock moves every few
      // seconds even when every counter happens to hold still.
      const [updatedAt, setUpdatedAt] = React.useState('')

      const load = React.useCallback(async () => {
        try {
          setState(await api('/state'))
          setUpdatedAt(new Date().toLocaleTimeString())
          setError('')
        } catch (cause) {
          setError(String(cause && cause.message ? cause.message : cause))
        }
      }, [])

      React.useEffect(() => {
        void load()
        // Keep the counters honest while the panel is open; skip when the tab is
        // hidden so a background tab costs nothing.
        const id = setInterval(() => {
          if (document.visibilityState === 'visible') void load()
        }, 5000)
        return () => clearInterval(id)
      }, [load])

      const change = React.useCallback(async (mode) => {
        setBusy(true)
        try {
          await api('/mode', { mode })
          // Re-read through the same path the timer uses, so the timestamp and
          // every rendered field stay in one place.
          await load()
          setError('')
        } catch (cause) {
          setError(String(cause && cause.message ? cause.message : cause))
        } finally {
          setBusy(false)
        }
      }, [])

      const header = h('div', { style: styles.header },
        h('div', null,
          h('h3', { style: styles.title }, pick('A-Hallucination · anti-fabrication', 'A-Hallucination · 反幻觉助手')),
          h('p', { style: styles.hint }, updatedAt.length === 0 ? '' : pick(`updated ${updatedAt}`, `更新于 ${updatedAt}`))),
        h('button', {
          style: styles.button,
          disabled: busy,
          onClick: () => { void load() },
        }, pick('Refresh', '刷新')))

      const intro = h('p', { style: styles.hint },
        pick(
          'It does three things: remembers what the assistant actually looked up, asks you before anything risky, and treats text from web pages and files as material rather than as instructions.',
          '它只做三件事：记下 AI 真的查过什么、危险的操作先问你、把网页和文件里的文字当资料而不是命令。',
        ))

      let body
      if (state === null) {
        body = h('p', { style: styles.hint }, pick('Loading…', '加载中…'))
      } else {
        const modes = state.modes || []
        const active = modes.filter(mode => mode.active)[0]
        const degraded = state.technical && state.technical.degraded ? state.technical.degraded : []
        const metrics = state.metrics || null
        // Plain language: how often an answer was checked, how many held up, and
        // what share of claims could point at a quote. Never invent a rate.
        const metricsRow = (value) => {
          if (!value || !value.checks) return pick('none yet', '还没有')
          const quoted = value.quoteRate === null || value.quoteRate === undefined ? pick('n/a', '无') : `${value.quoteRate}%`
          return pick(
            `${value.checks} (passed ${value.pass}, needed fixes ${value.fail}, quotes ${quoted})`,
            `${value.checks} 次（通过 ${value.pass}、需补证 ${value.fail}、带原文 ${quoted}）`,
          )
        }
        const blocked = state.blocked || { ask: 0, deny: 0 }
        body = h(React.Fragment, null,
          h('p', { style: styles.sectionLabel }, pick('HOW STRICT', '管到什么程度')),
          h('div', { style: styles.modes },
            modes.map(mode => h('button', {
              key: mode.id,
              style: modeStyle(mode.active),
              disabled: busy,
              onClick: () => { void change(mode.id) },
            }, mode.label))),
          h('p', { style: styles.hint }, active ? active.hint : ''),
          h('p', { style: styles.sectionLabel }, pick('WHAT IT HAS DONE', '它已经做了什么')),
          h('div', { style: styles.rows },
            h(Row, {
              label: pick('Tool calls recorded', '记下的工具调用'),
              value: pick(`${(state.ledger || {}).entries || 0}`, `${(state.ledger || {}).entries || 0} 次`),
            }),
            h(Row, {
              label: pick('Parameters with no visible origin', '找不到出处的参数'),
              value: pick(`${state.observations}`, `${state.observations} 个`),
            }),
            h(Row, {
              label: pick('Risky actions held for you', '先问你、暂时没放行的操作'),
              value: pick(`${blocked.ask + blocked.deny}`, `${blocked.ask + blocked.deny} 次`),
            }),
            h(Row, {
              label: pick('Answers checked before sending', '发出去前核对过的回答'),
              value: metricsRow(metrics),
            }),
            h(Row, {
              label: pick('Parts not working', '没生效的功能'),
              value: degraded.length === 0 ? pick('none', '无') : degraded.join(', '),
            })),
          h('details', { style: styles.details },
            h('summary', { style: { cursor: 'pointer' } }, pick('Technical details', '技术细节')),
            h('div', { style: { ...styles.rows, marginTop: '8px' } },
              h(Row, {
                label: pick('Rule text', '规则文本'),
                value: pick(
                  `${state.technical.contractChars} chars · ${state.technical.contractSha1}`,
                  `${state.technical.contractChars} 字 · ${state.technical.contractSha1}`,
                ),
                mono: true,
              }),
              h(Row, {
                label: pick('Applied to the prompt', '已写进提示词'),
                value: state.technical.injected ? pick('yes', '是') : pick('no', '否'),
              }),
              h(Row, {
                label: pick('Active switches', '生效开关'),
                value: Object.keys(state.switches || {}).filter(key => state.switches[key] === true).join(', ') || pick('none', '无'),
                mono: true,
              }))))
      }

      return h('section', { style: styles.card, 'aria-label': 'A-Hallucination' },
        header,
        intro,
        body,
        error.length > 0 ? h('p', { style: styles.error }, error) : null)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'a-hallucination',
          order: 26,
          label: () => pick('A-Hallucination', 'A-Hallucination'),
        }, Panel))
      },
    }
  },
})
