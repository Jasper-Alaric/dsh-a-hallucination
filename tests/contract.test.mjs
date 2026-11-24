import test from 'node:test'
import assert from 'node:assert/strict'
import { buildContract, contractDigest } from '../lib/contract.js'
import { DEFAULT_MODE, MODE_IDS, resolveMode, resolveSettings, switchesOf } from '../lib/modes.js'

/** A state object shaped like the plugin's runtime state. */
function state(mode, settings = {}) {
  const resolved = resolveSettings({ mode, ...settings })
  return { mode: resolved.mode, settings: resolved }
}

test('the default mode is 明察 and enables its switches', () => {
  assert.equal(DEFAULT_MODE, 'inspect')
  assert.equal(resolveSettings({}).mode, 'inspect')
  const switches = switchesOf('inspect')
  assert.equal(switches.paramGate, true)
  assert.equal(switches.highRiskGate, true)
  assert.equal(switches.paramDeny, false)
})

test('only 断案 refuses an untraceable target outright', () => {
  assert.equal(switchesOf('observe').paramDeny, false)
  assert.equal(switchesOf('inspect').paramDeny, false)
  assert.equal(switchesOf('adjudicate').paramDeny, true)
})

test('every declared switch has a runtime consumer', () => {
  const declared = Object.keys(switchesOf('inspect'))
  assert.deepEqual(declared.sort(), ['contract', 'highRiskGate', 'ledger', 'paramDeny', 'paramGate', 'turnVerify', 'untrustedMark'])
})

test('resolveMode accepts ids, labels, and rejects unknown input', () => {
  assert.equal(resolveMode('observe'), 'observe')
  assert.equal(resolveMode('明察'), 'inspect')
  assert.equal(resolveMode('adjudicate'), 'adjudicate')
  assert.equal(resolveMode('断案'), 'adjudicate')
  assert.equal(resolveMode('nonsense'), DEFAULT_MODE)
  assert.equal(resolveMode(undefined), DEFAULT_MODE)
})

test('maxRewrite and maxRetry are clamped into their documented ranges', () => {
  assert.equal(resolveSettings({}).maxRewrite, 2)
  assert.equal(resolveSettings({ maxRewrite: 99 }).maxRewrite, 5)
  assert.equal(resolveSettings({ maxRewrite: -3 }).maxRewrite, 0)
  assert.equal(resolveSettings({ maxRetry: 0 }).maxRetry, 1)
})

test('each mode renders a distinct contract with the mode named', () => {
  const digests = new Set()
  for (const id of MODE_IDS) {
    const text = buildContract(state(id), undefined)
    assert.ok(text.includes('反幻觉契约'), `missing title for ${id}`)
    assert.ok(text.length > 400, `contract too short for ${id}`)
    digests.add(contractDigest(text))
  }
  assert.equal(digests.size, MODE_IDS.length)
})

test('the adjudicate contract states refusal of an untraceable target', () => {
  const text = buildContract(state('adjudicate'), undefined)
  assert.ok(text.includes('直接拒绝'))
})

test('the contract states only behaviour that is actually wired', () => {
  const forbidden = ['轮末校验', '打回重写', 'rewrite', 'turn-end invariant']
  for (const id of MODE_IDS) {
    const text = buildContract(state(id), undefined)
    for (const promise of forbidden) {
      assert.equal(text.includes(promise), false, `${id} promises "${promise}" before it exists`)
    }
  }
})

test('workflow checks do not leak unimplemented promises into the observe profile', () => {
  const text = buildContract(state('observe'), undefined)
  assert.ok(text.includes('不拦截'))
})

test('the contract renders in English on request', () => {
  const text = buildContract(state('inspect', { promptLocale: 'en' }), undefined)
  assert.ok(text.startsWith('# Anti-hallucination contract'))
  assert.ok(text.includes('Inspect'))
})

test('the digest is stable for identical input', () => {
  const first = contractDigest(buildContract(state('inspect'), undefined))
  const second = contractDigest(buildContract(state('inspect'), undefined))
  assert.equal(first, second)
})
