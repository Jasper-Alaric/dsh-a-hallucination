import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MODE_IDS } from '../lib/modes.js'

/** Package root, resolved from this file so the test runs from any cwd. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Read one repository file as text. */
function read(relative) {
  return readFileSync(path.join(ROOT, relative), 'utf8')
}

/** Parse the one insert row of the bundle patch without a YAML dependency. */
function parsePatch() {
  const text = read('cordis.patch.yml')
  const id = /^\s*-\s*id:\s*(\S+)\s*$/m.exec(text)?.[1]
  const name = /^\s*name:\s*'?([^'\n]+)'?\s*$/m.exec(text)?.[1]
  const mode = /^\s*mode:\s*(\S+)\s*$/m.exec(text)?.[1]
  return { id, name, mode, text }
}

test('the manifest declares a bundle patch and an icon', () => {
  const manifest = JSON.parse(read('package.json'))
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.ok(statSync(path.join(ROOT, 'cordis.patch.yml')).isFile())
  assert.ok(statSync(path.join(ROOT, 'icon.svg')).isFile())
  assert.ok(read('icon.svg').trimStart().startsWith('<svg'))
})

test('every static export target exists on disk', () => {
  const manifest = JSON.parse(read('package.json'))
  for (const [key, target] of Object.entries(manifest.exports)) {
    if (key.includes('*')) continue
    assert.ok(statSync(path.join(ROOT, target)).isFile(), `${key} -> ${target} is missing`)
  }
})

test('every runtime file is listed in files so npm pack ships it', () => {
  const manifest = JSON.parse(read('package.json'))
  for (const required of ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg', 'lib/*.js', 'locale/*.json']) {
    assert.ok(manifest.files.includes(required), `${required} is not in files`)
  }
})

test('the client half is declared as a web client module', () => {
  const manifest = JSON.parse(read('package.json'))
  assert.equal(manifest.exports['./client'], './client.js')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.ok(Array.isArray(manifest.dsh.client.inject))
  const text = read('client.js')
  assert.ok(text.includes('window.__ModuleLoader__.load({'))
  assert.ok(text.includes(`id: '${manifest.name}'`))
  assert.ok(text.includes("inject: ['slots']"))
  assert.ok(text.includes('settings.section'))
})

test('the patch row matches the package name and plugin id', () => {
  const manifest = JSON.parse(read('package.json'))
  const patch = parsePatch()
  assert.equal(patch.name, manifest.name)
  assert.equal(patch.id, 'a-hallucination')
  assert.ok(patch.text.includes('promptLocale:'))
})

test('the patch ships a known mode', () => {
  const patch = parsePatch()
  assert.ok(MODE_IDS.includes(patch.mode), `unknown mode ${patch.mode}`)
})

test('both locales carry the display metadata the plugin list reads', () => {
  for (const locale of ['en', 'zh']) {
    const document = JSON.parse(read(`locale/${locale}.json`))
    assert.equal(typeof document.meta.title, 'string')
    assert.ok(document.meta.title.length > 0)
    assert.ok(document.meta.description.length > 20)
    for (const mode of MODE_IDS) assert.equal(typeof document.modes[mode], 'string')
  }
})

test('the description does not promise behaviour the code lacks', () => {
  const manifest = JSON.parse(read('package.json'))
  // The rewrite loop is deliberately not implemented; everything else the
  // description names is wired.
  for (const promise of ['rewrite', 'automatically fixes', 'self-heals']) {
    assert.equal(manifest.description.includes(promise), false, `description promises ${promise}`)
  }
  for (const present of ['ledger', 'contract', 'turn-end']) {
    assert.ok(manifest.description.includes(present), `description omits ${present}`)
  }
})
