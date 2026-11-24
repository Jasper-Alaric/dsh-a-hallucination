/**
 * L7 — running metrics for the verifier.
 *
 * The architecture document asks for observable rates (unsupported-claim rate,
 * quote-verifiability rate, over-abstention rate). A single-model plugin cannot
 * measure whether an answer is *true*, but it can count what it actually checked
 * and how often the model had to be sent back. Those counts are the honest
 * substitute: they expose drift instead of promising calibration.
 */

/** Create a metrics accumulator. Never throws; unknown input is ignored. */
export function createMetrics() {
  const counters = {
    checks: 0,
    pass: 0,
    partial: 0,
    fail: 0,
    claims: 0,
    quoted: 0,
    levels: { light: 0, standard: 0, strict: 0 },
    codes: {},
  }

  /** Record one completed verification. */
  function record(result, extra) {
    if (result === null || typeof result !== 'object') return
    counters.checks += 1
    if (result.passed === true) {
      if (result.verdict === 'partial') counters.partial += 1
      else counters.pass += 1
    } else {
      counters.fail += 1
    }
    const stats = result.stats !== null && typeof result.stats === 'object' ? result.stats : {}
    if (Number.isFinite(stats.claims)) counters.claims += stats.claims
    const level = stats.level
    if (level === 'light' || level === 'standard' || level === 'strict') counters.levels[level] += 1
    if (extra !== null && typeof extra === 'object' && Number.isFinite(extra.quoted)) counters.quoted += extra.quoted
    const codes = Array.isArray(result.failedCodes) ? result.failedCodes : []
    for (const code of codes) counters.codes[code] = (counters.codes[code] ?? 0) + 1
  }

  /** Read a plain summary, with derived rates guarded against division by zero. */
  function snapshot() {
    const checks = counters.checks
    const rate = (part) => (checks === 0 ? null : Math.round((part / checks) * 100))
    return {
      checks,
      pass: counters.pass,
      partial: counters.partial,
      fail: counters.fail,
      claims: counters.claims,
      quoted: counters.quoted,
      levels: { ...counters.levels },
      codes: { ...counters.codes },
      passRate: rate(counters.pass),
      failRate: rate(counters.fail),
      quoteRate: counters.claims === 0 ? null : Math.round((counters.quoted / counters.claims) * 100),
    }
  }

  return { record, snapshot }
}
