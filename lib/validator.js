/**
 * Answer verifier for the design document's §9 invariants.
 *
 * The verifier is a pure function over one answer document plus the context the
 * runtime actually observed (real tool call names, real source texts, traceable
 * values). It never decides whether a claim is true; it decides whether the claim
 * is backed by evidence the runtime can see. Anything it cannot check is reported
 * as unverifiable rather than silently passing.
 */

import { IDENTIFYING_KEYS, normalizeToolName } from './gate.js'

/** Whether a claim status carries a fact obligation. */
const EVIDENCE_OBLIGATION = new Set(['verified', 'derived'])

/** Completion-tense words that assert a finished action. A bare 已完成 counts
 * only next to an execution verb ({@link executionIn}); a bare 已确认 is a
 * reasoning phrase unless it introduces an execution verb
 * ({@link confirmedExecutionIn}). */
const COMPLETION_TERMS = Object.freeze(['已查询', '已执行', '已核实', '已验证', '已检查', '已获取', 'already checked', 'has been verified', 'have executed'])

/** Completion-tense words that name an irreversible or outward-facing action. */
const EXECUTION_TERMS = Object.freeze([
  '已执行', '已发布', '已删除', '已发送', '已推送', '已部署', '已安装', '已迁移', '已写入', '已修改', '已清理', '已上传', '已下单', '已支付',
  'have executed', 'have published', 'have deleted', 'have sent', 'have pushed', 'have deployed', 'have installed', 'have uploaded',
  'already executed', 'already published', 'already deleted', 'already sent', 'already pushed', 'already deployed', 'already installed', 'already uploaded',
])

/** Verbs that turn a bare 已完成 into an execution claim. */
const EXECUTION_VERBS = Object.freeze(['迁移', '清理', '部署', '安装', '修改', '写入', '删除', '发送', '发布', '推送', '上传', '下单', '支付', '覆盖', '卸载'])

/** Words that explicitly mark an uncertainty in the answer text. */
const UNCERTAINTY_TERMS = Object.freeze(['不确定', '无法确认', '未验证', '未能', '尚未', '推断', '无法核实', 'unknown', 'unverified', 'cannot confirm', 'inferred', 'presumably'])

/** Tool-name fragments that identify an execution action rather than a read. */
const EXECUTION_HINTS = /(^|[_.])(write|edit|delete|remove|send|publish|push|pay|deploy|install|kill|uninstall|exec|run|shell|terminal|pwsh|bash)([_.]|$)/

/** Source types the runtime may vouch for. Anything else is unverified. */
const SOURCE_TYPES = new Set(['tool', 'user', 'model_common', 'web', 'file', 'document', 'memory'])

/** Words that negate a completion claim. */
const NEGATION = /(未|没有|没|无法|不能|尚未|不曾|未经|not\b|n't\b|cannot|never|unable)/i

/** Normalize text for containment comparisons. */
function normalize(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, '') : ''
}

/** Key tokens a shortened claim must keep to stand in for a longer fact. */
function keyTokens(text) {
  return text.match(/\d+(?:[.:]\d+)*|[A-Za-z][A-Za-z0-9._-]*/g) ?? []
}

/**
 * Whether one claim sentence covers one extracted fact.
 *
 * A whole fact inside the claim always covers it. A claim inside the fact only
 * covers it when the claim keeps most of the sentence and every number or
 * Latin entity: "服务器返回" must not cover "服务器返回 500 错误".
 */
function coversFact(claim, fact) {
  if (claim.length === 0) return false
  if (claim.includes(fact)) return true
  if (!fact.includes(claim)) return false
  if (claim.length < Math.ceil(fact.length * 0.7)) return false
  return keyTokens(fact).every(token => claim.includes(token))
}

/** Read an array field defensively. */
function listOf(source, key) {
  if (source === null || typeof source !== 'object') return []
  return Array.isArray(source[key]) ? source[key] : []
}

/** Read a string field defensively. */
function stringOf(source, key) {
  if (source === null || typeof source !== 'object') return ''
  return typeof source[key] === 'string' ? source[key] : ''
}

