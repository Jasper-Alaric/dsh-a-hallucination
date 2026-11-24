import test from 'node:test'
import assert from 'node:assert/strict'
import nodeFs from 'node:fs'
import nodeOs from 'node:os'
import nodePath from 'node:path'
import { apply } from '../index.js'

/**
 * Minimal Host stand-in.
 *
 * This is not a real Cordis composition: it reproduces the four surfaces the
 * plugin touches (event listeners, effects, injections, services) so the wiring in
 * `index.js` can be driven end to end. Behaviour against a real Loader boot is
 * still covered by the live in-app checks, not by this file.
 */
function createHost(options = {}) {
  const listeners = new Map()
  const tools = new Map()
  const sections = []
  const provided = new Map()
  const logs = []
  const logger = {
    info: (...args) => logs.push(['info', ...args]),
    warn: (...args) => logs.push(['warn', ...args]),
    error: (...args) => logs.push(['error', ...args]),
    debug: () => {},
  }
  const toolsService = {
    register(definition) {
      tools.set(definition.name, definition)
      return () => tools.delete(definition.name)
    },
    schemas() {
      return [...tools.values()].map(definition => ({ name: definition.name }))
    },
  }
  const promptService = {
    section(section) {
      sections.push(section)
      return () => {}
    },
  }
  const ctx = {
    logger,
    on(event, listener) {
      if (options.failOn === event) throw new Error(`cannot listen to ${event}`)
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {}
    },
    effect(factory) {
      const dispose = factory()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    inject(names, callback) {
      if (options.failInject === true) throw new Error('cannot inject')
      if (names.includes('tools')) ctx.tools = toolsService
      if (names.includes('systemPrompt')) ctx.systemPrompt = promptService
      callback(ctx)
      return () => {}
    },
    provide(key, value) {
      provided.set(key, value)
    },
    get(key) {
      if (key === 'tools') return toolsService
      if (key === 'systemPrompt') return promptService
      return undefined
    },
  }
  return {
    ctx,
    logs,
    sections,
    provided,
    tool: name => tools.get(name),
    listener: event => (listeners.get(event) ?? [])[0],
    async emit(event, ...args) {
      const listener = listeners.get(event)?.[0]
      return listener === undefined ? undefined : await listener(...args)
    },
  }
}

/** Start one plugin instance on a fake host. Persistence is off unless a case asks for it. */
function start(options = {}) {
  const host = createHost(options.hostOptions)
  apply(host.ctx, { persistMode: false, ...(options.plugin || {}) })
  return host
}

/** One successful tool result. */
function result(text) {
  return { isError: false, content: [{ type: 'text', text }] }
}

/** One dispatch that reached a tool. */
function call(name, args = {}, callId = 'call_1') {
  return { name, arguments: args, callId, agent: { id: 's1' } }
}

test('apply registers the contract section and the ledger tool', () => {
  const host = start()
  assert.equal(host.sections.length, 1)
  assert.equal(host.sections[0].name, 'a-hallucination:contract')
  assert.equal(host.sections[0].order, 240)
  const text = host.sections[0].text()
  assert.ok(text.includes('反幻觉契约'))
  assert.notEqual(host.tool('ledger_view'), undefined)
})

test('the provided service reports mode, switches, and an empty degraded list', () => {
  const host = start()
  const service = host.provided.get('aHallucination')
  const status = service.status()
  assert.equal(status.mode, 'inspect')
  assert.equal(status.degraded.length, 0)
  assert.equal(status.switches.paramDeny, false)
  assert.equal(service.setMode('断案'), 'adjudicate')
  assert.equal(service.mode, 'adjudicate')
})

test('a successful dispatch lands in the ledger and the ledger tool reports it', async () => {
  const host = start()
  await host.emit('tools/result', call('read', { path: 'E:/a.txt' }), result('body'))
  const tool = host.tool('ledger_view')
  const status = await tool.execute({ action: 'status' }, call('ledger_view'))
  assert.equal(status.ledger.total, 1)
  const list = await tool.execute({ action: 'list' }, call('ledger_view'))
  assert.equal(list.entries[0].source, 'read')
  assert.equal(list.entries[0].excerpt, 'body')
})

test('the ledger stores the original text, not the injected header', async () => {
  const host = start()
  const exec = call('read', { path: 'E:/a.txt' }, 'call_shield')
  await host.emit('tools/post-execute', exec, result('page body'), async () => ({ kind: 'accept' }))
  await host.emit('tools/result', exec, result('〔外部数据 · untrusted · read〕page body'))
  const list = await host.tool('ledger_view').execute({ action: 'list' }, call('ledger_view'))
  assert.equal(list.entries[0].excerpt, 'page body')
})

test('a refused call cannot whitelist its own target on retry', async () => {
  const host = start({ plugin: { mode: 'adjudicate' } })
  const attempt = () => host.emit('tools/pre-execute', call('read', { path: 'E:/fabricated.txt' }), async () => ({ kind: 'allow' }))

  const first = await attempt()
  assert.equal(first.kind, 'deny')

  // DSH still publishes a result for a denied call; it must not enter the corpus.
  await host.emit('tools/result', call('read', { path: 'E:/fabricated.txt' }), {
    isError: true,
    content: [{ type: 'text', text: 'Error: untraceable parameters: file_path' }],
  })

  const second = await attempt()
  assert.equal(second.kind, 'deny')
})

test('user text captured at pre-step makes a path traceable', async () => {
  const host = start({ plugin: { mode: 'adjudicate' } })
  await host.emit('agent/pre-step', {
    agent: { id: 's1' },
    messages: [{ content: [{ type: 'text', text: '请读取 E:/from-user.txt' }] }],
  }, async () => ({ kind: 'enter', messages: [] }))
  const decision = await host.emit('tools/pre-execute', call('read', { path: 'E:/from-user.txt' }), async () => ({ kind: 'allow' }))
  assert.equal(decision.kind, 'allow')
})

test('pre-step always delegates its decision', async () => {
  const host = start()
  const decision = await host.emit('agent/pre-step', { agent: { id: 's1' }, messages: [] }, async () => ({ kind: 'reject' }))
  assert.equal(decision.kind, 'reject')
})

test('post-execute delegates first and then marks external content', async () => {
  const host = start()
  let delegated = false
  const decision = await host.emit('tools/post-execute', call('read', { path: 'a.txt' }, 'call_p1'), result('page'), async () => {
    delegated = true
    return { kind: 'accept' }
  })
  assert.equal(delegated, true)
  assert.equal(decision.content.length, 2)
  assert.ok(decision.content[0].text.includes('untrusted'))
})

test('post-execute leaves a non-external result and a block decision untouched', async () => {
  const host = start()
  const accepted = { kind: 'accept' }
  assert.equal(await host.emit('tools/post-execute', call('pwsh', { command: 'x' }), result('out'), async () => accepted), accepted)
  const blocked = { kind: 'block', feedback: [{ type: 'text', text: 'no' }] }
  assert.equal(await host.emit('tools/post-execute', call('read', {}), result('x'), async () => blocked), blocked)
})

test('observe mode gates nothing', async () => {
  const host = start({ plugin: { mode: 'observe' } })
  const decision = await host.emit('tools/pre-execute', call('deleteFile', { path: 'E:/nope.txt' }), async () => ({ kind: 'allow' }))
  assert.equal(decision.kind, 'allow')
})

test('session disposal drops the retained state', async () => {
  const host = start()
  await host.emit('tools/result', call('read', { path: 'E:/a.txt' }), result('body'))
  await host.emit('session/disposed', { id: 's1' })
  const status = await host.tool('ledger_view').execute({ action: 'status' }, call('ledger_view'))
  assert.equal(status.ledger.total, 0)
})

test('a failing injection degrades instead of throwing', () => {
  const host = start({ hostOptions: { failInject: true } })
  const status = host.provided.get('aHallucination').status()
  assert.ok(status.degraded.includes('contract'))
  assert.ok(status.degraded.includes('tools'))
  assert.equal(host.tool('ledger_view'), undefined)
})

test('the ledger tool rejects an unknown action and accepts any case', async () => {
  const host = start()
  const tool = host.tool('ledger_view')
  await assert.rejects(async () => tool.execute({ action: 'nonsense' }, call('ledger_view')))
  const status = await tool.execute({ action: 'STATUS' }, call('ledger_view'))
  assert.equal(status.action, 'status')
})

test('observations expose the params that had no origin', async () => {
  const host = start()
  await host.emit('tools/pre-execute', call('read', { path: 'E:/never-seen.txt' }), async () => ({ kind: 'allow' }))
  const listed = await host.tool('ledger_view').execute({ action: 'observations' }, call('ledger_view'))
  assert.equal(listed.total, 1)
  assert.deepEqual(listed.items[0].params, ['path'])
})

test('the assistant stream feeds the turn-end verifier', async () => {
  const host = start()
  const stream = (frame) => host.emit('agent/assistant-stream', { agent: { id: 's1' }, frame })
  await stream({ type: 'start', turn: 3 })
  await stream({ type: 'chunk', chunk: { type: 'text-delta', text: '已执行清理。' } })
  await host.emit('tools/result', call('pwsh', { command: 'Write-Output ok' }), result('ok'))
  await host.emit('agent/turn-stopping', { agent: { id: 's1' }, turn: 3 })
  const verdict = await host.tool('ledger_view').execute({ action: 'verdict' }, call('ledger_view'))
  assert.equal(verdict.verdict.turn, 3)
  assert.equal(verdict.verdict.passed, true)
  assert.equal(verdict.verdict.answerChars > 0, true)
})

test('a completion with no successful call fails turn-end verification', async () => {
  const host = start()
  const stream = (frame) => host.emit('agent/assistant-stream', { agent: { id: 's1' }, frame })
  await stream({ type: 'start', turn: 1 })
  await stream({ type: 'chunk', chunk: { type: 'text-delta', text: '版本已发布。' } })
  await host.emit('agent/turn-stopping', { agent: { id: 's1' }, turn: 1 })
  const verdict = await host.tool('ledger_view').execute({ action: 'verdict' }, call('ledger_view'))
  assert.equal(verdict.verdict.passed, false)
  assert.ok(verdict.verdict.failedCodes.includes('V5'))
})

test('turn-end verification is off in observe mode', async () => {
  const host = start({ plugin: { mode: 'observe' } })
  await host.emit('agent/turn-stopping', { agent: { id: 's1' }, turn: 1 })
  const verdict = await host.tool('ledger_view').execute({ action: 'verdict' }, call('ledger_view'))
  assert.equal(verdict.verdict, null)
})

test('the chosen mode survives a restart when persistence is enabled', async () => {
  const dir = nodePath.join(nodeOs.tmpdir(), `a-hallucination-wiring-${Date.now()}`)
  try {
    const first = start({ plugin: { persistMode: true, stateDir: dir } })
    first.provided.get('aHallucination').setMode('adjudicate')
    assert.equal(first.provided.get('aHallucination').mode, 'adjudicate')

    const second = start({ plugin: { persistMode: true, stateDir: dir } })
    assert.equal(second.provided.get('aHallucination').mode, 'adjudicate')
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true })
  }
})

