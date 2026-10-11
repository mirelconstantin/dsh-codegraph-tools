/**
 * Loader entry that mounts the model-facing CodeGraph tools.
 *
 * Kept separate from the service plugin so a configuration reload of one does not
 * have to take the CodeGraph service — and every in-flight query with it — down
 * for the other.
 *
 * @module dsh-codegraph-tools/entry-tools
 */

import { SERVICE, registerCodeGraphTools } from './index.js'

/** Loader identity. */
export const name = 'dsh-codegraph-tools'

/** Required services: the tool registry and our own CodeGraph runtime. */
export const inject = ['tools', SERVICE]

/**
 * Register every CodeGraph tool.
 *
 * Returns nothing on purpose: Cordis reads whatever a plugin body returns as an
 * effect, and a list of tool names is neither a disposer nor a promise.
 *
 * @param {any} ctx - Cordis context (unused; injection is declared above).
 * @returns {void} nothing.
 */
export function apply (ctx) {
  const names = registerCodeGraphTools(ctx)
  const logger = typeof ctx.logger === 'function' ? ctx.logger(name) : null
  const summary = `registered ${names.length} code graph tool(s): ${names.join(', ')}`
  // Logging must not be able to fail the load. Without a Cordis logger this falls
  // through to `process.stderr.write`, which throws EPIPE once the host has closed
  // the stream, and the rejection that follows takes the whole harness down over
  // one line of diagnostics.
  try {
    if (logger) logger.info(summary)
    else process.stderr.write(`[${name}] ${summary}\n`)
  } catch {
    /* the log sink is gone; there is nothing left to report it to */
  }
}