/** Whether one recorded call completed successfully.
 *
 * `ok` is the authoritative signal because a silent success (pwsh, rm, mkdir)
 * is stored with status `empty`; older documents without `ok` fall back to the
 * status spelling.
 */
function callOk(call) {
  if (call === null || typeof call !== 'object') return false
  if (typeof call.ok === 'boolean') return call.ok
  return stringOf(call, 'status') === 'success'
}

/** Every identifying value of a params object, normalized and long enough to matter.
 *
 * Only declared identifying keys are checked: a body written for this call
 * (`content`, `new_string`) can never have an earlier origin, and flagging it
 * would fail every ordinary write. `keys` lets the caller add configured
 * `traceableParams`, so the pre-dispatch gate and V9 apply the same list.
 */
function identifyingValues(params, keys = IDENTIFYING_KEYS) {
  const wanted = new Set(keys)
  const values = []
  const walk = (value, key) => {
    if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) {
      const normalized = normalize(String(value))
      if (wanted.has(key) && normalized.length >= 2) values.push({ raw: String(value), normalized })
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, key)
      return
    }
    if (value !== null && typeof value === 'object') {
      for (const [childKey, item] of Object.entries(value)) walk(item, childKey)
    }
  }
  walk(params, '')
  return values
}

/**
 * Whether every occurrence of a term is negated.
 *
 * The contract tells the model to write "cannot confirm whether X was deleted";
 * that sentence must not count as a claim that it deleted something. Splitting
 * at clause boundaries keeps "已删除文件，未删除备份" honest: the first clause
 * states a completed deletion, and only the second one is negated.
 */
function negatedCompletion(text, term) {
  const clauses = text.split(/[。！？\n.!?，,；;：:]+/)
  let found = false
  for (const clause of clauses) {
    if (!clause.includes(term)) continue
    found = true
    if (!NEGATION.test(clause)) return false
  }
  return found
}

/**
 * Whether 已确认 introduces a finished execution, e.g. 已确认删除 / 已确认发布.
 *
 * A bare 已确认 is a reasoning phrase ("已确认这条推理自洽"), so only the clause
 * that follows it counts, and only when that clause names an execution verb.
 */
function confirmedExecutionIn(answer) {
  let index = answer.indexOf('已确认')
  while (index !== -1) {
    const rest = answer.slice(index + 3)
    const end = rest.search(/[。！？\n.!?，,；;：:]/)
    const clause = (end === -1 ? rest : rest.slice(0, end)).trim()
    if (clause.length > 0 && !NEGATION.test(clause) && EXECUTION_VERBS.some(verb => clause.includes(verb))) return true
    index = answer.indexOf('已确认', index + 3)
  }
  return false
}

/** Whether the answer text states a completion that needs a real call behind it.
 *
 * "分析已完成" and "已确认这条推理自洽" are pure-reasoning sentences, so a bare
 * 已完成/已确认 counts only when it names an execution verb.
 */
function completionIn(answer) {
  if (executionIn(answer)) return true
  const lowered = answer.toLowerCase()
  return COMPLETION_TERMS.some(term => {
    if (term.charCodeAt(0) > 127) return answer.includes(term) && !negatedCompletion(answer, term)
    const lower = term.toLowerCase()
    return lowered.includes(lower) && !negatedCompletion(lowered, lower)
  })
}

/**
 * Whether the answer claims an execution finished.
 *
 * A bare 已完成 is ambiguous ("analysis finished" is not an execution), so it
 * counts only next to an execution verb; 已确认 follows the same rule.
 */
function executionIn(answer) {
  const lowered = answer.toLowerCase()
  const explicit = EXECUTION_TERMS.some(term => {
    if (term.charCodeAt(0) > 127) return answer.includes(term) && !negatedCompletion(answer, term)
    const lower = term.toLowerCase()
    return lowered.includes(lower) && !negatedCompletion(lowered, lower)
  })
  if (explicit) return true
  if (confirmedExecutionIn(answer)) return true
  const index = answer.indexOf('已完成')
  if (index === -1) return false
  const window = answer.slice(Math.max(0, index - 12), index + 12)
  if (NEGATION.test(window)) return false
  return EXECUTION_VERBS.some(verb => window.includes(verb))
}

