/**
 * Pre-dispatch gate: high-risk confirmation and parameter traceability.
 *
 * Three rules keep this narrow enough to survive real use:
 *
 * 1. "High risk" means destructive, outward-facing, or paid — matched on the
 *    normalized tool name, on the action verb inside the arguments, and on the
 *    command text of a shell tool. Ordinary reads, writes, and edits never match,
 *    because blocking reversible in-workspace work trains users to switch the
 *    plugin off.
 * 2. Traceability applies to identifying parameters only — a path, URL, id,
 *    account, amount, or query, as string or number. Payloads (`content`),
 *    prose (`description`), and enum values (`action`) are authored for the
 *    current call and can never have an earlier origin.
 * 3. In `adjudicate` the parameter check runs first and wins: confirming an
 *    action must not launder a fabricated target.
 */

/** Normalize a tool name so camelCase and separators match the same pattern. */
export function normalizeToolName(name) {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
}

/** Name fragments marking a destructive action. `format` is excluded: in agent
 * tooling it names text formatting far more often than a disk format. */
const DESTRUCTIVE = /(^|[_.])(delete|remove|unlink|rmdir|purge|erase|wipe|drop|truncate)([_.]|$)/

/** Name fragments marking an outward-facing action. */
const OUTWARD = /(^|[_.])(publish|deploy|push|transfer|payment|refund|checkout|webhook|upload|submit)([_.]|$)/

/** Sending a message or a file leaves the machine. */
const SEND = /(^|[_.])send([_.]|$)|send_?file|send_?message|discord|feishu|telegram|email|mail|sms|notify/

/** Terminating a process or a host is destructive and hard to undo. */
const TERMINATE = /(^|[_.])(kill|shutdown|reboot|terminate|uninstall)([_.]|$)/

/** Tools whose arguments carry a command line to inspect. */
export const SHELL_TOOLS = Object.freeze(new Set([
  'pwsh', 'powershell', 'bash', 'sh', 'zsh', 'shell', 'terminal', 'cmd', 'exec', 'run_command', 'subprocess',
]))

/** Destructive command fragments. */
const COMMAND_DESTRUCTIVE = /\b(remove-item|rmdir|rd\s+\/s|del\s+|rm\s+-[rf]|rm\s+|unlink|diskpart|truncate|drop\s+table|format\s+[a-z]:)\b/i

/** Command fragments that stop or uninstall something. */
const COMMAND_TERMINATE = /\b(stop-process|taskkill|kill\s+|shutdown|reboot|uninstall)\b/i

/** Command fragments that publish or send data outward. */
const COMMAND_OUTWARD = /\b(git\s+push|npm\s+publish|docker\s+push|gh\s+pr\s+create|curl\b[^\n]*-x\s+post|invoke-webrequest\b[^\n]*-method\s+post)\b/i

/** Action-verb fragments inside arguments, e.g. `plugin_manager` remove_bundle. */
const ACTION_RISK = /(delete|remove|uninstall|purge|publish|push|send|pay|refund|transfer|drop|truncate)/

/** Tools whose own calls are never gated. */
export const SELF_TOOLS = Object.freeze(new Set(['ledger_view', 'answer_verify']))

/** Parameter keys whose value identifies a specific target. */
export const IDENTIFYING_KEYS = Object.freeze([
  'path', 'file_path', 'filepath', 'url', 'uri', 'href',
  'id', 'ids', 'account', 'user', 'user_id', 'phone', 'email',
  'amount', 'price', 'total', 'query', 'q', 'target', 'targets',
  'session', 'session_id', 'repo', 'repository', 'branch', 'tag',
])

/** Read a string field from an unknown record. */
function stringField(source, key) {
  if (source === null || typeof source !== 'object') return ''
  const value = source[key]
  return typeof value === 'string' ? value : ''
}

