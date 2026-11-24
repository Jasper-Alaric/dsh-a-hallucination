import test from 'node:test'
import assert from 'node:assert/strict'
import { createMetrics } from '../lib/metrics.js'
import { validateAnswer } from '../lib/validator.js'

/** A document that passes every invariant. */
function cleanDoc() {
  return {
    answer: 'value is 42',
    claims: [{ id: 'C1', claim: 'value is 42', status: 'verified', evidence_ids: ['E1'] }],
    evidence: [{ id: 'E1', source_type: 'tool', source: 'read', source_id: 'E1', excerpt: '', verbatim: false }],
    facts: ['value is 42'],
    tool_calls: [{ tool: 'read', status: 'success' }],
  }
}
const CTX = { toolNames: ['read'], sources: { E1: 'body' }, traceable: [] }

test('an empty accumulator reports no rates instead of dividing by zero', () => {
  const snapshot = createMetrics().snapshot()
  assert.equal(snapshot.checks, 0)
  assert.equal(snapshot.passRate, null)
  assert.equal(snapshot.quoteRate, null)
})

test('a pass and a failure are counted separately', () => {
  const metrics = createMetrics()
  metrics.record(validateAnswer(cleanDoc(), CTX), { quoted: 1 })
  const failing = cleanDoc()
  failing.claims[0].evidence_ids = ['E9']
  metrics.record(validateAnswer(failing, CTX), { quoted: 0 })
  const snapshot = metrics.snapshot()
  assert.equal(snapshot.checks, 2)
  assert.equal(snapshot.fail, 1)
  assert.equal(snapshot.claims, 2)
  assert.equal(snapshot.quoted, 1)
  assert.equal(snapshot.codes.V2, 1)
})

test('levels are counted so over- and under-checking both show up', () => {
  const metrics = createMetrics()
  metrics.record(validateAnswer(cleanDoc(), CTX), { quoted: 0 })
  const light = { answer: 'ok', claims: [{ id: 'C1', claim: 'ok', status: 'inferred' }], facts: ['ok'], tool_calls: [] }
  metrics.record(validateAnswer(light, {}), { quoted: 0 })
  const standard = { answer: 'summary', claims: [{ id: 'C1', claim: 'summary', status: 'inferred' }], facts: ['summary'], tool_calls: [{ tool: 'read', status: 'success' }] }
  metrics.record(validateAnswer(standard, {}), { quoted: 0 })
  const snapshot = metrics.snapshot()
  // A claim that cites evidence is the strict case; a call without citations is standard.
  assert.equal(snapshot.levels.strict, 1)
  assert.equal(snapshot.levels.standard, 1)
  assert.equal(snapshot.levels.light, 1)
})

test('malformed input is ignored rather than thrown', () => {
  const metrics = createMetrics()
  metrics.record(null)
  metrics.record('x')
  metrics.record({}, undefined)
  assert.equal(metrics.snapshot().checks, 1)
})

test('the quote rate reflects how many claims carried a quote', () => {
  const metrics = createMetrics()
  metrics.record(validateAnswer(cleanDoc(), CTX), { quoted: 1 })
  assert.equal(metrics.snapshot().quoteRate, 100)
})
