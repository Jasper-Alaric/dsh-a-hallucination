import test from 'node:test'
import assert from 'node:assert/strict'
import { createCorpus, createCorpusRegistry, normalizeText, textOfContent } from '../lib/corpus.js'
import { classifyRisk, createObservationRegistry, decidePreTool, normalizeToolName, untraceableParams } from '../lib/gate.js'
import { resolveSettings, switchesOf } from '../lib/modes.js'

/** A gate state for one mode and one session. */
function state(mode, corpusText = '') {
  const settings = resolveSettings({ mode })
  const corpora = createCorpusRegistry()
  const observations = createObservationRegistry()
  if (corpusText.length > 0) corpora.get('s1').add(corpusText)
  return { mode: settings.mode, settings, switches: switchesOf(settings.mode), corpora, observations }
}

/** A pending call for one tool. */
function call(name, args = {}) {
  return { name, arguments: args, agent: { id: 's1' } }
}

test('corpus matches whitespace-insensitively and stays bounded', () => {
  const corpus = createCorpus(20)
  corpus.add('hello   world')
  assert.equal(corpus.has('hello world'), true)
  corpus.add('x'.repeat(50))
  assert.ok(corpus.size() <= 20)
  assert.equal(normalizeText(' a b '), 'a b')
})

test('textOfContent flattens blocks and ignores junk', () => {
  assert.equal(textOfContent([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb')
  assert.equal(textOfContent('plain'), 'plain')
  assert.equal(textOfContent([null, 3, {}]), '')
})

test('camelCase tool names normalize to snake_case', () => {
  assert.equal(normalizeToolName('deleteFile'), 'delete_file')
  assert.equal(normalizeToolName('qq_send_file'), 'qq_send_file')
  assert.equal(normalizeToolName('skill'), 'skill')
})

test('destructive and outward-facing tools are high risk', () => {
  const settings = resolveSettings({})
  for (const name of ['deleteFile', 'removeDir', 'publishPackage', 'qq_send_file', 'shutdownHost', 'uninstallPlugin', 'pushBranch']) {
    assert.ok(classifyRisk(name, settings) !== undefined, `${name} should be high risk`)
  }
})

test('ordinary tools are never high risk, including skill and format', () => {
  const settings = resolveSettings({})
  const allowed = ['read', 'write', 'edit', 'pwsh', 'glob', 'grep', 'present', 'plugin_manager', 'ledger_view',
    'skill', 'format', 'formatCode', 'formatter', 'dropdown', 'todowrite', 'web_fetch', 'subagent', 'ask_user_question']
  for (const name of allowed) {
    assert.equal(classifyRisk(name, settings), undefined, `${name} must not be blocked`)
  }
})

test('highRiskTools adds names and highRiskAllow exempts them', () => {
  const added = resolveSettings({ highRiskTools: ['myDanger'] })
  assert.ok(classifyRisk('myDanger', added) !== undefined)
  const allowed = resolveSettings({ highRiskTools: ['myDanger'], highRiskAllow: ['myDanger'] })
  assert.equal(classifyRisk('myDanger', allowed), undefined)
})

test('only identifying keys are checked for provenance', () => {
  const corpus = createCorpus()
  corpus.add('目标路径是 E:/project/output.txt')
  assert.deepEqual(untraceableParams({ path: 'E:/project/output.txt' }, corpus), [])
  const missing = untraceableParams({ nested: { url: 'https://never.test' } }, corpus)
  assert.equal(missing.length, 1)
  assert.equal(missing[0].key, 'nested.url')
})

test('payloads, prose, and composed commands are not treated as identifiers', () => {
  const corpus = createCorpus()
  corpus.add('E:/known.txt')
  const missing = untraceableParams({
    path: 'E:/known.txt',
    content: 'a brand new body',
    new_string: 'another new body',
    description: 'a sentence written for this call',
    prompt: 'a fresh prompt',
    command: 'Get-Date | Format-List',
    action: 'append',
    status: 'pending',
  }, corpus)
  assert.deepEqual(missing.map(item => item.key), [])
})

test('traceableParams extends the identifying key set', () => {
  const corpus = createCorpus()
  const missing = untraceableParams({ cmdline: 'novel-value' }, corpus, ['cmdline'])
  assert.deepEqual(missing.map(item => item.key), ['cmdline'])
})

test('inspect asks before a high-risk call', () => {
  const decision = decidePreTool(call('deleteFile', { path: 'a' }), state('inspect'))
  assert.equal(decision.kind, 'ask')
  assert.ok(decision.displayReason.zh.includes('高风险'))
  assert.ok(decision.displayReason.en.length > 0)
})

test('inspect records an untraceable parameter without denying the call', () => {
  const pluginState = state('inspect', '已知路径 E:/ok.txt')
  const decision = decidePreTool(call('read', { path: 'E:/unknown.txt' }), pluginState)
  assert.equal(decision, undefined)
  assert.equal(pluginState.observations.get('s1').length, 1)
  assert.deepEqual(pluginState.observations.get('s1')[0].params, ['path'])
})

test('adjudicate denies an untraceable parameter', () => {
  const pluginState = state('adjudicate', '已知路径 E:/ok.txt')
  const decision = decidePreTool(call('read', { path: 'E:/unknown.txt' }), pluginState)
  assert.equal(decision.kind, 'deny')
  assert.ok(decision.reason.includes('untraceable'))
})

test('adjudicate refuses an untraceable target even when the action is high risk', () => {
  const decision = decidePreTool(call('deleteFile', { path: 'E:/never-seen.txt' }), state('adjudicate'))
  assert.equal(decision.kind, 'deny')
})

test('adjudicate allows an ordinary write to a traceable path', () => {
  const pluginState = state('adjudicate', '请写入 E:/ok.txt')
  assert.equal(decidePreTool(call('write', { path: 'E:/ok.txt', content: 'brand new body' }), pluginState), undefined)
  assert.equal(decidePreTool(call('edit', { file_path: 'E:/ok.txt', old_string: 'a', new_string: 'b' }), pluginState), undefined)
})

test('observe mode gates nothing', () => {
  const pluginState = state('observe')
  assert.equal(decidePreTool(call('deleteFile', { path: 'a' }), pluginState), undefined)
  assert.equal(decidePreTool(call('read', { path: 'E:/unknown.txt' }), pluginState), undefined)
})

test('the plugin never gates its own tools', () => {
  const pluginState = state('adjudicate')
  assert.equal(decidePreTool(call('ledger_view', { action: 'status' }), pluginState), undefined)
})

test('a string argument body is not mistaken for an object', () => {
  const pluginState = state('adjudicate')
  assert.equal(decidePreTool({ name: 'pwsh', arguments: 'Get-Date', agent: { id: 's1' } }, pluginState), undefined)
})

test('numeric and array identifiers are checked too', () => {
  const corpus = createCorpus()
  corpus.add('invoice 999 for account 12345')
  assert.deepEqual(untraceableParams({ amount: 999 }, corpus), [])
  assert.deepEqual(untraceableParams({ account: 12345 }, corpus), [])
  const missingNumber = untraceableParams({ amount: 424242 }, corpus)
  assert.deepEqual(missingNumber.map(item => item.key), ['amount'])
  const missingArray = untraceableParams({ ids: ['777', '888'] }, corpus)
  assert.deepEqual(missingArray.map(item => item.key), ['ids'])
})

test('user text survives a flood of tool output', () => {
  const corpus = createCorpus(200, 200)
  corpus.add('protect this instruction', { protect: true })
  for (let index = 0; index < 20; index += 1) corpus.add(`tool output ${index} `.repeat(20))
  assert.equal(corpus.has('protect this instruction'), true)
})

test('whitespace runs never hide a match', () => {
  const corpus = createCorpus()
  corpus.add('path is E:/My File.txt')
  assert.equal(corpus.has('E:/My  File.txt'), true)
})

test('an observation list stays bounded and totals across sessions', () => {
  const registry = createObservationRegistry(3)
  for (let index = 0; index < 5; index += 1) registry.push('s1', { tool: `t${index}` })
  assert.equal(registry.get('s1').length, 3)
  assert.equal(registry.get('s1')[2].tool, 't4')
  registry.push('s2', {})
  assert.equal(registry.total(), 4)
  registry.drop('s1')
  assert.equal(registry.total(), 1)
})

// --- attributable roots: a reloaded corpus must not lock the agent out -------

const emptyCorpus = { has: () => false }

test('a path under an attributable root is traceable without a citation', () => {
  const found = untraceableParams({ path: 'E:/work/project/a.txt' }, emptyCorpus, ['path'], ['E:/work'])
  assert.equal(found.length, 0)
})

test('a path outside every root still needs a citation', () => {
  const found = untraceableParams({ path: 'E:/somewhere/else.txt' }, emptyCorpus, ['path'], ['E:/work'])
  assert.equal(found.length, 1)
})

test('root matching is boundary-aware, not a prefix match', () => {
  assert.equal(untraceableParams({ path: 'E:/workshop/x' }, emptyCorpus, ['path'], ['E:/work']).length, 1)
  assert.equal(untraceableParams({ path: 'E:/work/x' }, emptyCorpus, ['path'], ['E:/work/']).length, 0)
})

test('without roots every uncited identifying parameter is reported', () => {
  assert.equal(untraceableParams({ path: 'E:/work/a.txt' }, emptyCorpus, ['path'], []).length, 1)
})

test('a cited value is traceable even outside the roots', () => {
  const cited = { has: (value) => value === 'E:/elsewhere/b.txt' }
  assert.equal(untraceableParams({ path: 'E:/elsewhere/b.txt' }, cited, ['path'], []).length, 0)
})

// --- root normalization and short identifiers (M1, L3) ---------------------

test('a .. traversal does not escape the configured root', () => {
  assert.equal(untraceableParams({ path: 'E:/base/../Windows/x' }, emptyCorpus, ['path'], ['E:/base']).length, 1)
})

test('a forward-slash or differently-cased path still matches the root', () => {
  assert.equal(untraceableParams({ path: 'E:/base/x' }, emptyCorpus, ['path'], ['E:\\base']).length, 0)
  assert.equal(untraceableParams({ path: 'E:/BASE/X' }, emptyCorpus, ['path'], ['e:/base']).length, 0)
})

test('a one-character id is still an identifying value', () => {
  const decision = decidePreTool(call('read', { id: 7 }), state('adjudicate'))
  assert.equal(decision.kind, 'deny')
  assert.ok(decision.reason.includes('untraceable'))
})

// --- risk matching: command forms, shell suffixes, and mail reads (M7) ------

test('risk gate catches curl request forms and gh pr merge', () => {
  const settings = resolveSettings({})
  for (const command of ['curl --request POST https://example.test', 'curl -XPOST https://example.test', 'gh pr merge 12']) {
    const risk = classifyRisk('terminal_exec', settings, { command })
    assert.notEqual(risk, undefined, command)
  }
})

test('email_search reads mail and is not treated as a sender', () => {
  assert.equal(classifyRisk('email_search', resolveSettings({})), undefined)
  assert.notEqual(classifyRisk('email_send', resolveSettings({})), undefined)
})

// --- mode roots and labels (H3, L1) ----------------------------------------

test('default roots include DSH_HOME and explicit [] exempts nothing', () => {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = 'E:/dsh-home-for-test'
  try {
    const settings = resolveSettings({})
    assert.ok(settings.traceableRoots.includes('E:/dsh-home-for-test'))
    assert.ok(settings.traceableRoots.length >= 1)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
  assert.deepEqual(resolveSettings({ traceableRoots: [] }).traceableRoots, [])
  const underCwd = `${process.cwd().replace(/\\/g, '/')}/a.txt`
  assert.equal(
    untraceableParams({ path: underCwd }, emptyCorpus, ['path'], resolveSettings({ traceableRoots: [] }).traceableRoots).length,
    1,
  )
})

test('a Chinese mode label is not reported as an unknown profile', () => {
  assert.deepEqual(resolveSettings({ mode: '断案' }).warnings, [])
  assert.equal(resolveSettings({ mode: '断案' }).mode, 'adjudicate')
})