/**
 * Classify a call.
 *
 * @param name - tool name.
 * @param settings - resolved settings; `highRiskTools` adds names and
 *   `highRiskAllow` exempts them.
 * @param args - parsed arguments, inspected for an action verb or a command line.
 * @returns a reason string when the call is high risk, otherwise undefined.
 */
export function classifyRisk(name, settings, args = undefined) {
  if (typeof name !== 'string' || name.length === 0) return undefined
  const allow = Array.isArray(settings?.highRiskAllow) ? settings.highRiskAllow : []
  if (allow.includes(name)) return undefined
  const extra = Array.isArray(settings?.highRiskTools) ? settings.highRiskTools : []
  if (extra.includes(name)) return `listed in highRiskTools: ${name}`

  const normalized = normalizeToolName(name)
  if (DESTRUCTIVE.test(normalized)) return `destructive tool: ${name}`
  if (OUTWARD.test(normalized)) return `outward-facing tool: ${name}`
  if (SEND.test(normalized)) return `sends data outside this machine: ${name}`
  if (TERMINATE.test(normalized)) return `terminating tool: ${name}`

  const verb = stringField(args, 'action') || stringField(args, 'operation') || stringField(args, 'verb')
  if (verb.length > 0 && ACTION_RISK.test(verb.toLowerCase())) return `action "${verb}" is destructive or outward-facing`

  if (SHELL_TOOLS.has(normalized)) {
    const command = stringField(args, 'command') || stringField(args, 'cmdline') || stringField(args, 'script')
    if (command.length > 0) {
      if (COMMAND_DESTRUCTIVE.test(command)) return 'the command deletes or overwrites data'
      if (COMMAND_TERMINATE.test(command)) return 'the command stops or uninstalls something'
      if (COMMAND_OUTWARD.test(command)) return 'the command publishes or sends data outward'
    }
  }
  return undefined
}

/**
 * Every string or number leaf of the arguments, with its key path.
 *
 * Numbers matter: amounts, ids, and limits arrive as JSON numbers far more often
 * than as strings. Array items inherit the parent key, so `{ids:['7','8']}` is
 * checked as `ids` rather than as an index nobody declared.
 */
function scalarLeaves(value, prefix = '') {
  const leaves = []
  if (typeof value === 'string') {
    if (prefix.length > 0) leaves.push({ key: prefix, value })
    return leaves
  }
  if (typeof value === 'number') {
    if (prefix.length > 0 && Number.isFinite(value)) leaves.push({ key: prefix, value: String(value) })
    return leaves
  }
  if (Array.isArray(value)) {
    for (const item of value) leaves.push(...scalarLeaves(item, prefix))
    return leaves
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      leaves.push(...scalarLeaves(item, prefix.length === 0 ? key : `${prefix}.${key}`))
    }
  }
  return leaves
}

/** Last declared key of a path, e.g. `todos[0].path` becomes `path`. */
function lastKey(key) {
  const stripped = key.replace(/\[\d+\]/g, '')
  const dot = stripped.lastIndexOf('.')
  return dot === -1 ? stripped : stripped.slice(dot + 1)
}

/**
 * Identifying parameters that appear nowhere in the observed corpus.
 *
 * @param args - parsed tool arguments.
 * @param corpus - observed corpus.
 * @param keys - identifying keys to check; defaults to {@link IDENTIFYING_KEYS}.
 * @returns the untraceable parameters, at most 8.
 */
export function untraceableParams(args, corpus, keys = IDENTIFYING_KEYS) {
  if (corpus === undefined || args === undefined || args === null) return []
  if (typeof args !== 'object') return []
  const wanted = new Set(keys)
  const found = []
  const seen = new Set()
  for (const leaf of scalarLeaves(args)) {
    const key = lastKey(leaf.key)
    if (!wanted.has(key) || seen.has(leaf.key)) continue
    const normalized = leaf.value.replace(/\s+/g, ' ').trim()
    if (normalized.length < 2) continue
    if (corpus.has(leaf.value)) continue
    seen.add(leaf.key)
    found.push(leaf)
    if (found.length >= 8) break
  }
  return found
}

