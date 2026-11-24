import test from 'node:test'
import assert from 'node:assert/strict'
import { INVARIANTS, formatVerdict, validateAnswer } from '../lib/validator.js'

/** A fully compliant answer document. */
function compliant(overrides = {}) {
  return {
    mode: 'full',
    answer: '服务器时间已从工具返回中得到：截至 2026-11-24 08:00 UTC 为 08:00:12 [E1]。',
    claims: [
      { id: 'C1', claim: '服务器时间为 08:00:12', type: 'fact', status: 'verified', evidence_ids: ['E1'], confidence: 'high' },
    ],
    evidence: [
      { id: 'E1', source_type: 'tool', source: 'pwsh', excerpt: '08:00:12', verbatim: true, trust: 'high' },
    ],
    conflicts: [],
    tool_calls: [{ tool: 'pwsh', params: { command: 'Get-Date' }, status: 'success' }],
    action_confirmation: { required: false },
    uncertainties: [],
    facts: ['服务器时间为 08:00:12'],
    ...overrides,
  }
}

/** Runtime context matching the compliant document. */
function context(overrides = {}) {
  return { toolNames: ['pwsh'], sources: ['ServerTime=08:00:12'], traceable: ['Get-Date'], ...overrides }
}

test('a compliant answer passes and names every invariant', () => {
  const result = validateAnswer(compliant(), context())
  assert.equal(result.passed, true)
  assert.equal(result.verdict, 'pass')
  assert.equal(result.downgradeTo, null)
  assert.equal(INVARIANTS.length, 11)
})

test('V1 catches a factual sentence with no claim', () => {
  const result = validateAnswer(compliant({ facts: ['这是没有任何 claim 覆盖的断言'] }), context())
  assert.equal(result.passed, false)
  assert.ok(result.failedCodes.includes('V1'))
})

test('V2 catches a verified claim citing missing evidence', () => {
  const doc = compliant()
  doc.claims[0].evidence_ids = ['E9']
  const result = validateAnswer(doc, context())
  assert.ok(result.failedCodes.includes('V2'))
})

test('V2 catches a verified claim with no evidence ids', () => {
  const doc = compliant()
  doc.claims[0].evidence_ids = []
  assert.ok(validateAnswer(doc, context()).failedCodes.includes('V2'))
})

test('V3 catches an excerpt that is not in the source', () => {
  const doc = compliant()
  doc.evidence[0].excerpt = '08:99:99'
  assert.ok(validateAnswer(doc, context()).failedCodes.includes('V3'))
})

test('V3 reports unverifiable instead of failing when no source is provided', () => {
  const result = validateAnswer(compliant(), context({ sources: [] }))
  assert.equal(result.passed, true)
  assert.equal(result.stats.unverifiable, 1)
})

test('V3 checks the excerpt against the source it cites, not just any source', () => {
  const doc = compliant()
  doc.evidence = [{ id: 'E1', source_type: 'web', source: 'page-a', source_id: 'a', excerpt: '来自B源的内容', verbatim: true }]
  const result = validateAnswer(doc, { toolNames: ['pwsh'], sources: { a: 'A源文本', b: '来自B源的内容' }, traceable: ['Get-Date'] })
  assert.ok(result.failedCodes.includes('V3'))
})

test('V3 accepts an excerpt that is in the cited source', () => {
  const doc = compliant()
  doc.evidence = [{ id: 'E1', source_type: 'web', source: 'page-b', source_id: 'b', excerpt: '来自B源的内容', verbatim: true }]
  const result = validateAnswer(doc, { toolNames: ['pwsh'], sources: { a: 'A源文本', b: '来自B源的内容' }, traceable: ['Get-Date'] })
  assert.equal(result.failedCodes.includes('V3'), false)
})

test('V3 rejects a cited source id that was never provided', () => {
  const doc = compliant()
  doc.evidence = [{ id: 'E1', source_type: 'web', source: 'page-z', source_id: 'z', excerpt: 'x', verbatim: true }]
  assert.ok(validateAnswer(doc, { toolNames: ['pwsh'], sources: { a: 'A源文本' }, traceable: ['Get-Date'] }).failedCodes.includes('V3'))
})

test('V3 requires a source id when the provided sources are keyed', () => {
  const result = validateAnswer(compliant(), { toolNames: ['pwsh'], sources: { a: 'ServerTime=08:00:12' }, traceable: ['Get-Date'] })
  assert.ok(result.failedCodes.includes('V3'))
})