/** Whether the answer text states an uncertainty. */
function uncertaintyIn(answer) {
  const lowered = answer.toLowerCase()
  return UNCERTAINTY_TERMS.some(term => (term.charCodeAt(0) > 127 ? answer.includes(term) : lowered.includes(term.toLowerCase())))
}

/** One-line description of every invariant, for docs and the settings panel. */
export const INVARIANTS = Object.freeze([
  { code: 'V1', text: 'Every extracted factual sentence is covered by a claim.' },
  { code: 'V2', text: 'A verified or derived claim cites at least one existing evidence id.' },
  { code: 'V3', text: 'A verbatim excerpt is a substring of its provided source text.' },
  { code: 'V4', text: 'An evidence source is a real tool call, the user, or model_common.' },
  { code: 'V5', text: 'A completion-tense sentence has a successful tool call behind it.' },
  { code: 'V6', text: 'A finished execution claim has a successful execution call behind it.' },
  { code: 'V7', text: 'Low confidence, unknown, or an unresolved conflict is stated as uncertainty.' },
  { code: 'V8', text: 'An unconfirmed high-risk action has no execution call.' },
  { code: 'V9', text: 'Every string tool parameter value is traceable to observed context.' },
  { code: 'V10', text: 'Any failure downgrades the answer instead of passing it.' },
  { code: 'V11', text: 'A time-sensitive claim cites evidence no older than maxEvidenceAgeHours.' },
])

/**
 * Normalize provided source texts.
 *
 * Two forms are accepted: a plain array of strings (unkeyed — an excerpt may
 * match any of them) and id-keyed sources (`{id, text}` entries or a map), where
 * an evidence item must cite the exact source it came from.
 */
function sourceMap(sources) {
  const map = new Map()
  let keyed = false
  if (Array.isArray(sources)) {
    for (const item of sources) {
      if (typeof item === 'string') {
        map.set(`#${map.size}`, item)
        continue
      }
      if (item !== null && typeof item === 'object' && typeof item.id === 'string' && typeof item.text === 'string') {
        map.set(item.id, item.text)
        keyed = true
      }
    }
    return { map, keyed }
  }
  if (sources !== null && typeof sources === 'object') {
    for (const [id, text] of Object.entries(sources)) {
      if (typeof text === 'string') {
        map.set(id, text)
        keyed = true
      }
    }
  }
  return { map, keyed }
}

/** Parse an ISO 8601 timestamp that names its zone.
 *
 * A value without `Z` or an explicit offset is rejected instead of being read in
 * the host timezone, which silently shifted ages by the local offset.
 */
function parseTimestamp(value) {
  if (typeof value !== 'string') return Number.NaN
  const text = value.trim()
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/.test(text)) return Number.NaN
  return Date.parse(text)
}

/**
 * Verify one answer document.
 *
 * @param doc - the §8 answer JSON: answer, claims, evidence, conflicts, tool_calls,
 *   action_confirmation, uncertainties, and optionally extracted `facts`.
 * @param context - observed runtime facts: `toolNames`, `sources`, `traceable`.
 * @returns a verdict with per-invariant failures and counts.
 */
