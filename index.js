/**
 * A-Hallucination Host entry.
 *
 * Registers one bounded anti-hallucination contract as a prompt section, records
 * every real tool dispatch in a per-session evidence ledger, observes the text the
 * runtime actually saw, gates high-risk and untraceable calls before they run,
 * marks external content as data, and exposes the ledger tool.
 *
 * Nothing in `apply` throws: a missing optional service or a malformed config only
 * disables the affected capability, records it in `degraded`, and leaves the Host
 * running.
 */

import { buildContract, contractDigest, contractEnabled } from './lib/contract.js'
import { createCorpusRegistry, textOfContent } from './lib/corpus.js'
import { createObservationRegistry, decidePreTool, SELF_TOOLS } from './lib/gate.js'
import { registerHttp } from './lib/http.js'
import { createLedgerRegistry } from './lib/ledger.js'
import { modeLabel, resolveSettings, switchesOf } from './lib/modes.js'
import { createMarkRegistry, isExternal, markContent } from './lib/shield.js'
import { loadMode, resolveStateDir, saveMode } from './lib/state.js'
import { createMetrics } from './lib/metrics.js'
import { registerTools } from './lib/tools.js'
import { createTurnTracker, createVerdictRegistry } from './lib/turn.js'
import { verifyTurn } from './lib/turnend.js'
import { makeLogger } from './lib/util.js'

/** Loader row name. */
export const name = 'a-hallucination'

/** Every capability is optional; each one is registered through `ctx.inject`/`ctx.get`. */
export const inject = []

/** Flatten the model-visible text of one dispatch result. */
function resultText(result) {
  if (result === null || typeof result !== 'object') return ''
  return textOfContent(result.content)
}

/** Session id of the calling agent, when the dispatch carries one. */
function sessionOf(exec) {
  const agent = exec !== null && typeof exec === 'object' ? exec.agent : undefined
  return agent !== null && typeof agent === 'object' && typeof agent.id === 'string' ? agent.id : undefined
}

/** Build the service view over mutable plugin state. */
function createService(state) {
  return {
    /** Active mode id. */
    get mode() {
      return state.mode
    },
    /**
     * Switch modes at runtime and refresh the derived switches in place.
     *
     * @param next - mode id or either display label.
     * @returns the resolved mode id.
     */
    setMode(next) {
      const settings = resolveSettings({ ...state.settings, mode: next })
      state.mode = settings.mode
      state.settings = settings
      state.switches = switchesOf(settings.mode)
      if (state.persistDir !== undefined) saveMode(state.persistDir, state.mode)
      return state.mode
    },
    /**
     * Current status snapshot.
     *
     * @returns mode, switches, contract digest, totals, and degraded capabilities.
     */
    status() {
      // Rendered with every registered tool, which is what this plugin can
      // observe deterministically. The per-assembly text may carry a smaller
      // tool set, so the digest is labelled as a rendering, not as proof of the
      // exact bytes in a given request.
      const text = buildContract(state, state.ctx)
      return {
        mode: state.mode,
        modeLabel: modeLabel(state.mode, state.settings.promptLocale),
        switches: { ...state.switches },
        contractEnabled: contractEnabled(state.mode),
        contractChars: text.length,
        contractSha1: contractDigest(text),
        startedAt: new Date(state.startedAt).toISOString(),
        ledgerEntries: state.ledgers.total(),
        observations: state.observations.total(),
        trackedTurns: state.turns.sessions(),
        degraded: state.degraded.slice(),
        warnings: state.settings.warnings.slice(),
      }
    },
  }
}

/**
 * Register the contract prompt section.
 *
 * The section renders on every assembly and returns an empty string on failure, so
 * a broken contract removes guidance instead of breaking the request.
 *
 * @param ctx - plugin context.
 * @param state - plugin state.
 * @param log - safe logger.
 */
function registerContract(ctx, state, log) {
  if (typeof ctx.inject !== 'function') {
    state.degraded.push('contract')
    log.warn('no ctx.inject; the contract section was not registered')
    return
  }
  try {
    ctx.inject(['systemPrompt'], (promptCtx) => {
      try {
        promptCtx.effect(() => promptCtx.systemPrompt.section({
          name: 'a-hallucination:contract',
          order: state.settings.contractOrder,
          text: (context) => {
            try {
              if (!contractEnabled(state.mode)) return ''
              return buildContract(state, promptCtx, context === undefined ? undefined : context.scope)
            } catch (error) {
              log.warn('contract render failed', error)
              return ''
            }
          },
        }), 'a-hallucination contract section')
      } catch (error) {
        state.degraded.push('contract')
        log.error('could not register the contract section', error)
      }
    })
  } catch (error) {
    state.degraded.push('contract')
    log.error('could not inject the system prompt service', error)
  }
}

