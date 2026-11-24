import test from 'node:test'
import assert from 'node:assert/strict'
import { createLedger, createLedgerRegistry, MAX_EXCERPT } from '../lib/ledger.js'

/** Build one dispatch observation. */
function observation(overrides = {}) {
  return {
    name: 'read',
    callId: 'call-abcdef123',
    args: { path: 'E:/tmp/a.txt' },
    contentText: 'line one\nline two',
    isError: false,
    turn: 3,
    step: 2,
    ...overrides,
  }
}

test('records a successful call with a stable id and locator', () => {
  const ledger = createLedger()
  const entry = ledger.record(observation())
  assert.equal(entry.id, 'E1')
  assert.equal(entry.status, 'success')
  assert.equal(entry.source, 'read')
  assert.equal(entry.locator, 'E:/tmp/a.txt')
  assert.equal(entry.verbatim, true)
  assert.equal(entry.granularity, 'full')
  assert.equal(ledger.record(observation()).id, 'E2')
})

test('falls back to the call id when the arguments carry no locator', () => {
  const ledger = createLedger()
  const entry = ledger.record(observation({ name: 'ps', args: {}, callId: 'abcdef123456' }))
  assert.equal(entry.locator, 'ps#abcdef12')
  assert.equal(entry.call_id, 'abcdef123456')
})

test('distinguishes error and empty results from success', () => {
  const ledger = createLedger()
  assert.equal(ledger.record(observation({ isError: true })).status, 'error')
  assert.equal(ledger.record(observation({ contentText: '   ' })).status, 'empty')
  assert.deepEqual(ledger.summary().byStatus, { success: 0, error: 1, empty: 1 })
})

test('an empty result has no verbatim evidence', () => {
  const ledger = createLedger()
  const entry = ledger.record(observation({ contentText: '' }))
  assert.equal(entry.verbatim, false)
  assert.equal(ledger.verifies(entry), false)
})

test('a long result degrades to a verbatim excerpt that still verifies', () => {
  const ledger = createLedger({ maxContent: 50 })
  const entry = ledger.record(observation({ contentText: 'x'.repeat(500) }))
  assert.equal(entry.granularity, 'excerpt')
  assert.equal(entry.excerpt.length, Math.min(MAX_EXCERPT, 50))
  assert.equal(ledger.verifies(entry), true)
})

test('keeps the newest entries once the cap is reached', () => {
  const ledger = createLedger({ maxEntries: 3 })
  for (let index = 0; index < 5; index += 1) ledger.record(observation({ contentText: `result ${index}` }))
  const entries = ledger.list()
  assert.equal(entries.length, 3)
  assert.equal(entries[2].excerpt, 'result 4')
  assert.equal(entries[0].id, 'E3')
})

test('a record without a tool name is rejected instead of inventing one', () => {
  const ledger = createLedger()
  assert.equal(ledger.record(observation({ name: '' })), undefined)
  assert.equal(ledger.count(), 0)
})

test('registry isolates sessions and drops them on demand', () => {
  const registry = createLedgerRegistry()
  registry.get('s1').record(observation())
  registry.get('s2').record(observation())
  assert.equal(registry.get('s1').count(), 1)
  assert.equal(registry.total(), 2)
  registry.drop('s1')
  assert.equal(registry.get('s1').count(), 0)
  assert.equal(registry.total(), 1)
})

// --- completion signal and full evidence text (H1, M2) ----------------------

test('a silent success is ok even though its status is empty', () => {
  const ledger = createLedger()
  const silent = ledger.record(observation({ name: 'pwsh', contentText: '   ' }))
  assert.equal(silent.status, 'empty')
  assert.equal(silent.ok, true)
  const failed = ledger.record(observation({ isError: true }))
  assert.equal(failed.status, 'error')
  assert.equal(failed.ok, false)
})

test('the full result is kept in memory beyond the display cap', () => {
  const ledger = createLedger()
  const text = `${'a'.repeat(2000)}TAIL_MARKER`
  const entry = ledger.record(observation({ contentText: text }))
  assert.equal(entry.content.length, 1600)
  assert.equal(entry.full_chars, text.length)
  assert.equal(entry.full_truncated, false)
  assert.ok(entry.full.endsWith('TAIL_MARKER'))
})

test('a result beyond the full cap reports how much was retained', () => {
  const ledger = createLedger()
  const entry = ledger.record(observation({ contentText: 'x'.repeat(9000) }))
  assert.equal(entry.full.length, 8000)
  assert.equal(entry.full_chars, 9000)
  assert.equal(entry.full_truncated, true)
})