test('V3 accepts id-keyed array sources too', () => {
  const doc = compliant()
  doc.evidence = [{ id: 'E1', source_type: 'tool', source: 'pwsh', source_id: 'srv', excerpt: '08:00:12', verbatim: true }]
  const result = validateAnswer(doc, { toolNames: ['pwsh'], sources: [{ id: 'srv', text: 'ServerTime=08:00:12' }], traceable: ['Get-Date'] })
  assert.equal(result.passed, true)
})

test('V4 catches evidence from a tool that never ran', () => {
  const doc = compliant()
  doc.evidence[0].source = 'made_up_tool'
  assert.ok(validateAnswer(doc, context()).failedCodes.includes('V4'))
})

test('V4 accepts user and model_common sources', () => {
  const doc = compliant()
  doc.claims[0].evidence_ids = ['E1', 'E2']
  doc.evidence.push({ id: 'E2', source_type: 'user', source: 'message', excerpt: '随便', verbatim: false })
  assert.equal(validateAnswer(doc, context()).passed, true)
})

test('V5 catches completion tense without a successful call', () => {
  const doc = compliant({ answer: '已查询到服务器时间。', tool_calls: [] })
  assert.ok(validateAnswer(doc, context()).failedCodes.includes('V5'))
})

test('V6 catches a finished execution claim with no execution call', () => {
  const doc = compliant({ answer: '已执行清理脚本。' })
  doc.tool_calls = [{ tool: 'read', params: {}, status: 'success' }]
  assert.ok(validateAnswer(doc, context()).failedCodes.includes('V6'))
})

test('V6 accepts a successful execution call', () => {
  const doc = compliant({ answer: '已执行清理脚本。' })
  doc.tool_calls = [{ tool: 'shellWrite', params: {}, status: 'success' }]
  assert.equal(validateAnswer(doc, context()).passed, true)
})

test('V7 catches low confidence that is not stated', () => {
  const doc = compliant()
  doc.claims[0].confidence = 'low'
  assert.ok(validateAnswer(doc, context()).failedCodes.includes('V7'))
})

test('V7 accepts a stated uncertainty', () => {
  const doc = compliant()
  doc.claims[0].confidence = 'low'
  doc.answer = '服务器时间无法确认，以下为推断。'
  assert.equal(validateAnswer(doc, context()).passed, true)
})

test('V7 catches an unresolved conflict stated as fact', () => {
  const doc = compliant({ conflicts: [{ topic: 'time', evidence_ids: ['E1'], resolution: 'unresolved' }] })
  assert.ok(validateAnswer(doc, context()).failedCodes.includes('V7'))
})

test('V8 catches an unconfirmed high-risk action that ran', () => {
  const doc = compliant({ action_confirmation: { required: true, confirmed: false } })
  doc.tool_calls = [{ tool: 'deleteFile', params: {}, status: 'success' }]
  assert.ok(validateAnswer(doc, context()).failedCodes.includes('V8'))
})

test('V8 accepts a confirmed high-risk action', () => {
  const doc = compliant({ action_confirmation: { required: true, confirmed: true } })
  doc.tool_calls = [{ tool: 'deleteFile', params: {}, status: 'success' }]
  assert.equal(validateAnswer(doc, context()).passed, true)
})

test('V9 catches an identifying parameter with no traceable origin', () => {
  const doc = compliant()
  doc.tool_calls = [{ tool: 'read', params: { path: 'E:/secret/key.txt' }, status: 'success' }]
  const result = validateAnswer(doc, context())
  assert.ok(result.failedCodes.includes('V9'))
})

test('V9 accepts a parameter visible in observed context', () => {
  const doc = compliant()
  doc.tool_calls = [{ tool: 'pwsh', params: { command: 'Get-Date' }, status: 'success' }]
  assert.equal(validateAnswer(doc, context()).passed, true)
})

test('V9 does not flag a payload written for this call', () => {
  const doc = compliant()
  doc.tool_calls = [{ tool: 'write', params: { path: 'Get-Date', content: 'a brand new body' }, status: 'success' }]
  assert.equal(validateAnswer(doc, context()).failedCodes.includes('V9'), false)
})

