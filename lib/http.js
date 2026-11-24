/**
 * Same-origin HTTP surface for the Web settings page.
 *
 * The browser peer is admitted through the same `connection.requestRejection`
 * fence that protects the GUI shell, so the route only answers the authenticated
 * page. Every operation is either a read or an explicit mode change; nothing here
 * can edit the ledger or the evidence.
 */

/** Route paths owned by this plugin. */
export const API = Object.freeze({
  state: '/a-hallucination/state',
  mode: '/a-hallucination/mode',
})

/** Send one JSON response with no-store caching. */
function sendJson(res, status, value) {
  if (res.headersSent) return
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(body)),
  })
  res.end(body)
}

/** Send an empty method/status response. */
function sendEmpty(res, status, headers = {}) {
  if (res.headersSent) return
  res.writeHead(status, { 'cache-control': 'no-store', ...headers })
  res.end()
}

/** Read a bounded JSON request body. */
async function readJsonBody(req, maxBytes = 64 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > maxBytes) throw Object.assign(new Error('request body too large'), { code: 'BODY_TOO_LARGE' })
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim().length === 0) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw Object.assign(new Error('request body must be valid JSON'), { code: 'BAD_JSON' })
  }
}

/** The snapshot the settings page renders. */
function snapshot(service, state) {
  const status = service.status()
  const english = state.settings.promptLocale === 'en'
  const hint = {
    observe: english ? 'only records, never interrupts' : '只记录，不打扰',
    inspect: english ? 'asks before a risky action' : '危险操作先问你',
    adjudicate: english ? 'refuses a target it cannot trace' : '来源不明的参数直接拒绝',
  }
  const label = {
    observe: english ? 'Observe' : '静观',
    inspect: english ? 'Inspect' : '明察',
    adjudicate: english ? 'Adjudicate' : '断案',
  }
  return {
    mode: status.mode,
    modeLabel: status.modeLabel,
    switches: status.switches,
    blocked: {
      ask: state.counters === undefined ? 0 : state.counters.ask,
      deny: state.counters === undefined ? 0 : state.counters.deny,
    },
    technical: {
      contractChars: status.contractChars,
      contractSha1: status.contractSha1,
      injected: status.contractEnabled === true && !status.degraded.includes('contract'),
      degraded: status.degraded,
    },
    ledger: { entries: status.ledgerEntries },
    observations: status.observations,
    warnings: status.warnings,
    modes: ['observe', 'inspect', 'adjudicate'].map(id => ({
      id,
      label: label[id],
      hint: hint[id],
      active: status.mode === id,
    })),
  }
}

/**
 * Register the settings routes when a Web server is present.
 *
 * @param ctx - plugin context.
 * @param service - the plugin service (`status`, `setMode`).
 * @param state - plugin state, used for the configured language.
 */
export function registerHttp(ctx, service, state) {
  const logger = ctx.logger
  const warn = (...args) => {
    try {
      if (logger !== null && typeof logger === 'object' && typeof logger.warn === 'function') logger.warn(...args)
    } catch (error) {
      void error
    }
  }
  if (typeof ctx.inject !== 'function') return
  try {
    ctx.inject(['webServer'], (webCtx) => {
      const web = webCtx.webServer
      if (web === undefined || typeof web.register !== 'function') {
        warn('webServer is unavailable; the settings API was not registered')
        return
      }
      const handler = (req, res) => {
        void handleRequest(ctx, service, state, req, res).catch((error) => {
          warn(`settings route failed: ${String(error)}`)
          if (res.headersSent) res.destroy()
          else sendJson(res, 500, { error: 'internal error' })
        })
      }
      try {
        webCtx.effect(function* registerRoutes() {
          yield web.register({ kind: 'exact', path: API.state, handler })
          yield web.register({ kind: 'exact', path: API.mode, handler })
        }, 'a-hallucination settings routes')
      } catch (error) {
        warn(`could not register the settings routes: ${String(error)}`)
      }
    })
  } catch (error) {
    warn(`could not inject the web server: ${String(error)}`)
  }
}

/** Dispatch one admitted request. */
async function handleRequest(ctx, service, state, req, res) {
  const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
  if (connection === undefined || connection === null || typeof connection.requestRejection !== 'function') {
    sendJson(res, 503, { error: 'the browser connection service is unavailable' })
    return
  }
  const rejection = connection.requestRejection(req)
  if (rejection !== undefined) {
    sendEmpty(res, rejection)
    return
  }

  const path = String(req.url === undefined ? '' : req.url).split('?')[0]

  if (path === API.state) {
    if (req.method !== 'GET') {
      sendEmpty(res, 405, { allow: 'GET' })
      return
    }
    sendJson(res, 200, snapshot(service, state))
    return
  }

  if (path === API.mode) {
    if (req.method !== 'POST') {
      sendEmpty(res, 405, { allow: 'POST' })
      return
    }
    const contentType = req.headers['content-type']
    if (typeof contentType !== 'string' || !contentType.toLowerCase().includes('application/json')) {
      sendJson(res, 415, { error: 'Content-Type must be application/json' })
      return
    }
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      sendJson(res, error.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: 'invalid request body' })
      return
    }
    if (body === null || typeof body !== 'object' || typeof body.mode !== 'string') {
      sendJson(res, 400, { error: 'mode must be a string' })
      return
    }
    const next = service.setMode(body.mode)
    sendJson(res, 200, { ...snapshot(service, state), changed: next })
    return
  }

  sendJson(res, 404, { error: 'unknown route' })
}
