/**
 * Per-session evidence ledger.
 *
 * The ledger is the plugin's single source of fact: entries are written only by a
 * real tool dispatch observer, so a model cannot fabricate one. Every entry keeps
 * the fields the design document requires (source, time, locator, excerpt,
 * verbatim, granularity, trust) plus enough state to answer "did this call
 * actually succeed".
 */

import { IDENTIFYING_KEYS } from './gate.js'

/** Maximum retained entries per session; the oldest are evicted first. */
export const MAX_ENTRIES = 200

/** Maximum retained display text per entry; longer text degrades to an excerpt.
 *
 * Kept small on purpose: `content` and `excerpt` feed listings, while the
 * untruncated evidence copy lives in `full` and is capped separately.
 */
export const MAX_CONTENT = 1600

/** Maximum excerpt length handed back to a reader. */
export const MAX_EXCERPT = 1200

/** Maximum full result text kept for evidence comparison.
 *
 * The excerpt and `content` stay small; `full` exists so a verbatim quote after
 * the 1600th character can still be checked, and it lives only in memory.
 */
export const MAX_FULL = 8000

/** Slice by code points so surrogate pairs are never split. */
function sliceChars(text, max) {
  if (typeof text !== 'string') return ''
  if (text.length <= max) return text
  const chars = Array.from(text)
  if (chars.length <= max) return text
  return chars.slice(0, max).join('')
}

/** Read a string field from an unknown record. */
function field(source, key) {
  if (source === null || typeof source !== 'object') return ''
  const value = source[key]
  return typeof value === 'string' ? value : ''
}

/**
 * Keep only the identifying leaves of one call's arguments.
 *
 * V9 reads this back, and a write or subagent payload can be megabytes of text
 * that can never have an earlier origin, so payloads are dropped here rather
 * than retained for the life of the session. `keys` carries the configured
 * `traceableParams` additions, so a key the gate checks is also retained here.
 */
function identifyingArgs(value, keys = IDENTIFYING_KEYS) {
  const wanted = new Set(keys)
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk)
    if (node === null || typeof node !== 'object') return undefined
    const kept = {}
    for (const [key, item] of Object.entries(node)) {
      if (wanted.has(key)) kept[key] = item
      else if (item !== null && typeof item === 'object') {
        const nested = walk(item)
        if (nested !== undefined && Object.keys(nested).length > 0) kept[key] = nested
      }
    }
    return kept
  }
  const kept = walk(value)
  return kept !== undefined && Object.keys(kept).length > 0 ? kept : null
}

/**
 * Best-effort locator for a call: a path or URL when the arguments carry one,
 * otherwise the tool name plus a short call id.
 */
function locatorOf(name, args, callId) {
  const path = field(args, 'path')
  if (path.length > 0) return path
  const url = field(args, 'url')
  if (url.length > 0) return url
  const file = field(args, 'file_path')
  if (file.length > 0) return file
  const short = typeof callId === 'string' ? callId.slice(0, 8) : ''
  return short.length > 0 ? `${name}#${short}` : name
}

/**
 * Create one ledger.
 *
 * @param options - optional overrides for the entry and content caps.
 * @returns a ledger whose methods never throw on malformed input.
 */
export function createLedger(options = {}) {
  const maxEntries = Number.isFinite(options.maxEntries) ? Math.max(1, Math.trunc(options.maxEntries)) : MAX_ENTRIES
  const maxContent = Number.isFinite(options.maxContent) ? Math.max(1, Math.trunc(options.maxContent)) : MAX_CONTENT
  const maxFull = Number.isFinite(options.maxFull) ? Math.max(1, Math.trunc(options.maxFull)) : MAX_FULL
  const identifyingKeys = Array.isArray(options.identifyingKeys) && options.identifyingKeys.length > 0
    ? options.identifyingKeys.filter(key => typeof key === 'string')
    : IDENTIFYING_KEYS
  const entries = []
  let nextId = 1

  /**
   * Record one dispatch outcome.
   *
   * @param input - tool name, call id, content text, and the raw error flag.
   * @returns the stored entry, or undefined when the name is missing.
   */
  function record(input) {
    const name = field(input, 'name')
    if (name.length === 0) return undefined
    const raw = typeof input.contentText === 'string' ? input.contentText : ''
    const truncated = raw.length > maxContent
    const content = truncated ? sliceChars(raw, maxContent) : raw
    const excerpt = sliceChars(content, MAX_EXCERPT)
    const full = sliceChars(raw, maxFull)
    const isError = input.isError === true
    const entry = {
      id: `E${nextId}`,
      source_type: 'tool',
      source: name,
      status: isError ? 'error' : content.trim().length === 0 ? 'empty' : 'success',
      // `ok` is the completion signal: a silent success (pwsh/rm/mkdir) still
      // counts as executed even though its status is `empty`.
      ok: !isError,
      retrieved_at: typeof input.retrievedAt === 'string' ? input.retrievedAt : new Date().toISOString(),
      as_of: field(input, 'asOf') || null,
      locator: locatorOf(name, input.args, input.callId),
      excerpt,
      verbatim: excerpt.length > 0,
      granularity: truncated ? 'excerpt' : 'full',
      trust: field(input, 'trust') || 'high',
      content,
      full,
      full_chars: raw.length,
      full_truncated: raw.length > maxFull,
      args: identifyingArgs(input.args, identifyingKeys),
      chars: content.length,
      call_id: field(input, 'callId') || null,
      turn: Number.isFinite(input.turn) ? input.turn : null,
    }
    nextId += 1
    entries.push(entry)
    if (entries.length > maxEntries) entries.splice(0, entries.length - maxEntries)
    return entry
  }

  /** Copy of the retained entries, oldest first. */
  function list() {
    return entries.slice()
  }

  /** Whether the excerpt is still a continuous substring of the stored content. */
  function verifies(entry) {
    if (entry === null || typeof entry !== 'object') return false
    const excerpt = field(entry, 'excerpt')
    const content = field(entry, 'content')
    return excerpt.length > 0 && content.includes(excerpt)
  }

  /** Compact summary for a status or list answer. */
  function summary() {
    const byStatus = { success: 0, error: 0, empty: 0 }
    for (const entry of entries) {
      if (entry.status in byStatus) byStatus[entry.status] += 1
    }
    return { total: entries.length, byStatus, maxEntries }
  }

  return { record, list, verifies, summary, count: () => entries.length }
}

/** Per-session ledger registry with bounded growth. */
export function createLedgerRegistry(options = {}, maxSessions = 64) {
  const ledgers = new Map()
  const keyOf = sessionId => (typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : '__global__')
  const get = (sessionId) => {
    const key = keyOf(sessionId)
    let ledger = ledgers.get(key)
    if (ledger === undefined) {
      ledger = createLedger(options)
      ledgers.set(key, ledger)
      if (ledgers.size > maxSessions) ledgers.delete(ledgers.keys().next().value)
    }
    return ledger
  }
  return {
    get,
    drop(sessionId) {
      ledgers.delete(keyOf(sessionId))
    },
    keys: () => [...ledgers.keys()],
    sessions: () => ledgers.size,
    total: () => [...ledgers.values()].reduce((sum, ledger) => sum + ledger.count(), 0),
  }
}