test('V9 checks numeric identifiers too', () => {
  const doc = compliant()
  doc.tool_calls = [{ tool: 'pay', params: { amount: 99999 }, status: 'success' }]
  assert.ok(validateAnswer(doc, { ...context(), traceable: ['nothing related'] }).failedCodes.includes('V9'))
})

test('V4 rejects a source_type the runtime cannot vouch for', () => {
  const doc = compliant()
  doc.evidence = [{ id: 'E1', source_type: 'rumour', source: 'x', excerpt: '08:00:12', verbatim: true }]
  assert.ok(validateAnswer(doc, context()).failedCodes.includes('V4'))
})

test('V10 downgrades on any failure and never passes', () => {
  const result = validateAnswer({ answer: '已确认。', claims: [], evidence: [], tool_calls: [] }, {})
  assert.equal(result.passed, false)
  assert.equal(result.verdict, 'downgrade')
  assert.equal(result.downgradeTo, 'abstain')
})

test('malformed input never throws', () => {
  for (const input of [undefined, null, {}, { claims: 'nope' }, { evidence: [null] }]) {
    const result = validateAnswer(input, {})
    assert.equal(typeof result.passed, 'boolean')
  }
})

test('the verdict formatter names the failed codes', () => {
  const text = formatVerdict(validateAnswer({ answer: '已执行。' }, {}))
  assert.ok(text.includes('FAIL'))
  assert.ok(text.includes('V5'))
})

test('a finished non-execution task does not trip V6', () => {
  const doc = compliant({ answer: '分析已完成，结论如下 [E1]。' })
  const result = validateAnswer(doc, context())
  assert.equal(result.failedCodes.includes('V6'), false)
  assert.equal(result.passed, true)
})

test('a finished execution task still trips V6 without an execution call', () => {
  const doc = compliant({ answer: '清理已执行。' })
  doc.tool_calls = [{ tool: 'read', params: {}, status: 'success' }]
  assert.ok(validateAnswer(doc, context()).failedCodes.includes('V6'))
})

test('已完成 next to an execution verb trips V6', () => {
  const doc = compliant({ answer: '迁移已完成。' })
  doc.tool_calls = [{ tool: 'read', params: {}, status: 'success' }]
  assert.ok(validateAnswer(doc, context()).failedCodes.includes('V6'))
})

test('已发布 and 已删除 are execution claims', () => {
  for (const sentence of ['版本已发布。', '文件已删除。', 'I have sent the email.']) {
    const doc = compliant({ answer: sentence })
    doc.tool_calls = [{ tool: 'read', params: {}, status: 'success' }]
    assert.ok(validateAnswer(doc, context()).failedCodes.includes('V6'), sentence)
  }
})

test('a negated completion does not trigger V5 or V6', () => {
  const doc = compliant({ answer: '无法确认文件是否已删除。' })
  doc.tool_calls = [{ tool: 'read', params: {}, status: 'success' }]
  const result = validateAnswer(doc, context())
  assert.equal(result.failedCodes.includes('V5'), false)
  assert.equal(result.failedCodes.includes('V6'), false)
})

test('a shell tool counts as the execution vehicle', () => {
  const doc = compliant({ answer: '清理已执行。' })
  doc.tool_calls = [{ tool: 'pwsh', params: { command: 'Get-Date' }, status: 'success' }]
  assert.equal(validateAnswer(doc, context()).failedCodes.includes('V6'), false)
})

test('a pending call does not count as executed for V8', () => {
  const doc = compliant({ action_confirmation: { required: true, confirmed: false } })
  doc.tool_calls = [{ tool: 'deleteFile', params: {}, status: 'pending' }]
  assert.equal(validateAnswer(doc, context()).failedCodes.includes('V8'), false)
})

test('a null conflict entry is not treated as unresolved', () => {
  const doc = compliant({ conflicts: [null] })
  assert.equal(validateAnswer(doc, context()).failedCodes.includes('V7'), false)
})

test('an accepted conflict does not require an uncertainty statement', () => {
  const doc = compliant({ conflicts: [{ topic: 'x', resolution: 'accepted' }] })
  assert.equal(validateAnswer(doc, context()).failedCodes.includes('V7'), false)
})

test('a one-character claim cannot cover a long factual sentence', () => {
  const doc = compliant({ facts: ['服务器时间为 08:00:12'] })
  doc.claims = [{ id: 'C1', claim: '时间', status: 'unknown', evidence_ids: [], confidence: 'low' }]
  assert.ok(validateAnswer(doc, context()).failedCodes.includes('V1'))
})

