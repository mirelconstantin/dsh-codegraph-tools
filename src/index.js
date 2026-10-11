/**
 * Plugin entry: provide the CodeGraph service and publish the prompt guidance
 * that makes the code graph visible to every model.
 *
 * The engine is upstream's CLI, spawned as a managed child through
 * `ctx.subprocess`, so there is no child server to supervise and no long-lived
 * process to reparent. `ctx.subprocess` is probed rather than injected, because
 * gating the whole tool surface on a seam that only the query path needs would
 * leave every tool PENDING with no error when it is absent — the exact failure
 * `dsh-context` documented for its own equivalent.
 *
 * @module dsh-codegraph-tools
 */

import { CONFIG_DEFAULTS, CONFIG_TYPES, DESCRIPTIONS, VOLATILE_KEYS, configValidator, resolveConfig } from './config.js'
import { codeGraphGuidance, codeGraphToolsVisible } from './prompt.js'
import { CodeGraphRuntime } from './runtime.js'
import { registerTools } from './tools.js'
import { describeError } from './util.js'

/** Name of the Cordis service this plugin provides. */
export const SERVICE = 'codeGraph'

/** Plugin identity. */
export const name = 'dsh-codegraph-tools'

/**
 * No hard service requirement.
 *
 * `tools` and `systemPrompt` are injected by their own rows, and `subprocess` is
 * read with `ctx.get('subprocess')` at the point of use: an absent seam then costs
 * one query with a clear message instead of leaving every tool permanently
 * PENDING and silent.
 *
 * @type {string[]}
 */
export const inject = []

/**
 * The validation this plugin has always done, in one place.
 *
 * Declared once because it is installed twice: as the Standard Schema fallback
 * and, shadowed over the native schema, as the validator the harness itself
 * calls. Two copies would be two places for the rules to drift.
 *
 * @type {(value: unknown) => { value: any } | { issues: Array<{ message: string, path?: string[] }> }} the validate function.
 */
const CONFIG_STANDARD_VALIDATE = configValidator(CONFIG_DEFAULTS, CONFIG_TYPES)

/** The validator alone: the shape DSH falls back to when no native schema is available. */
const STANDARD_SCHEMA_CONFIG = {
  '~standard': { version: 1, vendor: 'dsh-codegraph-tools', validate: CONFIG_STANDARD_VALIDATE },
}

/**
 * Schemastery, when the harness can route it.
 *
 * The loader only opens an interception route to a package the importing manifest
 * names in `peerDependencies`, so `@deepseek-ai/schemastery` is declared there.
 * That peer is never range-checked against the runtime — the compatibility gate
 * skips any peer that is not `@deepseek-ai/dsh*` — so declaring it cannot block a
 * load.
 *
 * Three details of the package that the obvious code gets wrong:
 * - it has **no named `z` export**; `lib/index.mjs` is `export { Schema as default }`.
 * - it has **no `z.record`**, and **no `.describe()`**: the description is
 *   `meta.description`, reached through `.extra('description', text)`.
 * - `.volatile()` takes **no argument**: it always marks the field volatile and
 *   throws when called twice, so the flag has to be a conditional call.
 *
 * @type {any} the Schemastery constructor, or null when it cannot be resolved.
 */
let z = null
try {
  z = (await import('@deepseek-ai/schemastery')).default ?? null
} catch {
  z = null
}

/**
 * Attach one field's description to a Schemastery schema.
 *
 * @param {any} schema - a Schemastery schema.
 * @param {string} text - the description, or an empty string.
 * @returns {any} the annotated schema.
 */
function describe (schema, text) {
  if (!text) return schema
  return typeof schema.extra === 'function' ? schema.extra('description', text) : schema
}

/**
 * Build a shape the Settings UI can project, without changing how config validates.
 *
 * The native schema exists for **projection only**. Everything the plugin
 * actually enforces — unknown keys, the absolute-path checks — stays in
 * {@link CONFIG_STANDARD_VALIDATE}, and the instance's `~standard` is shadowed to
 * run exactly that.
 *
 * @returns {any} a native Schemastery schema, or the Standard Schema fallback.
 */
function buildConfig () {
  if (!z || typeof z.object !== 'function') return STANDARD_SCHEMA_CONFIG
  try {
    const shape = {}
    for (const [key, type] of Object.entries(CONFIG_TYPES)) {
      const base = type === 'number' ? z.number() : type === 'boolean' ? z.boolean() : type === 'string[]' ? z.array(z.string()) : z.string()
      let field = describe(base.default(CONFIG_DEFAULTS[key]), DESCRIPTIONS[key] ?? '')
      if (VOLATILE_KEYS.has(key)) field = field.volatile()
      shape[key] = field
    }
    const schema = z.object(shape)
    // `isNativeConfigSchema` reads `Symbol.for("schemastery")` off the prototype
    // and a string `type` plus a `meta` object off the instance, all of which a
    // `z.object` already satisfies. Only the validator is replaced.
    Object.defineProperty(schema, '~standard', {
      value: { version: 1, vendor: 'dsh-codegraph-tools', validate: CONFIG_STANDARD_VALIDATE },
      configurable: true,
    })
    return schema
  } catch {
    // A settings row is never worth losing the tools over.
    return STANDARD_SCHEMA_CONFIG
  }
}

/**
 * Plugin configuration.
 *
 * A native Schemastery schema when the harness can route the peer, so the row
 * renders in the Settings UI instead of reporting `unsupported`; the Standard
 * Schema form otherwise. Both validate identically.
 */
export const Config = buildConfig()

