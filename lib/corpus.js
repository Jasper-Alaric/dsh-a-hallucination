/**
 * Per-session observation corpus.
 *
 * The corpus answers one question for the parameter gate — "did this value appear
 * anywhere the runtime observed?" — and nothing else.
 *
 * Two rules keep it honest:
 *
 * 1. It holds only text the runtime saw: user messages and successful tool
 *    output. Tool arguments are the model's own claims, and feeding them back
 *    would let one refused call make its own fabricated target "traceable".
 * 2. User text and tool text have separate budgets, so a long run of large tool
 *    results cannot evict the instructions the user actually gave.
 */

/** Maximum retained characters of tool output per session. */
export const DEFAULT_LIMIT = 120_000

/** Maximum retained characters of user text per session. */
export const USER_LIMIT = 60_000

/** Normalize text so whitespace runs do not hide a match. */
export function normalizeText(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

/**
 * Create one bounded corpus with separate user and tool budgets.
 *
 * @param limit - tool-output budget in characters.
 * @param userLimit - user-text budget in characters.
 * @returns add/has/size accessors that never throw.
 */
export function createCorpus(limit = DEFAULT_LIMIT, userLimit = USER_LIMIT) {
  const toolMax = Number.isFinite(limit) ? Math.max(1, Math.trunc(limit)) : DEFAULT_LIMIT
  const userMax = Number.isFinite(userLimit) ? Math.max(1, Math.trunc(userLimit)) : USER_LIMIT
  let observed = ''
  let instructed = ''

  const append = (current, chunk, max) => {
    const next = current.length === 0 ? chunk : `${current} ${chunk}`
    return next.length > max ? next.slice(next.length - max) : next
  }

  return {
    /**
     * Append one observed chunk.
     *
     * @param chunk - text the runtime saw.
     * @param options - `protect` keeps user-authored text in its own budget.
     */
    add(chunk, options = {}) {
      const normalized = normalizeText(chunk)
      if (normalized.length === 0) return
      if (options.protect === true) instructed = append(instructed, normalized, userMax)
      else observed = append(observed, normalized, toolMax)
    },
    /** Whether a value appears in retained text, ignoring whitespace runs. */
    has(value) {
      const normalized = normalizeText(value)
      if (normalized.length === 0) return false
      return instructed.includes(normalized) || observed.includes(normalized)
    },
    /** One normalized snapshot of everything observed, for the verifier. */
    text() {
      return [instructed, observed].filter(part => part.length > 0).join(' ')
    },
    /** Retained characters across both budgets. */
    size() {
      return instructed.length + observed.length
    },
  }
}

/** Per-session corpus registry with bounded growth. */
export function createCorpusRegistry(limit = DEFAULT_LIMIT, maxSessions = 64) {
  const corpora = new Map()
  const keyOf = sessionId => (typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : '__global__')
  const get = (sessionId) => {
    const key = keyOf(sessionId)
    let corpus = corpora.get(key)
    if (corpus === undefined) {
      corpus = createCorpus(limit)
      corpora.set(key, corpus)
      if (corpora.size > maxSessions) corpora.delete(corpora.keys().next().value)
    }
    return corpus
  }
  return {
    get,
    sessions: () => corpora.size,
    drop(sessionId) {
      corpora.delete(keyOf(sessionId))
    },
  }
}

/** Extract plain text from model message content blocks. */
export function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (typeof block.text === 'string') parts.push(block.text)
    else if (typeof block.content === 'string') parts.push(block.content)
  }
  return parts.join('\n')
}