/** Feed the corpus with the text a step is about to see. */
function captureStep(payload, state) {
  const messages = payload !== null && typeof payload === 'object' && Array.isArray(payload.messages) ? payload.messages : []
  const agent = payload !== null && typeof payload === 'object' ? payload.agent : undefined
  const sessionId = agent !== null && typeof agent === 'object' && typeof agent.id === 'string' ? agent.id : undefined
  const corpus = state.corpora.get(sessionId)
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue
    corpus.add(textOfContent(message.content), { protect: true })
  }
}

/**
 * Observe dispatches, incoming step messages, gates, and teardown.
 *
 * `tools/result` is the only writer of the ledger, so a result the registry never
 * produced cannot appear in it.
 *
 * @param ctx - plugin context.
 * @param state - plugin state.
 * @param log - safe logger.
 */
function registerEvents(ctx, state, log) {
  try {
    ctx.on('tools/result', (exec, result) => {
      try {
        const toolName = exec !== null && typeof exec === 'object' ? exec.name : undefined
        if (typeof toolName !== 'string' || SELF_TOOLS.has(toolName)) return
        const sessionId = sessionOf(exec)
        const original = state.marks.original(exec.callId)
        const text = typeof original === 'string' && original.length > 0 ? original : resultText(result)
        const entry = state.ledgers.get(sessionId).record({
          name: toolName,
          callId: exec.callId,
          args: exec.arguments,
          contentText: text,
          isError: result !== null && typeof result === 'object' && result.isError === true,
          trust: isExternal(toolName, state.settings) ? 'low' : 'high',
          turn: state.turns.turnOf(sessionId),
        })
        const corpus = state.corpora.get(sessionId)
        // Provenance comes from successful output only. A refused or failed call
        // must not make its own arguments look like an observed value, or one
        // denial would whitelist the target it just refused.
        if (result === null || typeof result !== 'object' || result.isError !== true) corpus.add(text)
      } catch (error) {
        log.warn('ledger write failed', error)
      }
    })
  } catch (error) {
    state.degraded.push('events')
    log.error('could not register the tools/result observer', error)
  }

  try {
    ctx.on('agent/pre-step', (payload, next) => {
      try {
        captureStep(payload, state)
      } catch (error) {
        log.warn('corpus capture failed', error)
      }
      return next()
    })
  } catch (error) {
    state.degraded.push('events')
    log.error('could not register the agent/pre-step observer', error)
  }

  try {
    ctx.on('tools/pre-execute', async (exec, next) => {
      try {
        const decision = decidePreTool(exec, state)
        if (decision !== undefined) return decision
      } catch (error) {
        log.warn('pre-execute gate failed; falling through', error)
      }
      return next()
    })
  } catch (error) {
    state.degraded.push('gate')
    log.error('could not register the tools/pre-execute gate', error)
  }

  try {
    ctx.on('tools/post-execute', async (exec, result, next) => {
      // Delegating first keeps every other post-execute listener in the chain:
      // short-circuiting here would skip spill limits and result pruning.
      const decision = await next()
      try {
        if (!state.switches.untrustedMark) return decision
        if (decision === null || typeof decision !== 'object' || decision.kind !== 'accept') return decision
        if (decision.value !== undefined) return decision
        if (result !== null && typeof result === 'object' && result.isError === true) return decision
        const base = Array.isArray(decision.content) ? decision.content : result.content
        const marked = markContent(exec, base, state.settings, state.marks)
        if (marked === undefined) return decision
        return { ...decision, content: marked }
      } catch (error) {
        log.warn('injection shield failed; accepting the result unchanged', error)
        return decision
      }
    })
  } catch (error) {
    state.degraded.push('shield')
    log.error('could not register the tools/post-execute shield', error)
  }

  try {
    ctx.on('agent/assistant-stream', (payload) => {
      try {
        const agent = payload !== null && typeof payload === 'object' ? payload.agent : undefined
        const frame = payload !== null && typeof payload === 'object' ? payload.frame : undefined
        if (agent === undefined || agent === null || typeof agent.id !== 'string') return
        if (frame === null || typeof frame !== 'object') return
        if (frame.type === 'start') {
          state.turns.begin(agent.id, frame.turn)
          return
        }
        const chunk = frame.chunk
        if (frame.type === 'chunk' && chunk !== null && typeof chunk === 'object' && chunk.type === 'text-delta') {
          state.turns.append(agent.id, chunk.text)
        }
      } catch (error) {
        log.warn('assistant stream capture failed', error)
      }
    })
  } catch (error) {
    state.degraded.push('events')
    log.error('could not register the assistant stream observer', error)
  }

  try {
    ctx.on('agent/turn-stopping', (payload) => {
      try {
        if (!state.switches.turnVerify) return
        const agent = payload !== null && typeof payload === 'object' ? payload.agent : undefined
        const sessionId = agent !== undefined && agent !== null && typeof agent.id === 'string' ? agent.id : undefined
        const turn = Number.isFinite(payload?.turn) ? payload.turn : state.turns.turnOf(sessionId)
        const text = state.turns.textOf(sessionId)
        const entries = state.ledgers.get(sessionId).list().filter(entry => turn === null || entry.turn === turn)
        const result = verifyTurn(text, entries)
        state.verdicts.set(sessionId, {
          turn,
          at: new Date().toISOString(),
          verdict: result.verdict,
          passed: result.passed,
          failedCodes: result.failedCodes,
          unchecked: result.unchecked,
          answerChars: result.answerChars,
          evidenceCount: result.evidenceCount,
          callCount: result.callCount,
        })
      } catch (error) {
        log.warn('turn verification failed', error)
      }
    })
  } catch (error) {
    state.degraded.push('events')
    log.error('could not register the turn-end verifier', error)
  }

  try {
    ctx.on('session/disposed', (session) => {
      try {
        if (session === null || typeof session !== 'object' || typeof session.id !== 'string') return
        state.ledgers.drop(session.id)
        state.corpora.drop(session.id)
        state.observations.drop(session.id)
        state.turns.drop(session.id)
        state.verdicts.drop(session.id)
      } catch (error) {
        log.warn('session cleanup failed', error)
      }
    })
  } catch (error) {
    state.degraded.push('events')
    log.warn('could not register the session/disposed observer', error)
  }
}

