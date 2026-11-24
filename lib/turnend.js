/**
 * Turn-end verification.
 *
 * The runtime knows two things at the end of a turn: what the assistant wrote and
 * which calls actually succeeded. That is enough to audit completion language —
 * "已执行" with no successful execution call is caught — and not enough to audit
 * claims the model never structured. The verdict therefore reports which
 * invariants it could not check instead of implying a clean bill of health.
 */

import { validateAnswer } from './validator.js'

/** Unique tool names of one turn's ledger entries. */
function toolNamesOf(entries) {
  const names = new Set()
  for (const entry of entries) {
    if (entry !== null && typeof entry === 'object' && typeof entry.source === 'string') names.add(entry.source)
  }
  return [...names]
}

/**
 * Build the answer document the verifier accepts from runtime observations.
 *
 * `claims` and `facts` stay empty because the model never structured them; the
 * verifier reports those invariants as unchecked rather than passing them.
 *
 * @param text - the assistant's answer for this turn.
 * @param entries - ledger entries recorded during this turn.
 * @returns a §8-shaped document.
 */
export function buildTurnDocument(text, entries) {
  const evidence = []
  const toolCalls = []
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue
    evidence.push({
      id: entry.id,
      source_type: 'tool',
      source: entry.source,
      excerpt: entry.excerpt,
      verbatim: entry.verbatim === true,
    })
    toolCalls.push({ tool: entry.source, params: {}, status: entry.status })
  }
  return {
    answer: typeof text === 'string' ? text : '',
    claims: [],
    evidence,
    conflicts: [],
    tool_calls: toolCalls,
    action_confirmation: { required: false },
    uncertainties: [],
    facts: [],
  }
}

/**
 * Verify one turn.
 *
 * @param text - the assistant's answer for this turn.
 * @param entries - ledger entries recorded during this turn.
 * @returns the verdict plus the counts that produced it.
 */
export function verifyTurn(text, entries) {
  const document = buildTurnDocument(text, entries)
  const result = validateAnswer(document, { toolNames: toolNamesOf(entries), sources: {}, traceable: [] })
  return {
    ...result,
    answerChars: document.answer.length,
    evidenceCount: document.evidence.length,
    callCount: document.tool_calls.length,
  }
}