test('without persistence the mode resets to the configured default', () => {
  const first = start()
  first.provided.get('aHallucination').setMode('adjudicate')
  const second = start()
  assert.equal(second.provided.get('aHallucination').mode, 'inspect')
})

test('answer_verify passes an answer whose claim quotes the ledger', async () => {
  const host = start()
  await host.emit('tools/result', call('read', { path: 'E:/a.txt' }), result('ServerTime=08:00:12'))
  const tool = host.tool('answer_verify')
  const value = await tool.execute({
    answer: '服务器时间为 08:00:12。',
    claims: [{ claim: '服务器时间为 08:00:12', status: 'verified', evidence_id: 'E1', quote: '08:00:12' }],
    facts: ['服务器时间为 08:00:12'],
  }, call('answer_verify'))
  assert.equal(value.passed, true)
  assert.equal(value.quoted, 1)
})

test('answer_verify fails a citation that does not exist', async () => {
  const host = start()
  await host.emit('tools/result', call('read', { path: 'E:/a.txt' }), result('body'))
  const value = await host.tool('answer_verify').execute({
    answer: '结论。',
    claims: [{ claim: '结论', status: 'verified', evidence_id: 'E9' }],
  }, call('answer_verify'))
  assert.equal(value.passed, false)
  assert.ok(value.failedCodes.includes('V2'))
})