export function validateAnswer(doc, context = {}) {
  const failures = []
  const add = (code, message, detail) => failures.push({ code, message, detail })

  const answer = stringOf(doc, 'answer')
  const claims = listOf(doc, 'claims')
  const evidence = listOf(doc, 'evidence')
  const toolCalls = listOf(doc, 'tool_calls')
  const conflicts = listOf(doc, 'conflicts')
  const uncertainties = listOf(doc, 'uncertainties')
  const facts = listOf(doc, 'facts')
  const confirmation = doc !== null && typeof doc === 'object' ? doc.action_confirmation : undefined
  const toolNames = new Set(listOf(context, 'toolNames').filter(name => typeof name === 'string'))
  const sources = context !== null && typeof context === 'object' ? context.sources : undefined
  const sourceInfo = sourceMap(sources)
  const traceable = listOf(context, 'traceable').filter(text => typeof text === 'string').map(normalize).filter(text => text.length > 0)

  const evidenceIds = new Set()
  const evidenceById = new Map()
  for (const item of evidence) {
    const id = stringOf(item, 'id')
    if (id.length === 0) continue
    evidenceIds.add(id)
    evidenceById.set(id, item)
  }

  // V1 — every extracted factual sentence is covered by a claim.
  if (facts.length > 0) {
    const claimTexts = claims.map(claim => normalize(stringOf(claim, 'claim'))).filter(text => text.length > 0)
    for (const fact of facts) {
      const normalized = normalize(fact)
      if (normalized.length === 0) continue
      const covered = claimTexts.some(text => coversFact(text, normalized))
      if (!covered) add('V1', 'factual sentence is not covered by any claim', fact)
    }
  }

  // V2 — verified and derived claims cite existing evidence.
  for (const claim of claims) {
    const status = stringOf(claim, 'status')
    if (!EVIDENCE_OBLIGATION.has(status)) continue
    const ids = listOf(claim, 'evidence_ids').filter(id => typeof id === 'string')
    if (ids.length === 0) {
      add('V2', `${status} claim cites no evidence`, stringOf(claim, 'id') || stringOf(claim, 'claim'))
      continue
    }
    for (const id of ids) {
      if (!evidenceIds.has(id)) add('V2', `${status} claim cites missing evidence ${id}`, stringOf(claim, 'id'))
    }
  }

  // V3 — a verified or derived claim must quote the evidence it cites. When the
  // cited id does not exist at all, V2 already reports that; saying "no quote"
  // here would accuse the caller of omitting something it actually supplied.
  for (const claim of claims) {
    const status = stringOf(claim, 'status')
    if (!EVIDENCE_OBLIGATION.has(status)) continue
    const ids = listOf(claim, 'evidence_ids').filter(id => typeof id === 'string')
    const resolved = ids.filter(id => evidenceById.get(id) !== undefined)
    const allMissing = ids.length > 0 && resolved.length === 0
    if (allMissing) continue
    const quoted = resolved.some((id) => {
      const item = evidenceById.get(id)
      return item !== undefined && stringOf(item, 'excerpt').trim().length > 0
    })
    if (!quoted) {
      add('V3', ids.length === 0 ? `${status} claim cites no evidence to quote` : `${status} claim has no quote`, stringOf(claim, 'id') || stringOf(claim, 'claim'))
    }
  }

  // V3 — verbatim excerpts exist in the source they cite.
  let unverifiable = 0
  const { map: sourceTexts, keyed } = sourceInfo
  const sourceCoverage = context !== null && typeof context === 'object' && context.sourceCoverage !== null && typeof context.sourceCoverage === 'object'
    ? context.sourceCoverage
    : {}
  const coverageNote = (id) => {
    const info = sourceCoverage[id]
    if (info === null || typeof info !== 'object') return ''
    if (!Number.isFinite(info.covered) || !Number.isFinite(info.total) || info.total <= info.covered) return ''
    return ` (evidence only covers the first ${info.covered} of ${info.total} characters)`
  }
  for (const item of evidence) {
    if (item === null || typeof item !== 'object' || item.verbatim !== true) continue
    const excerpt = normalize(stringOf(item, 'excerpt'))
    if (excerpt.length === 0) continue
    if (sourceTexts.size === 0) {
      unverifiable += 1
      continue
    }
    const id = stringOf(item, 'id')
    const sourceId = stringOf(item, 'source_id')
    // Coverage is recorded per ledger entry, while an evidence item may be a
    // per-claim view of that entry, so the note follows `source_id`.
    const coverageId = sourceId.length > 0 ? sourceId : id
    if (sourceId.length > 0) {
      const text = sourceTexts.get(sourceId)
      if (text === undefined) {
        add('V3', `evidence cites unknown source "${sourceId}"`, id)
      } else if (!normalize(text).includes(excerpt)) {
        add('V3', `verbatim excerpt is not in the cited source "${sourceId}"${coverageNote(coverageId)}`, id)
      }
      continue
    }
    if (keyed) {
      add('V3', 'keyed sources require evidence.source_id', id)
      continue
    }
    if (![...sourceTexts.values()].some(text => normalize(text).includes(excerpt))) {
      add('V3', `verbatim excerpt is not a substring of any provided source${coverageNote(coverageId)}`, id)
    }
  }

  // V4 — evidence sources are real.
  for (const item of evidence) {
    const sourceType = stringOf(item, 'source_type')
    const source = stringOf(item, 'source')
    const id = stringOf(item, 'id')
    if (!SOURCE_TYPES.has(sourceType)) {
      add('V4', `evidence source_type "${sourceType}" is not a type the runtime can vouch for`, id)
      continue
    }
    if (source.length === 0) {
      add('V4', 'evidence has no source', id)
      continue
    }
    if (sourceType === 'tool' && !toolNames.has(source)) {
      add('V4', `evidence cites tool "${source}", which did not run`, id)
    }
  }

  // V5 / V6 — completion tense needs a successful call behind it.
  const completions = completionIn(answer)
  const successCalls = toolCalls.filter(callOk)
  if (completions && successCalls.length === 0) {
    add('V5', 'the answer uses completion tense without a successful tool call')
  }
  if (completions) {
    const executionSuccess = successCalls.some(call => EXECUTION_HINTS.test(normalizeToolName(stringOf(call, 'tool'))))
    const executionClaimed = executionIn(answer)
    if (executionClaimed && !executionSuccess) add('V6', 'a finished execution claim has no successful execution call')
  }

  // V7 — degraded confidence must be stated.
  const resolvedStates = new Set(['resolved', 'accepted', 'no-conflict'])
  const unresolvedConflict = conflicts.some(item => item !== null && typeof item === 'object' && !resolvedStates.has(stringOf(item, 'resolution')))
  const degradedClaim = claims.some(claim => {
    const status = stringOf(claim, 'status')
    return status === 'unknown' || stringOf(claim, 'confidence') === 'low'
  })
  if ((degradedClaim || unresolvedConflict || uncertainties.length > 0) && !uncertaintyIn(answer)) {
    add('V7', 'degraded confidence, unknown, or an unresolved conflict is not stated as uncertainty')
  }

  // V8 — an unconfirmed high-risk action must not have run.
  if (confirmation !== null && typeof confirmation === 'object' && confirmation.required === true && confirmation.confirmed !== true) {
    const askedTools = Array.isArray(confirmation.tools)
      ? confirmation.tools.filter(tool => typeof tool === 'string')
      : []
    const ran = toolCalls.some((call) => {
      if (!callOk(call)) return false
      const tool = stringOf(call, 'tool')
      if (askedTools.length > 0 && !askedTools.includes(tool)) return false
      return EXECUTION_HINTS.test(normalizeToolName(tool))
    })
    if (ran) add('V8', 'an unconfirmed high-risk action was executed')
  }

  // V9 — every identifying tool parameter traces back to observed context.
  if (traceable.length > 0) {
    const identifyingKeys = Array.isArray(context !== null && typeof context === 'object' ? context.identifyingKeys : undefined)
      ? context.identifyingKeys.filter(key => typeof key === 'string')
      : IDENTIFYING_KEYS
    for (const call of toolCalls) {
      for (const value of identifyingValues(call !== null && typeof call === 'object' ? call.params : undefined, identifyingKeys)) {
        const found = traceable.some(text => text.includes(value.normalized))
        if (!found) add('V9', `parameter "${value.raw}" is not traceable to observed context`, stringOf(call, 'tool'))
      }
    }
  }

  // V11 — a time-sensitive claim must cite evidence that is recent enough.
  const maxAgeHours = context !== null && typeof context === 'object' && Number.isFinite(context.maxAgeHours) ? context.maxAgeHours : 24
  for (const claim of claims) {
    if (claim === null || typeof claim !== 'object' || claim.time_sensitive !== true) continue
    const status = stringOf(claim, 'status')
    if (!EVIDENCE_OBLIGATION.has(status)) continue
    for (const id of listOf(claim, 'evidence_ids').filter(text => typeof text === 'string')) {
      const item = evidenceById.get(id)
      if (item === undefined) continue
      const asOf = stringOf(item, 'as_of')
      if (asOf.length === 0) {
        add('V11', 'time-sensitive claim cites evidence with no as_of timestamp', id)
        continue
      }
      const at = parseTimestamp(asOf)
      if (!Number.isFinite(at)) {
        add('V11', `evidence as_of "${asOf}" cannot be parsed as ISO 8601 with Z or an explicit offset`, id)
        continue
      }
      const ageHours = (Date.now() - at) / 3600000
      if (ageHours > maxAgeHours) {
        add('V11', `time-sensitive claim cites evidence ${ageHours.toFixed(1)}h old (limit ${maxAgeHours}h)`, id)
      }
    }
  }

  const passed = failures.length === 0
  // L3 — verification level: how much scrutiny this answer deserved. Strict
  // means the answer actually quoted a verbatim source, not merely that it
  // cited an id.
  const quotedEvidence = evidence.some(item => item !== null && typeof item === 'object'
    && item.verbatim === true
    && stringOf(item, 'excerpt').trim().length > 0)
  const timeSensitive = claims.some(claim => claim !== null && typeof claim === 'object' && claim.time_sensitive === true)
  const level = timeSensitive || quotedEvidence
    ? 'strict'
    : successCalls.length > 0
      ? 'standard'
      : 'light'
  // A check that already failed cannot also be "not checked": keep the two
  // lists disjoint so the verdict never contradicts itself.
  const failedNow = new Set(failures.map(item => item.code))
  const unchecked = []
  if (facts.length === 0) unchecked.push('V1')
  if (!quotedEvidence) unchecked.push('V3')
  if (traceable.length === 0) unchecked.push('V9')
  const uncheckedOnly = unchecked.filter(code => !failedNow.has(code))
  return {
    passed,
    verdict: !passed ? 'downgrade' : uncheckedOnly.length > 0 ? 'partial' : 'pass',
    failedCodes: [...new Set(failures.map(item => item.code))],
    failures,
    unchecked: uncheckedOnly,
    stats: {
      level,
      claims: claims.length,
      evidence: evidence.length,
      facts: facts.length,
      toolCalls: toolCalls.length,
      unverifiable,
    },
    downgradeTo: passed ? null : 'abstain',
  }
}