test('skipped checks yield a partial verdict, not a clean pass', () => {
  const result = validateAnswer({ answer: '无法确认。' }, {})
  assert.deepEqual(result.unchecked.sort(), ['V1', 'V3', 'V9'])
  assert.equal(result.verdict, 'partial')
  assert.ok(formatVerdict(result).includes('PARTIAL'))
})

test('checks run when their inputs are supplied', () => {
  const result = validateAnswer(compliant({ facts: ['服务器时间为 08:00:12'] }), context())
  assert.equal(result.unchecked.includes('V1'), false)
  assert.equal(result.unchecked.includes('V3'), false)
  assert.equal(result.unchecked.includes('V9'), false)
})

// --- V11: time-sensitive claims need fresh evidence -------------------------

/** A document that passes every other invariant, for V11 isolation. */
function freshDoc(asOf) {
  const evidence = { id: 'E1', source_type: 'tool', source: 'read', source_id: 'E1', excerpt: '', verbatim: false }
  if (asOf !== undefined) evidence.as_of = asOf
  return {
    answer: 'value is 42',
    claims: [{ id: 'C1', claim: 'value is 42', status: 'verified', evidence_ids: ['E1'], time_sensitive: true }],
    evidence: [evidence],
    facts: ['value is 42'],
    tool_calls: [{ tool: 'read', status: 'success' }],
  }
}
const CTX = { toolNames: ['read'], sources: { E1: 'body' }, traceable: [], maxAgeHours: 24 }

test('V11 passes when the cited evidence was retrieved just now', () => {
  const result = validateAnswer(freshDoc(new Date().toISOString()), CTX)
  assert.equal(result.failedCodes.includes('V11'), false)
})

test('V11 fails a time-sensitive claim backed by stale evidence', () => {
  const old = new Date(Date.now() - 48 * 3600 * 1000).toISOString()
  const result = validateAnswer(freshDoc(old), CTX)
  assert.equal(result.passed, false)
  assert.ok(result.failedCodes.includes('V11'))
})

test('V11 fails when the evidence carries no timestamp at all', () => {
  const result = validateAnswer(freshDoc(undefined), CTX)
  assert.ok(result.failedCodes.includes('V11'))
})

test('V11 respects a custom age limit', () => {
  const twoHours = new Date(Date.now() - 2 * 3600 * 1000).toISOString()
  assert.equal(validateAnswer(freshDoc(twoHours), { ...CTX, maxAgeHours: 1 }).failedCodes.includes('V11'), true)
  assert.equal(validateAnswer(freshDoc(twoHours), { ...CTX, maxAgeHours: 24 }).failedCodes.includes('V11'), false)
})

test('stale evidence is fine for a claim that is not time-sensitive', () => {
  const doc = freshDoc(new Date(Date.now() - 48 * 3600 * 1000).toISOString())
  doc.claims[0].time_sensitive = false
  assert.equal(validateAnswer(doc, CTX).failedCodes.includes('V11'), false)
})

test('V11 is declared with the other invariants', () => {
  assert.ok(INVARIANTS.some(item => item.code === 'V11'))
})

// --- L3 verification level and L6 output form -------------------------------

test('a quoted claim raises the level to strict', () => {
  assert.equal(validateAnswer(freshDoc(new Date().toISOString()), CTX).stats.level, 'strict')
})

test('a successful call without quotes is standard', () => {
  const doc = { answer: 'ok', claims: [{ id: 'C1', claim: 'ok', status: 'inferred' }], facts: ['ok'], tool_calls: [{ tool: 'read', status: 'success' }] }
  assert.equal(validateAnswer(doc, {}).stats.level, 'standard')
})

test('no call at all is a light pass', () => {
  const doc = { answer: 'ok', claims: [{ id: 'C1', claim: 'ok', status: 'inferred' }], facts: ['ok'], tool_calls: [] }
  assert.equal(validateAnswer(doc, {}).stats.level, 'light')
})

test('the rendered verdict names the output form for a failure', () => {
  const text = formatVerdict(validateAnswer(freshDoc(undefined), CTX))
  assert.ok(text.includes('form: abstain'), text)
})

test('the rendered verdict names the output form for a pass', () => {
  const text = formatVerdict(validateAnswer(freshDoc(new Date().toISOString()), CTX))
  assert.ok(text.includes('form: direct') || text.includes('form: annotate'), text)
})
