/**
 * Mode presets over one switch set.
 *
 * The three named modes exist so a user never has to reason about individual
 * switches: `observe` only records, `inspect` also blocks high-risk actions and
 * reports, `adjudicate` additionally refuses calls whose target has no origin.
 * Every runtime decision reads a switch from here, never an ad-hoc mode compare.
 */

/** Defaults for switches consumed by later modules. Every switch here has a
 * consumer: `contract` gates the prompt section, `ledger` the evidence ledger,
 * `untrustedMark` the post-execute shield, `highRiskGate` the ask path,
 * `paramGate` the traceability check, and `paramDeny` its refusal. */
const BASE = Object.freeze({
  contract: true,
  ledger: true,
  untrustedMark: false,
  highRiskGate: false,
  paramGate: false,
  paramDeny: false,
  turnVerify: false,
})

/**
 * Named presets. `switches` is the only source of truth for behavior; the labels
 * are display metadata and are never compared against.
 */
export const MODES = Object.freeze({
  observe: Object.freeze({
    id: 'observe',
    zh: '静观',
    en: 'Observe',
    switches: Object.freeze({ ...BASE, ledger: true }),
  }),
  inspect: Object.freeze({
    id: 'inspect',
    zh: '明察',
    en: 'Inspect',
    switches: Object.freeze({
      ...BASE,
      ledger: true,
      untrustedMark: true,
      highRiskGate: true,
      paramGate: true,
      turnVerify: true,
    }),
  }),
  adjudicate: Object.freeze({
    id: 'adjudicate',
    zh: '断案',
    en: 'Adjudicate',
    switches: Object.freeze({
      ...BASE,
      ledger: true,
      untrustedMark: true,
      highRiskGate: true,
      paramGate: true,
      paramDeny: true,
      turnVerify: true,
    }),
  }),
})

/** Selectable mode ids in escalation order. */
export const MODE_IDS = Object.freeze(Object.keys(MODES))

/** Default mode when the row config omits or misspells one. */
export const DEFAULT_MODE = 'inspect'

/** Accept a mode id or either display label; unknown input falls back to the default. */
export function resolveMode(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (MODE_IDS.includes(trimmed)) return trimmed
    for (const mode of Object.values(MODES)) {
      if (trimmed === mode.zh || trimmed.toLowerCase() === mode.en.toLowerCase()) return mode.id
    }
  }
  return DEFAULT_MODE
}

/** Human label for a mode id in one language. */
export function modeLabel(modeId, locale = 'zh') {
  const mode = MODES[modeId] ?? MODES[DEFAULT_MODE]
  return locale === 'en' ? mode.en : mode.zh
}

/** Parse a config integer from a number or a numeric string. */
function toInt(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : undefined
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number.parseInt(value.trim(), 10)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/** Read a name list from config. */
function nameList(value) {
  return Array.isArray(value)
    ? value.filter(name => typeof name === 'string' && name.trim().length > 0).map(name => name.trim())
    : []
}

/**
 * Resolve the row config into a complete, validated settings object.
 *
 * Every field has one documented default and one parsing rule, so a mode change
 * cannot leave two components disagreeing about a value. Values that had to be
 * replaced are named in `warnings`; nothing is silently coerced.
 */
export function resolveSettings(config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const warnings = []
  const locale = typeof source.promptLocale === 'string' && source.promptLocale.trim().toLowerCase() === 'en' ? 'en' : 'zh'

  const bounded = (key, min, max, fallback) => {
    const parsed = toInt(source[key])
    if (parsed === undefined) {
      if (source[key] !== undefined) warnings.push(`${key} is not an integer; using ${fallback}`)
      return fallback
    }
    const clamped = Math.min(max, Math.max(min, parsed))
    if (clamped !== parsed) warnings.push(`${key} was clamped to ${clamped}`)
    return clamped
  }

  const order = toInt(source.contractOrder)
  if (source.contractOrder !== undefined && order === undefined) warnings.push('contractOrder is not an integer; using 240')
  const mode = resolveMode(source.mode)
  if (source.mode !== undefined && mode !== String(source.mode).trim()) {
    warnings.push(`mode "${String(source.mode)}" is not a known profile; using ${mode}`)
  }

  return {
    mode,
    promptLocale: locale,
    maxRewrite: bounded('maxRewrite', 0, 5, 2),
    maxRetry: bounded('maxRetry', 1, 5, 2),
    contractOrder: order ?? 240,
    highRiskTools: nameList(source.highRiskTools),
    highRiskAllow: nameList(source.highRiskAllow),
    untrustedTools: nameList(source.untrustedTools),
    untrustedToolsReplace: source.untrustedToolsReplace === true,
    traceableParams: nameList(source.traceableParams),
    persistMode: source.persistMode !== false,
    stateDir: typeof source.stateDir === 'string' ? source.stateDir : '',
    warnings,
  }
}

/** The switch set for the active mode. */
export function switchesOf(modeId) {
  return (MODES[modeId] ?? MODES[DEFAULT_MODE]).switches
}
