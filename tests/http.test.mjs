import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'
import { API } from '../lib/http.js'

/**
 * Minimal Host stand-in with the two HTTP surfaces the plugin touches: the
 * `webServer` registry and the `connection` admission fence. Unlike a live GUI,
 * this drives the captured handler directly, so a route result is checked
 * without a browser.
 */
function createWebHost() {
  const routes = new Map()
  const tools = new Map()
  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
  const toolsService = {
    register(definition) {
      tools.set(definition.name, definition)
      return () => tools.delete(definition.name)
    },
    schemas() {
      return [...tools.values()].map(definition => ({ name: definition.name }))
    },
  }
  const promptService = { section: () => () => {} }
  const webServer = {
    register(route) {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  }
  const ctx = {
    logger,
    on: () => () => {},
    effect(factory) {
      const result = factory()
      // The HTTP registration effect is a generator that yields each disposer.
      if (result !== null && typeof result === 'object' && typeof result.next === 'function') {
        for (const step of result) void step
      }
      return () => {
        if (typeof result === 'function') result()
      }
    },
    inject(names, callback) {
      if (names.includes('tools')) ctx.tools = toolsService
      if (names.includes('systemPrompt')) ctx.systemPrompt = promptService
      if (names.includes('webServer')) ctx.webServer = webServer
      callback(ctx)
      return () => {}
    },
    provide: () => {},
    get(key) {
      if (key === 'tools') return toolsService
      if (key === 'systemPrompt') return promptService
      if (key === 'connection') return { requestRejection: () => undefined }
      return undefined
    },
  }
  return {
    ctx,
    tool: name => tools.get(name),
    async get(path) {
      return dispatch(routes.get(path), request('GET', path))
    },
    async post(path, value) {
      return dispatch(routes.get(path), request('POST', path, { 'content-type': 'application/json' }, value))
    },
  }
}

/** One inbound request whose body is a single JSON chunk. */
function request(method, url, headers = {}, body = undefined) {
  return {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body))
    },
  }
}

/** One outbound response that records what the handler wrote. */
function response() {
  return {
    headersSent: false,
    statusCode: 0,
    headers: {},
    body: '',
    ended: false,
    destroyed: false,
    writeHead(status, headers = {}) {
      this.statusCode = status
      this.headers = headers
    },
    end(body) {
      if (body !== undefined) this.body += String(body)
      this.ended = true
    },
    destroy() {
      this.destroyed = true
    },
  }
}

/** Run the captured handler and wait for its asynchronous response. */
async function dispatch(handler, req) {
  assert.equal(typeof handler, 'function', `no handler for ${req.url}`)
  const res = response()
  handler(req, res)
  for (let attempt = 0; attempt < 100 && !res.ended && !res.destroyed; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve))
  }
  return {
    status: res.statusCode,
    headers: res.headers,
    value: res.body.length > 0 ? JSON.parse(res.body) : undefined,
  }
}

test('the settings state reports metrics before and after an answer check', async () => {
  const host = createWebHost()
  apply(host.ctx, { persistMode: false })

  const before = await host.get(API.state)
  assert.equal(before.status, 200)
  assert.notEqual(before.value.metrics, null)
  assert.equal(before.value.metrics.checks, 0)

  const checked = await host.tool('answer_verify').execute({ answer: 'ok', claims: [] }, { agent: { id: 's1' } })
  assert.equal(checked.verdict, 'partial')

  const after = await host.get(API.state)
  assert.equal(after.status, 200)
  assert.notEqual(after.value.metrics, null)
  assert.ok(after.value.metrics.checks >= 1)
})

test('POST /mode rejects an unknown mode and keeps the active one', async () => {
  const host = createWebHost()
  apply(host.ctx, { persistMode: false })

  const rejected = await host.post(API.mode, { mode: 'adjudicat' })
  assert.equal(rejected.status, 400)
  assert.ok(rejected.value.error.includes('unknown mode'))

  const unchanged = await host.get(API.state)
  assert.equal(unchanged.value.mode, 'inspect')

  const accepted = await host.post(API.mode, { mode: 'adjudicate' })
  assert.equal(accepted.status, 200)
  assert.equal(accepted.value.changed, 'adjudicate')
  assert.equal(accepted.value.mode, 'adjudicate')
})