/** Format a bilingual reason for a decision. */
function reasonPair(zh, en) {
  return { en, zh }
}

/** Count one decision, so the settings page can report it. */
function tally(state, key) {
  try {
    if (state !== null && typeof state === 'object' && state.counters !== undefined && typeof state.counters[key] === 'number') {
      state.counters[key] += 1
    }
  } catch (error) {
    // Counting is best-effort; a decision must never depend on it.
    void error
  }
}

/**
 * Decide one pending call.
 *
 * @param exec - the pending dispatch (`name`, `arguments`, `agent`).
 * @param state - plugin state: mode, switches, settings, corpora, observations.
 * @returns a PreToolDecision, or undefined to fall through to `next()`.
 */
export function decidePreTool(exec, state) {
  const name = exec !== null && typeof exec === 'object' ? exec.name : undefined
  if (typeof name !== 'string' || name.length === 0 || SELF_TOOLS.has(name)) return undefined

  const agent = exec.agent
  const sessionId = agent !== null && typeof agent === 'object' && typeof agent.id === 'string' ? agent.id : undefined
  const switches = state.switches

  if (switches.paramGate) {
    const extra = Array.isArray(state.settings?.traceableParams) ? state.settings.traceableParams : []
    const keys = extra.length > 0 ? [...IDENTIFYING_KEYS, ...extra] : IDENTIFYING_KEYS
    const missing = untraceableParams(exec.arguments, state.corpora.get(sessionId), keys)
    if (missing.length > 0) {
      try {
        state.observations.get(sessionId).push({
          tool: name,
          params: missing.map(item => item.key),
          at: new Date().toISOString(),
        })
      } catch (error) {
        // Recording is best-effort; the decision must not depend on it.
        void error
      }
      if (switches.paramDeny) {
        const keys2 = missing.map(item => item.key).join(', ')
        tally(state, 'deny')
        return {
          kind: 'deny',
          reason: `untraceable parameters: ${keys2}`,
          displayReason: reasonPair(
            `A-Hallucination：${name} 的参数 ${keys2} 在本轮观察到的上下文里找不到来源，已拒绝执行。请先确认取值。`,
            `A-Hallucination: parameters ${keys2} for ${name} have no traceable origin in this turn, so the call was denied.`,
          ),
        }
      }
    }
  }

  if (switches.highRiskGate) {
    const risk = classifyRisk(name, state.settings, exec.arguments)
    if (risk !== undefined) {
      tally(state, 'ask')
      return {
        kind: 'ask',
        reason: risk,
        displayReason: reasonPair(
          `A-Hallucination：${name} 属高风险（${risk}），需要你确认后才能执行。`,
          `A-Hallucination: ${name} is high risk (${risk}) and needs your confirmation.`,
        ),
      }
    }
  }

  return undefined
}

/** Bounded per-session observation list with a cap on retained sessions. */
export function createObservationRegistry(maxPerSession = 50, maxSessions = 64) {
  const lists = new Map()
  const keyOf = sessionId => (typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : '__global__')
  const get = (sessionId) => {
    const key = keyOf(sessionId)
    let list = lists.get(key)
    if (list === undefined) {
      list = []
      lists.set(key, list)
      if (lists.size > maxSessions) lists.delete(lists.keys().next().value)
    }
    return list
  }
  const push = (sessionId, item) => {
    const list = get(sessionId)
    list.push(item)
    if (list.length > maxPerSession) list.splice(0, list.length - maxPerSession)
  }
  return {
    get,
    push,
    /** Total observed items across every session. */
    total() {
      let sum = 0
      for (const list of lists.values()) sum += list.length
      return sum
    },
    /** Retained sessions, for diagnostics. */
    sessions() {
      return lists.size
    },
    /** Drop one session, using the same key `get` uses. */
    drop(sessionId) {
      lists.delete(keyOf(sessionId))
    },
  }
}
