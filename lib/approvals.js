/**
 * Approval audit registry.
 *
 * The runtime appends one `approval/asked` + `approval/decided` pair to the
 * session log for every human decision (see
 * `packages/interaction/user-approval/src/types.ts`). This registry pairs the
 * two events by request id and keeps the resulting `callId -> outcome` link, so
 * V8 can tell "the user approved this call" from "nobody was ever asked".
 *
 * Only `allowed-once` grants the action; `rejected`, `cancelled`, and
 * `unavailable` are all non-grants. Both maps are bounded per session, and the
 * number of retained sessions is capped, so a long session cannot grow without
 * limit.
 */

/** Approval outcomes that grant the requested action. */
const GRANTED = Object.freeze(new Set(['allowed-once']))

/** Read a string field from an unknown record. */
function field(source, key) {
  if (source === null || typeof source !== 'object') return ''
  const value = source[key]
  return typeof value === 'string' ? value : ''
}

/**
 * Create one bounded registry.
 *
 * @param maxPerSession - maximum pending requests and retained outcomes per session.
 * @param maxSessions - maximum retained sessions.
 * @returns asked/decided/allowed/outcomeOf/drop, none of which throw.
 */
export function createApprovalRegistry(maxPerSession = 200, maxSessions = 64) {
  const sessions = new Map()
  const keyOf = sessionId => (typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : '__global__')

  /** Existing session state, without creating one for a read. */
  const peek = (sessionId) => sessions.get(keyOf(sessionId))

  /** Existing or fresh session state. */
  const get = (sessionId) => {
    const key = keyOf(sessionId)
    let entry = sessions.get(key)
    if (entry === undefined) {
      entry = { pending: new Map(), outcomes: new Map() }
      sessions.set(key, entry)
      if (sessions.size > maxSessions) sessions.delete(sessions.keys().next().value)
    }
    return entry
  }

  return {
    /**
     * Remember one `approval/asked` request until its decision arrives.
     *
     * @param sessionId - the session the audit pair belongs to.
     * @param data - the `approval/asked` payload: id, toolName, callId.
     */
    asked(sessionId, data) {
      const id = field(data, 'id')
      if (id.length === 0) return
      const entry = get(sessionId)
      entry.pending.set(id, {
        call_id: field(data, 'callId'),
        tool: field(data, 'toolName'),
        at: new Date().toISOString(),
      })
      if (entry.pending.size > maxPerSession) entry.pending.delete(entry.pending.keys().next().value)
    },
    /**
     * Resolve one `approval/decided` against its pending request.
     *
     * @param sessionId - the session the audit pair belongs to.
     * @param data - the `approval/decided` payload: id and outcome.
     * @returns whether the decision matched a recorded ask.
     */
    decided(sessionId, data) {
      const id = field(data, 'id')
      const outcome = field(data, 'outcome')
      if (id.length === 0 || outcome.length === 0) return false
      const entry = peek(sessionId)
      if (entry === undefined) return false
      const asked = entry.pending.get(id)
      if (asked === undefined) return false
      entry.pending.delete(id)
      if (asked.call_id.length === 0) return true
      entry.outcomes.set(asked.call_id, outcome)
      if (entry.outcomes.size > maxPerSession) entry.outcomes.delete(entry.outcomes.keys().next().value)
      return true
    },
    /**
     * Whether a call id carries an observed grant.
     *
     * @param sessionId - the session that owns the call.
     * @param callId - the tool call id the ask named.
     * @returns true only for an observed `allowed-once`.
     */
    allowed(sessionId, callId) {
      const entry = peek(sessionId)
      if (entry === undefined || typeof callId !== 'string' || callId.length === 0) return false
      return GRANTED.has(entry.outcomes.get(callId))
    },
    /**
     * The observed outcome for one call, for diagnostics.
     *
     * @param sessionId - the session that owns the call.
     * @param callId - the tool call id the ask named.
     * @returns the recorded outcome, or undefined when none was observed.
     */
    outcomeOf(sessionId, callId) {
      const entry = peek(sessionId)
      if (entry === undefined || typeof callId !== 'string') return undefined
      return entry.outcomes.get(callId)
    },
    /** Drop one session's approval state. */
    drop(sessionId) {
      sessions.delete(keyOf(sessionId))
    },
    /** Retained sessions, for diagnostics. */
    sessions() {
      return sessions.size
    },
  }
}
