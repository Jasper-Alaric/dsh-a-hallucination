/**
 * Logging helper shared by every layer.
 *
 * The only contract here is that logging never fails the caller: a missing method
 * or a throwing sink must not interrupt a dispatch, a gate decision, or a render.
 */

/** Call one Host logger method without ever letting logging fail the caller. */
function emit(logger, level, args) {
  const method = logger !== null && typeof logger === 'object' && typeof logger[level] === 'function' ? logger[level] : undefined
  if (method === undefined) return
  try {
    method.apply(logger, args)
  } catch (error) {
    // Logging is best-effort: a broken logger must not break the plugin.
    void error
  }
}

/**
 * Wrap a Host logger so a missing method or a throwing sink is contained.
 *
 * @param logger - the Host logger, possibly absent.
 * @returns one function per level, each safe to call with anything.
 */
export function makeLogger(logger) {
  return {
    info: (...args) => emit(logger, 'info', args),
    warn: (...args) => emit(logger, 'warn', args),
    error: (...args) => emit(logger, 'error', args),
    debug: (...args) => emit(logger, 'debug', args),
  }
}