/**
 * Create the runtime that owns one CodeGraph service.
 *
 * Split from {@link apply} so the tools and prompt sub-modules can attach to a
 * service instance without re-reading configuration.
 *
 * @param {any} ctx - Cordis context.
 * @param {any} rawConfig - validated configuration.
 * @returns {{ runtime: CodeGraphRuntime, config: Record<string, any>, log: (message: string) => void }} the runtime, its resolved configuration and its logger.
 */
function createRuntime (ctx, rawConfig) {
  // Acquiring the logger is inside the guard too, not just using it. `ctx.logger`
  // is itself a service call: if the logging service is mid-teardown it can
  // throw, and an exception out of `apply` fails the plugin LOAD — taking the
  // whole tool surface with it over a diagnostic that was never worth reporting.
  let logger = null
  try {
    logger = typeof ctx.logger === 'function' ? ctx.logger(name) : null
  } catch {
    logger = null
  }
  const log = (message) => {
    // A logging call must never be able to fail the caller. Without a Cordis
    // logger this falls through to `process.stderr.write`, which throws EPIPE
    // once the host has closed the stream; inside an async function that becomes
    // a rejected promise, and under Node's default unhandled-rejection policy an
    // uncaught exception — `process.exit(1)` — takes the entire harness down over
    // one log line.
    try {
      if (logger) logger.info(message)
      else process.stderr.write(`[${name}] ${message}\n`)
    } catch {
      /* the log sink is gone; there is nothing left to report it to */
    }
  }
  const config = resolveConfig(rawConfig)
  return { runtime: new CodeGraphRuntime({ ctx, config, log }), config, log }
}

/**
 * Mount the CodeGraph service.
 *
 * The body returns nothing on purpose. Cordis reads whatever a plugin returns as
 * an effect — a disposer, an iterable of disposers, or nothing — so returning the
 * runtime object would fail the load with "Invalid effect", and this function is
 * synchronous for the same reason.
 *
 * @param {any} ctx - Cordis context.
 * @param {any} rawConfig - validated configuration.
 * @returns {void} nothing.
 */
export function apply (ctx, rawConfig) {
  const { runtime, config, log } = createRuntime(ctx, rawConfig)

  // Reserve the service name before anything can race us for it, and release it
  // on unload so a reload can take it again. No availability predicate: a probe
  // that failed must not dispose the tool and prompt rows, because a service that
  // comes and goes would take the whole tool surface with it.
  ctx.effect(() => ctx.provide(SERVICE, runtime), `ctx.provide(${SERVICE})`)

  // The single teardown ladder. The children are owned by the harness's managed
  // process range, so this only has to stop accepting work.
  ctx.effect(() => async () => runtime.dispose(), 'codegraph.engine')

  // Nothing is started eagerly. The index is a set of files the user's CLI owns;
  // activation only needs to know whether the CLI is there at all, so an absent
  // installation is one clear activation log line rather than a confusing failure
  // inside the first tool call.
  log(`codegraph CLI ${config.cliPath}; default project ${config.defaultRoot}`)
  try {
    const probe = runtime.probe()
    if (probe && typeof probe.then === 'function') {
      probe.then(
        (result) => {
          if (result?.ok) log(`codegraph ${result.version} is available`)
          else log(`the codegraph CLI is not usable: ${describeError(result?.message)} — the tools will report cli-missing until it is installed`)
        },
        (error) => log(`the codegraph CLI probe failed: ${describeError(error)}`),
      )
    }
  } catch (error) {
    log(`the codegraph CLI probe failed: ${describeError(error)}`)
  }
}

/**
 * Mount the model-facing CodeGraph tools on top of the runtime.
 *
 * @param {any} ctx - Cordis context providing `tools` and `codeGraph`.
 * @returns {string[]} the registered tool names.
 */
export function registerCodeGraphTools (ctx) {
  const runtime = ctx.get(SERVICE)
  if (!runtime) throw new Error(`dsh-codegraph-tools: the ${SERVICE} service is not mounted`)
  return registerTools(ctx, runtime)
}

/**
 * Mount the system-prompt guidance that teaches models to use the code graph.
 *
 * The text is a PROVIDER, not a string. A static section is injected into every
 * assembly, so it would follow a model into a scope whose `codegraph_*` tools
 * were filtered away — a preset's `tools.restrict({ allow: [...] })`, a
 * `subagent` call's `toolFilter`, or a disabled `codegraph-tools` row — and tell
 * it to reach for tools it has never been shown and cannot call. Evaluated per
 * assembly against the scope it is for, it instead contributes nothing in those
 * scopes (`renderPrompt` drops a section whose text is empty) and the full
 * guidance everywhere else.
 *
 * @param {any} ctx - Cordis context providing `systemPrompt`.
 * @returns {() => void} the section disposer.
 */
export function registerCodeGraphPrompt (ctx) {
  // `getSectionOrder` throws for third-party section names, so the lookup is
  // guarded and a pinned constant is the answer when it is unavailable.
  let order = 2120
  try {
    const resolved = typeof ctx.systemPrompt.getSectionOrder === 'function'
      ? ctx.systemPrompt.getSectionOrder('TOOL_WEB_FETCH')
      : null
    if (Number.isFinite(resolved)) order = resolved + 10
  } catch {
    order = 2120
  }
  return ctx.systemPrompt.section({
    name: 'codegraph:guide',
    // Just after the plain web-fetch guidance, so the model reads "this codebase
    // has a graph" alongside "there is a fetcher for the web".
    order,
    // Literal text: the section mentions tool names and double quotes that must
    // not be treated as prompt variables.
    interpolate: false,
    text: (context) => (codeGraphToolsVisible(ctx, context?.scope) ? codeGraphGuidance() : ''),
  })
}

// No `export default`: the loader unwraps a default export in preference to the
// namespace, which silently drops `inject`, `name` and `Config` from the plugin.
export { CodeGraphRuntime, CONFIG_DEFAULTS }
