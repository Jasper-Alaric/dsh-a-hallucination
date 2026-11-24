import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadMode, resolveStateDir, saveMode } from '../lib/state.js'
import { resolveSettings } from '../lib/modes.js'

/** A disposable directory for one test. */
function tempDir() {
  return mkdtempSync(path.join(tmpdir(), 'a-hallucination-'))
}

test('persistence is off only when the config says so', () => {
  assert.equal(resolveSettings({}).persistMode, true)
  assert.equal(resolveSettings({ persistMode: false }).persistMode, false)
  assert.equal(resolveStateDir(resolveSettings({ persistMode: false })), undefined)
  assert.equal(resolveStateDir(undefined), undefined)
})

test('a configured directory wins over the DSH home', () => {
  const dir = tempDir()
  const settings = resolveSettings({ persistMode: true, stateDir: dir })
  assert.equal(resolveStateDir(settings), path.resolve(dir))
  rmSync(dir, { recursive: true, force: true })
})

test('the mode round-trips through the state file', () => {
  const dir = tempDir()
  assert.equal(loadMode(dir), undefined)
  assert.equal(saveMode(dir, 'adjudicate'), true)
  assert.equal(loadMode(dir), 'adjudicate')
  assert.equal(saveMode(dir, 'observe'), true)
  assert.equal(loadMode(dir), 'observe')
  rmSync(dir, { recursive: true, force: true })
})

test('a broken or foreign state file is ignored, never thrown', () => {
  const dir = tempDir()
  writeFileSync(path.join(dir, 'state.json'), '{not json', 'utf8')
  assert.equal(loadMode(dir), undefined)
  writeFileSync(path.join(dir, 'state.json'), '{"mode": 42}', 'utf8')
  assert.equal(loadMode(dir), undefined)
  writeFileSync(path.join(dir, 'state.json'), 'null', 'utf8')
  assert.equal(loadMode(dir), undefined)
  rmSync(dir, { recursive: true, force: true })
})

test('saving creates the directory and rejects an empty mode', () => {
  const dir = path.join(tempDir(), 'nested', 'deeper')
  assert.equal(saveMode(dir, 'inspect'), true)
  assert.equal(loadMode(dir), 'inspect')
  assert.equal(saveMode(dir, ''), false)
  assert.equal(saveMode(undefined, 'inspect'), false)
  rmSync(path.dirname(path.dirname(dir)), { recursive: true, force: true })
})

test('a UTF-8 BOM does not break the read', () => {
  const dir = tempDir()
  writeFileSync(path.join(dir, 'state.json'), '\uFEFF{"mode":"adjudicate"}', 'utf8')
  assert.equal(loadMode(dir), 'adjudicate')
  rmSync(dir, { recursive: true, force: true })
})

test('an unreadable state file degrades instead of throwing', () => {
  const dir = tempDir()
  // A directory where the file should be makes readFileSync throw.
  mkdirSync(path.join(dir, 'state.json'))
  assert.equal(loadMode(dir), undefined)
  rmSync(dir, { recursive: true, force: true })
})
