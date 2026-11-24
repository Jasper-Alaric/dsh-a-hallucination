import test from 'node:test'
import assert from 'node:assert/strict'
import * as plugin from '../index.js'

/**
 * Composition tests on the real Cordis runtime (the vendored build the Host runs),
 * with only the neighbouring services stubbed. Unlike `wiring.test.mjs`, the
 * waterfall, injection, and disposal machinery here is the real one.
 *
 * The checkout path is absolute because the vendored Cordis is not installed in
 * this package's `node_modules`; on a machine without that checkout these cases
 * are skipped rather than failed.
 */

const CHECKOUT = 'file:///E:/Deepseek%20Harness/deepseek-harness-master/deepseek-harness-master/vendor/cordis/lib/index.js'

let Context
try {
  const cordis = await import(CHECKOUT)
  Context = cordis.Context
} catch {
  Context = undefined
}

/** A test that skips when the vendored runtime is unavailable. */
const cordisTest = (name, fn) => test(name, Context === undefined ? { skip: 'vendored Cordis not found' } : {}, fn)

/** Build one composed app with stubbed tools and systemPrompt services. */
function compose(config = {}) {
  const app = new Context()
  const tools = new Map()
  const sections = []
  app.provide('tools', {
    register(definition) {
      tools.set(definition.name, definition)
      return () => tools.delete(definition.name)
    },
    schemas: () => [...tools.values()].map(definition => ({ name: definition.name })),
  })
  app.provide('systemPrompt', {
    section(section) {
      sections.push(section)
      return () => {}
    },
  })
  app.plugin(plugin, { persistMode: false, ...config })
  return { app, tools, sections }
}

/** Let Cordis settle its plugin fibers. */
const settle = () => new Promise(resolve => setTimeout(resolve, 30))

cordisTest('the plugin composes on the real Cordis runtime', async () => {
  const { app, sections } = compose()
  await settle()
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'a-hallucination:contract')
  assert.ok(sections[0].text().includes('反幻觉契约'))
  assert.equal(app.get('aHallucination').status().mode, 'inspect')
  await app.fiber.dispose()
})

cordisTest('a destructive call resolves to ask through the real waterfall', async () => {
  const { app } = compose()
  await settle()
  const decision = await app.waterfall(app, 'tools/pre-execute', {
    name: 'deleteFile',
    arguments: { path: 'a.txt' },
    agent: { id: 's1' },
  }, async () => ({ kind: 'allow' }))
  assert.equal(decision.kind, 'ask')
  assert.ok(decision.displayReason.zh.includes('高风险'))
  await app.fiber.dispose()
})

cordisTest('a command-level destructive action is caught on the real waterfall', async () => {
  const { app } = compose()
  await settle()
  const decision = await app.waterfall(app, 'tools/pre-execute', {
    name: 'pwsh',
    arguments: { command: 'Remove-Item -Recurse C:/data' },
    agent: { id: 's1' },
  }, async () => ({ kind: 'allow' }))
  assert.equal(decision.kind, 'ask')
  await app.fiber.dispose()
})

cordisTest('an ordinary call falls through to the next listener', async () => {
  const { app } = compose()
  await settle()
  const decision = await app.waterfall(app, 'tools/pre-execute', {
    name: 'read',
    arguments: { path: 'E:/never-seen.txt' },
    agent: { id: 's1' },
  }, async () => ({ kind: 'allow' }))
  assert.equal(decision.kind, 'allow')
  await app.fiber.dispose()
})

cordisTest('adjudicate denies through the real waterfall and keeps denying', async () => {
  const { app } = compose({ mode: 'adjudicate' })
  await settle()
  const exec = { name: 'read', arguments: { path: 'E:/fabricated.txt' }, callId: 'call_1', agent: { id: 's1' } }
  const allow = async () => ({ kind: 'allow' })
  assert.equal((await app.waterfall(app, 'tools/pre-execute', exec, allow)).kind, 'deny')
  await app.emit('tools/result', exec, { isError: true, content: [{ type: 'text', text: 'Error: denied' }] })
  assert.equal((await app.waterfall(app, 'tools/pre-execute', exec, allow)).kind, 'deny')
  await app.fiber.dispose()
})

cordisTest('external content is marked after the next listener runs', async () => {
  const { app } = compose()
  await settle()
  let delegated = false
  const decision = await app.waterfall(app, 'tools/post-execute', {
    name: 'read',
    arguments: { path: 'a.txt' },
    callId: 'call_2',
  }, { isError: false, content: [{ type: 'text', text: 'page' }] }, async () => {
    delegated = true
    return { kind: 'accept' }
  })
  assert.equal(delegated, true)
  assert.ok(decision.content[0].text.includes('untrusted'))
  assert.equal(decision.content[1].text, 'page')
  await app.fiber.dispose()
})

cordisTest('a real dispatch lands in the ledger and the tool reads it back', async () => {
  const { app, tools } = compose()
  await settle()
  await app.emit('tools/result', {
    name: 'pwsh',
    arguments: { command: 'Get-Date' },
    callId: 'call_3',
    agent: { id: 's1' },
  }, { isError: false, content: [{ type: 'text', text: '2026-11-24' }] })
  const ledgerView = tools.get('ledger_view')
  const status = await ledgerView.execute({ action: 'status' }, { agent: { id: 's1' } })
  assert.equal(status.ledger.total, 1)
  await app.fiber.dispose()
})

cordisTest('disposal removes the registrations', async () => {
  const { app, tools } = compose()
  await settle()
  assert.equal(tools.size, 2)
  assert.ok(tools.has('ledger_view'))
  assert.ok(tools.has('answer_verify'))
  await app.fiber.dispose()
  assert.equal(app.get('aHallucination'), undefined)
})