test('answer_verify fails a quote that is not in the cited result', async () => {
  const host = start()
  await host.emit('tools/result', call('read', { path: 'E:/a.txt' }), result('ServerTime=08:00:12'))
  const value = await host.tool('answer_verify').execute({
    answer: '营收 620 亿。',
    claims: [{ claim: '营收 620 亿', status: 'verified', evidence_id: 'E1', quote: '营收 620 亿' }],
  }, call('answer_verify'))
  assert.equal(value.passed, false)
  assert.ok(value.failedCodes.includes('V3'))
})

test('answer_verify fails a fact with no covering claim', async () => {
  const host = start()
  await host.emit('tools/result', call('read', { path: 'E:/a.txt' }), result('body'))
  const value = await host.tool('answer_verify').execute({
    answer: '两个说法。',
    claims: [{ claim: '第一个说法', status: 'unknown' }],
    facts: ['第一个说法', '第二个说法完全没有被覆盖'],
  }, call('answer_verify'))
  assert.ok(value.failedCodes.includes('V1'))
})

test('answer_verify reports how many claims carried a quote', async () => {
  const host = start()
  await host.emit('tools/result', call('read', { path: 'E:/a.txt' }), result('body'))
  const value = await host.tool('answer_verify').execute({
    answer: '结论。',
    claims: [
      { claim: '结论', status: 'unknown' },
      { claim: '另一条', status: 'inferred' },
    ],
  }, call('answer_verify'))
  assert.equal(value.quoted, 0)
  assert.equal(value.unquoted, 2)
})