/** Render a verdict for a tool result or a status notice. */
export function formatVerdict(result) {
  const stats = result !== null && typeof result === 'object' && result.stats !== null && typeof result.stats === 'object' ? result.stats : {}
  const failed = Array.isArray(result?.failedCodes) ? result.failedCodes : []
  const unchecked = Array.isArray(result?.unchecked) ? result.unchecked : []
  const headline = result?.passed !== true
    ? `verify: FAIL → downgrade to ${String(result?.downgradeTo)} (${failed.join(', ')})`
    : result.verdict === 'partial'
      ? `verify: PARTIAL (${unchecked.join(', ')} had no input to check)`
      : 'verify: PASS (all checked invariants hold)'
  // L6 — output governance: the verdict decides the shape of the answer.
  const form = result?.passed !== true
    ? 'abstain: state what is missing, ask up to 3 questions, offer a conditional answer'
    : result.verdict === 'partial'
      ? 'annotate: answer, but name the parts that were not checked'
      : 'direct: answer normally, citing the evidence'
  const lines = [
    headline,
    `level: ${stats.level ?? 'standard'}  form: ${form}`,
    `checked: claims ${stats.claims ?? 0}, evidence ${stats.evidence ?? 0}, facts ${stats.facts ?? 0}, calls ${stats.toolCalls ?? 0}`,
  ]
  if (Number(stats.unverifiable) > 0) lines.push(`unverifiable: ${stats.unverifiable} verbatim excerpt(s) had no source to compare against`)
  if (unchecked.length > 0) lines.push(`not checked this pass: ${unchecked.join(', ')}`)
  const failures = Array.isArray(result?.failures) ? result.failures : []
  for (const failure of failures.slice(0, 12)) {
    lines.push(`- [${failure.code}] ${failure.message}${failure.detail === undefined ? '' : `: ${String(failure.detail).slice(0, 120)}`}`)
  }
  return lines.join('\n')
}
