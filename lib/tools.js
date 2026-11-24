/**
 * Model-facing tools.
 *
 * Schemas are raw JSON Schema objects with one string `type` per node, because a
 * malformed keyword can fail a provider request. Output schemas stay open: the
 * tools return small bounded documents and the renderers are defensive.
 */

import { buildContract, contractDigest, contractEnabled } from './contract.js'
import { modeLabel, switchesOf } from './modes.js'
import { makeLogger } from './util.js'

const OUTPUT_SCHEMA = Object.freeze({ type: 'object', additionalProperties: true })

/** Entries returned by one `list` call. */
const LIST_LIMIT = 20

/** Build one tool definition with a renderer that cannot throw. */
function define(name, description, parameters, execute, render) {
  return {
    name,
    description,
    parameters,
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args, value) {
        try {
          return [{ type: 'text', text: render(value) }]
        } catch (error) {
          return [{ type: 'text', text: `${name} completed, but its result could not be formatted: ${String(error)}` }]
        }
      },
    },
    execute,
  }
}

/** Read the requested action, defaulting to `status`. */
function actionOf(args) {
  if (args === null || typeof args !== 'object') return 'status'
  const action = typeof args.action === 'string' ? args.action.trim().toLowerCase() : ''
  return action.length > 0 ? action : 'status'
}

/** Session id of the calling agent. */
function sessionOf(exec) {
  const agent = exec !== null && typeof exec === 'object' ? exec.agent : undefined
  return agent !== null && typeof agent === 'object' && typeof agent.id === 'string' ? agent.id : undefined
}

/** Compact one ledger entry for transport. */
function compact(entry) {
  return {
    id: entry.id,
    source: entry.source,
    status: entry.status,
    locator: entry.locator,
    chars: entry.chars,
    granularity: entry.granularity,
    verbatim: entry.verbatim,
    excerpt: entry.excerpt.slice(0, 240),
  }
}

/** Render the status snapshot for a model or a human reader. */
function renderStatus(value) {
  const switches = value.switches !== null && typeof value.switches === 'object' ? value.switches : {}
  const on = Object.keys(switches).filter(key => switches[key] === true)
  const lines = [
    `A-Hallucination: ${value.mode} (${value.modeLabel})`,
    `contract: ${value.contract.chars} chars rendered with every tool, sha1 ${value.contract.sha1}, injected=${value.contract.injected}`,
    `ledger: ${value.ledger.total} entries (success ${value.ledger.byStatus.success}, error ${value.ledger.byStatus.error}, empty ${value.ledger.byStatus.empty})`,
    `untraceable observations: ${value.observations.session} this session, ${value.observations.total} total`,
    `active switches: ${on.length === 0 ? 'none' : on.join(', ')}`,
  ]
  if (Array.isArray(value.degraded) && value.degraded.length > 0) lines.push(`degraded: ${value.degraded.join(', ')}`)
  lines.push(`uptime: ${value.session.uptimeMs} ms`)
  return lines.join('\n')
}

/** Render a ledger listing. */
function renderList(value) {
  if (value.entries.length === 0) return `ledger is empty; ${value.total} entries total`
  const lines = value.entries.map(entry => `- ${entry.id} ${entry.source} [${entry.status}] ${entry.locator} (${entry.chars} chars) ${entry.excerpt.split('\n')[0].slice(0, 80)}`)
  return [`ledger: ${value.total} entries, showing the last ${value.entries.length}`, ...lines].join('\n')
}

/** Render the last turn-end verification. */
function renderVerdict(value) {
  const verdict = value.verdict
  if (verdict === null) return 'no turn-end verification recorded yet for this session'
  const state = verdict.passed !== true
    ? `FAIL (${(verdict.failedCodes ?? []).join(', ')})`
    : verdict.verdict === 'partial' ? 'PARTIAL' : 'PASS'
  const lines = [
    `turn ${verdict.turn ?? '?'}: ${state} at ${String(verdict.at).slice(11, 19)}`,
    `answer ${verdict.answerChars} chars, evidence ${verdict.evidenceCount}, calls ${verdict.callCount}`,
  ]
  if (Array.isArray(verdict.unchecked) && verdict.unchecked.length > 0) lines.push(`not checked: ${verdict.unchecked.join(', ')}`)
  return lines.join('\n')
}

/** Render the untraceable-parameter observations. */
function renderObservations(value) {
  if (value.items.length === 0) return 'no untraceable parameters observed this session'
  const lines = value.items.map(item => `- ${String(item.at).slice(11, 19)} ${item.tool}: ${Array.isArray(item.params) ? item.params.join(', ') : ''}`)
  return [`observations: ${value.total} this session`, ...lines].join('\n')
}

/** The ledger tool. */
function ledgerViewTool(state) {
  return define(
    'ledger_view',
    'Inspect the evidence ledger of real tool calls. `status` reports the active mode, the injected contract, and runtime totals; `list` shows recent entries; `observations` lists parameters that had no traceable origin; `verdict` reports the last turn-end verification. Read-only.',
    {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'list', 'observations', 'verdict'],
          description: 'status: mode, contract digest, and totals. list: recent entries. observations: untraceable parameters seen this session. verdict: the last turn-end verification.',
        },
      },
      required: [],
      additionalProperties: false,
    },
    async (args, exec) => {
      const action = actionOf(args)
      const ledger = state.ledgers.get(sessionOf(exec))
      if (action === 'status') {
        const text = buildContract(state, state.ctx)
        return {
          action,
          mode: state.mode,
          modeLabel: modeLabel(state.mode, state.settings.promptLocale),
          switches: { ...switchesOf(state.mode) },
          contract: {
            chars: text.length,
            sha1: contractDigest(text),
            injected: contractEnabled(state.mode) && !state.degraded.includes('contract'),
            preview: text.split('\n').slice(0, 2).join(' / '),
          },
          ledger: ledger.summary(),
          observations: {
            session: state.observations.get(sessionOf(exec)).length,
            total: state.observations.total(),
          },
          degraded: state.degraded.slice(),
          session: {
            startedAt: new Date(state.startedAt).toISOString(),
            uptimeMs: Date.now() - state.startedAt,
          },
        }
      }
      if (action === 'verdict') {
        return {
          action,
          verdict: state.verdicts.get(sessionOf(exec)) ?? null,
        }
      }
      if (action === 'observations') {
        const items = state.observations.get(sessionOf(exec))
        return {
          action,
          total: items.length,
          items: items.slice(Math.max(0, items.length - LIST_LIMIT)),
        }
      }
      if (action === 'list') {
        const all = ledger.list()
        return {
          action,
          total: all.length,
          entries: all.slice(Math.max(0, all.length - LIST_LIMIT)).map(compact),
        }
      }
      throw new Error(`unsupported action: ${action}`)
    },
    value => {
      if (value.action === 'list') return renderList(value)
      if (value.action === 'observations') return renderObservations(value)
      if (value.action === 'verdict') return renderVerdict(value)
      return renderStatus(value)
    },
  )
}

/**
 * Register the plugin tools on the Host registry.
 *
 * @param ctx - plugin context.
 * @param state - plugin state.
 */
export function registerTools(ctx, state) {
  const log = makeLogger(ctx.logger)
  const tools = typeof ctx.get === 'function' ? ctx.get('tools') : undefined
  if (tools === undefined || typeof tools.register !== 'function') {
    log.warn('tool service is unavailable; a-hallucination tools were not registered')
    return
  }
  try {
    ctx.effect(() => tools.register(ledgerViewTool(state)), 'a-hallucination tool: ledger_view')
  } catch (error) {
    log.error('could not register the ledger_view tool', error)
  }
}
