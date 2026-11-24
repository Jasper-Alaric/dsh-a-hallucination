/**
 * High-risk ask bookkeeping shared by the answer verifier and the turn-end audit.
 *
 * The gate records one ask per high-risk dispatch ({@link decidePreTool}); the
 * runtime records the human decision as an `approval/asked` + `approval/decided`
 * audit pair. This module joins the two so V8 reports `confirmed: true` only
 * when the call that actually ran was granted.
 */

/**
 * The real high-risk asks recorded for this session and turn, with the approval
 * outcome observed for each one.
 *
 * Only asks whose call really ran need their own confirmation: a rejected ask
 * never produced the execution V8 is looking for. An ask that did run and has no
 * observed grant — no decision yet, or a non-grant outcome — keeps the turn
 * unconfirmed.
 *
 * @param state - plugin state: `confirmations` asks and `approvals` outcomes.
 * @param sessionId - the session whose asks are inspected.
 * @param turn - the turn to report on; `null` means the whole session.
 * @param entries - ledger entries of the turn, read for `call_id` and `ok`.
 * @returns `{required: false}` without asks, otherwise `{required: true, confirmed, tools?}`.
 */
export function confirmationOf(state, sessionId, turn, entries = []) {
  const asks = state.confirmations !== undefined ? state.confirmations.get(sessionId) : []
  const relevant = turn === null || turn === undefined ? asks : asks.filter(item => item.turn === turn)
  if (relevant.length === 0) return { required: false }
  const executed = new Set()
  for (const entry of entries) {
    if (entry !== null && typeof entry === 'object' && entry.ok !== false && typeof entry.call_id === 'string') executed.add(entry.call_id)
  }
  const approvals = state.approvals
  const needing = relevant.filter(ask => typeof ask.call_id !== 'string' || executed.has(ask.call_id))
  const confirmed = needing.every(ask => typeof ask.call_id === 'string'
    ? approvals !== undefined && approvals.allowed(sessionId, ask.call_id)
    : ask.confirmed === true)
  const tools = [...new Set(relevant.map(item => item.tool).filter(name => typeof name === 'string' && name.length > 0))]
  return { required: true, confirmed: needing.length === 0 || confirmed, ...(tools.length > 0 ? { tools } : {}) }
}
