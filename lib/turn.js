/**
 * Per-session turn tracker.
 *
 * Two facts the rest of the plugin needs and `tools/result` does not carry: which
 * turn a dispatch belongs to, and what the assistant actually wrote. Both arrive
 * from other publications — the step frame announces the turn, text deltas carry
 * the answer — so they are accumulated here.
 */

/** Maximum retained answer characters per session. */
export const DEFAULT_TEXT_LIMIT = 8000

/**
 * Create one tracker.
 *
 * @param textLimit - maximum characters kept of the current step's answer.
 * @param maxSessions - maximum tracked sessions before the oldest is dropped.
 * @returns begin/append/textOf/turnOf/drop, none of which throw.
 */
export function createTurnTracker(textLimit = DEFAULT_TEXT_LIMIT, maxSessions = 64) {
  const limit = Number.isFinite(textLimit) ? Math.max(1, Math.trunc(textLimit)) : DEFAULT_TEXT_LIMIT
  const sessions = new Map()
  const keyOf = sessionId => (typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : '__global__')
  const get = (sessionId) => {
    const key = keyOf(sessionId)
    let entry = sessions.get(key)
    if (entry === undefined) {
      entry = { turn: null, text: '' }
      sessions.set(key, entry)
      if (sessions.size > maxSessions) sessions.delete(sessions.keys().next().value)
    }
    return entry
  }
  return {
    /** Start a new step: remember its turn and clear the accumulated answer. */
    begin(sessionId, turn) {
      const entry = get(sessionId)
      entry.turn = Number.isFinite(turn) ? turn : entry.turn
      entry.text = ''
    },
    /** Append one text delta of the current step. */
    append(sessionId, chunk) {
      if (typeof chunk !== 'string' || chunk.length === 0) return
      const entry = get(sessionId)
      const next = entry.text + chunk
      entry.text = next.length > limit ? next.slice(next.length - limit) : next
    },
    /** The accumulated answer of the current step. */
    textOf(sessionId) {
      return get(sessionId).text
    },
    /** The turn the current step belongs to. */
    turnOf(sessionId) {
      return get(sessionId).turn
    },
    /** Retained sessions, for diagnostics. */
    sessions() {
      return sessions.size
    },
    drop(sessionId) {
      sessions.delete(keyOf(sessionId))
    },
  }
}

/** Bounded per-session verdict registry. */
export function createVerdictRegistry(maxSessions = 64) {
  const verdicts = new Map()
  const keyOf = sessionId => (typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : '__global__')
  return {
    set(sessionId, verdict) {
      const key = keyOf(sessionId)
      verdicts.set(key, verdict)
      if (verdicts.size > maxSessions) verdicts.delete(verdicts.keys().next().value)
    },
    get(sessionId) {
      return verdicts.get(keyOf(sessionId))
    },
    drop(sessionId) {
      verdicts.delete(keyOf(sessionId))
    },
  }
}
