import test from 'node:test'
import assert from 'node:assert/strict'
import { createTurnTracker, createVerdictRegistry } from '../lib/turn.js'
import { buildTurnDocument, verifyTurn } from '../lib/turnend.js'

/** One ledger entry as the turn-end verifier sees it. */
function entry(overrides = {}) {
  return { id: 'E1', source: 'pwsh', status: 'success', excerpt: '2026-11-24', verbatim: true, ...overrides }
}

test('begin records the turn and clears the previous answer', () => {
  const tracker = createTurnTracker()
  tracker.begin('s1', 2)
  tracker.append('s1', 'hello')
  assert.equal(tracker.textOf('s1'), 'hello')
  tracker.begin('s1', 3)
  assert.equal(tracker.textOf('s1'), '')
  assert.equal(tracker.turnOf('s1'), 3)
})

test('append keeps the tail within the limit', () => {
  const tracker = createTurnTracker(5)
  tracker.append('s1', 'abcdefg')
  assert.equal(tracker.textOf('s1'), 'cdefg')
})

test('the tracker bounds its session count', () => {
  const tracker = createTurnTracker(10, 2)
  tracker.begin('a', 1)
  tracker.begin('b', 1)
  tracker.begin('c', 1)
  assert.equal(tracker.sessions(), 2)
  assert.equal(tracker.turnOf('a'), null)
})

test('the verdict registry is bounded and readable back', () => {
  const registry = createVerdictRegistry(2)
  registry.set('a', { verdict: 'pass' })
  registry.set('b', { verdict: 'pass' })
  registry.set('c', { verdict: 'pass' })
  assert.equal(registry.get('a'), undefined)
  assert.equal(registry.get('c').verdict, 'pass')
})

test('a completion with an error result fails V5', () => {
  const result = verifyTurn('已执行清理。', [entry({ status: 'error' })])
  assert.ok(result.failedCodes.includes('V5'))
  assert.equal(result.passed, false)
})

test('a completion with a successful execution call passes that check', () => {
  const result = verifyTurn('已执行清理。', [entry()])
  assert.equal(result.failedCodes.includes('V5'), false)
  assert.equal(result.failedCodes.includes('V6'), false)
})

test('an empty answer yields a partial verdict, never a clean pass', () => {
  const result = verifyTurn('', [])
  assert.equal(result.verdict, 'partial')
  assert.equal(result.passed, true)
  assert.ok(result.unchecked.includes('V1'))
})

test('the turn document maps entries to evidence and calls without inventing claims', () => {
  const document = buildTurnDocument('answer', [entry()])
  assert.equal(document.evidence[0].id, 'E1')
  assert.equal(document.evidence[0].source_type, 'tool')
  assert.equal(document.tool_calls[0].tool, 'pwsh')
  assert.equal(document.tool_calls[0].status, 'success')
  assert.equal(document.claims.length, 0)
  assert.equal(document.facts.length, 0)
})

test('the verifier tolerates malformed entries', () => {
  const result = verifyTurn('text', [null, undefined, {}, { id: 1 }])
  assert.equal(typeof result.passed, 'boolean')
})
