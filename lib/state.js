/**
 * Durable mode selection.
 *
 * A mode is a user preference, not a comment: it must survive a plugin reload.
 * It is stored in the plugin's own state directory rather than in the profile
 * config, because writing the profile patch restarts the plugin and a restart is
 * exactly what would otherwise lose an in-flight choice.
 *
 * Persistence is opt-in through the deployment config (`persistMode`), so an
 * embedder that wants an ephemeral instance — including the test suite — gets one
 * without any filesystem writes.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** File name inside the state directory. */
const FILE = 'state.json'

/**
 * Resolve the directory that holds this plugin's state.
 *
 * @param settings - resolved settings; `stateDir` wins, then `$DSH_HOME`.
 * @returns an absolute directory, or undefined when persistence is disabled.
 */
export function resolveStateDir(settings) {
  if (settings === undefined || settings === null || settings.persistMode !== true) return undefined
  const configured = typeof settings.stateDir === 'string' ? settings.stateDir.trim() : ''
  if (configured.length > 0) return path.resolve(configured)
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim().length > 0
    ? process.env.DSH_HOME.trim()
    : path.join(os.homedir(), '.dsh')
  return path.join(home, 'a_hallucination')
}

/**
 * Read the persisted mode.
 *
 * @param dir - state directory from {@link resolveStateDir}.
 * @returns the stored mode id, or undefined when absent or unreadable.
 */
export function loadMode(dir) {
  if (typeof dir !== 'string' || dir.length === 0) return undefined
  try {
    const file = path.join(dir, FILE)
    if (!existsSync(file)) return undefined
    // Strip a UTF-8 BOM: some editors and shells write one, and JSON.parse
    // rejects it.
    const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && typeof parsed.mode === 'string' ? parsed.mode : undefined
  } catch (error) {
    // A broken state file must not prevent the plugin from starting.
    void error
    return undefined
  }
}

/**
 * Persist the selected mode.
 *
 * @param dir - state directory from {@link resolveStateDir}.
 * @param mode - resolved mode id.
 * @returns whether the write succeeded.
 */
export function saveMode(dir, mode) {
  if (typeof dir !== 'string' || dir.length === 0 || typeof mode !== 'string' || mode.length === 0) return false
  try {
    mkdirSync(dir, { recursive: true })
    const body = JSON.stringify({ mode, savedAt: new Date().toISOString() })
    writeFileSync(path.join(dir, FILE), `${body}\n`, 'utf8')
    return true
  } catch (error) {
    void error
    return false
  }
}