/**
 * Activate the bundle.
 *
 * @param ctx - Host plugin context.
 * @param config - patch configuration.
 */
export function apply(ctx, config) {
  const log = makeLogger(ctx.logger)
  try {
    let settings = resolveSettings(config)
    const persistDir = resolveStateDir(settings)
    if (persistDir !== undefined) {
      const saved = loadMode(persistDir)
      if (saved !== undefined) settings = resolveSettings({ ...config, mode: saved })
    }
    const state = {
      settings,
      mode: settings.mode,
      switches: switchesOf(settings.mode),
      startedAt: Date.now(),
      ctx,
      persistDir,
      metrics: createMetrics(),
      ledgers: createLedgerRegistry(),
      corpora: createCorpusRegistry(),
      observations: createObservationRegistry(),
      marks: createMarkRegistry(),
      turns: createTurnTracker(),
      verdicts: createVerdictRegistry(),
      counters: { ask: 0, deny: 0 },
      degraded: [],
    }
    for (const warning of settings.warnings) log.warn(`config: ${warning}`)
    const service = createService(state)
    try {
      ctx.provide('aHallucination', service)
    } catch (error) {
      log.warn('could not provide the aHallucination service', error)
    }
    registerContract(ctx, state, log)
    registerEvents(ctx, state, log)
    registerHttp(ctx, service, state)
    if (typeof ctx.inject === 'function') {
      try {
        ctx.inject(['tools'], toolCtx => registerTools(toolCtx, state))
      } catch (error) {
        state.degraded.push('tools')
        log.error('could not inject the tool service', error)
      }
    } else {
      registerTools(ctx, state)
    }
    log.info(`a-hallucination active: mode=${state.mode} switches=${JSON.stringify(state.switches)}`)
  } catch (error) {
    log.error('a-hallucination activation failed', error)
  }
}
