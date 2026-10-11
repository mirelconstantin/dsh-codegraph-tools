/**
 * Loader entry that publishes the code-graph guidance into the system prompt.
 *
 * This is what makes the code graph something every model reaches for, rather
 * than a capability it only discovers by reading tool schemas.
 *
 * The layer carries no configuration of its own, so a settings reload can move
 * the CLI path or the index bounds underneath without ever taking the guidance
 * out of the prompt: the section text names no path and no limit.
 *
 * @module dsh-codegraph-tools/entry-prompt
 */

import { SERVICE, registerCodeGraphPrompt } from './index.js'

/** Loader identity. */
export const name = 'dsh-codegraph-prompt'

/**
 * Required services: system-prompt assembly and our own CodeGraph runtime.
 *
 * `tools` is deliberately NOT injected. The section's `text` provider resolves
 * the registry with `ctx.get('tools')` when the harness assembles a prompt —
 * which is on a different fiber than this one — so a direct `ctx.tools` read
 * there is the trap recorded in `docs/postmortem/0001-acp-default-export-drops-inject.md`:
 * the property proxy's ancestor-only fiber walk can fail through a traceable shadow
 * and throw `cannot get property "tools" without inject`. `ctx.get` is the
 * topology-independent lookup and returns `undefined` while `tools` is absent or
 * loading, which is the correct answer for a visibility check. Declaring `tools`
 * here would additionally make this entry pend until the registry is ready, for a
 * dependency it does not require to publish its section.
 *
 * @type {string[]}
 */
export const inject = ['systemPrompt', SERVICE]

/**
 * Publish the code-graph guidance section.
 *
 * @param {any} ctx - Cordis context.
 * @returns {() => void} the section disposer.
 */
export function apply (ctx) {
  return registerCodeGraphPrompt(ctx)
}
