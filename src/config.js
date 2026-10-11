/**
 * Plugin configuration: the defaults, the shape `cordis.patch.yml` may set, and
 * the one resolution step between "what the user wrote" and "what the runtime
 * reads".
 *
 * Two rules shape this module, both inherited from the harness conventions.
 *
 * **Validation rejects, resolution clamps.** A value that cannot mean anything —
 * an unknown key, a `cliPath` that does not exist — is a typo and must fail the
 * plugin load loudly, because a silently ignored key is a feature the user
 * believes is enabled. A value that is merely out of range is a preference, so
 * it is clamped in {@link resolveConfig} rather than refused, and `validate`
 * deliberately returns the raw value: a clamped number would make the number the
 * Settings UI shows differ from the one in force.
 *
 * **Every default lives here, never in the patch file.** A host that has not
 * restarted still runs the older `config.js`, and an older validator is a
 * closed set of keys — so a patch file declaring a key the host has never heard
 * of is a load failure, not a forward-compatible change.
 *
 * @module dsh-codegraph-tools/config
 */

import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import { clampInt, configValidator as baseConfigValidator, isRecord } from './util.js'

/**
 * Configuration defaults; the shape below is what `cordis.patch.yml` may set.
 *
 * @type {Record<string, any>}
 */
export const CONFIG_DEFAULTS = {
  // The codegraph executable. Empty means "the `codegraph` on PATH", which is
  // what `npm i -g @colbymchenry/codegraph` and the platform installer both leave.
  cliPath: '',
  // The directory a query runs against when neither the caller nor the session
  // names one. Empty means the harness home.
  defaultRoot: '',
  // Set false to answer only from an index the user already built, and never
  // spend time on a cold one.
  autoInit: true,
  // A project whose index is older than this many hours is re-synced before a
  // query, so an answer is never served from a graph that predates recent edits.
  // 0 disables the check.
  staleAfterHours: 24,
  // Deadlines, measured on this machine rather than assumed. Against the
  // harness-home index (509 files, no git repository so no change-detection
  // fast path) `status --json` costs ~14.8s cold and ~1.1s warm, while
  // `query --json` costs ~0.6s and `affected --json` ~0.7s. `status` is
  // therefore the budget that has to be generous, and it is the command every
  // other tool waits on first.
  queryTimeoutMs: 90000,
  initTimeoutMs: 600000,
  versionTimeoutMs: 90000,
  shutdownTimeoutMs: 2000,
  // Output bounds, applied per call unless the model asks otherwise.
  defaultMaxChars: 20000,
  defaultMaxResults: 20,
  // How deep `codegraph_impact` and `codegraph_explore` walk by default.
  defaultDepth: 2,
  // How long one successful `status` answer is reused before it is re-probed.
  // Measured here against the harness-home index: `status --json` costs ~14.8s
  // cold and ~1.1s warm while `query --json` costs ~0.6s, so re-probing before
  // every query would spend up to ~25x the query's cost proving the query was
  // allowed to run. Thirty minutes covers a whole session, so a warm session
  // probes once. A cached answer is never the last word on freshness:
  // `pendingChanges` is read per call, so an index that went stale inside the
  // window still triggers a refresh.
  statusTtlMs: 1800000,
}

/** Expected primitive type per configuration key. */
export const CONFIG_TYPES = {
  cliPath: 'string',
  defaultRoot: 'string',
  autoInit: 'boolean',
  staleAfterHours: 'number',
  queryTimeoutMs: 'number',
  initTimeoutMs: 'number',
  versionTimeoutMs: 'number',
  shutdownTimeoutMs: 'number',
  defaultMaxChars: 'number',
  defaultMaxResults: 'number',
  defaultDepth: 'number',
  statusTtlMs: 'number',
}

/**
 * One line per key, surfaced through Schemastery's field description.
 *
 * A column of bare key names is not documentation: `defaultRoot` and
 * `autoInit` both silently change what every answer contains.
 *
 * @type {Record<string, string>}
 */
export const DESCRIPTIONS = {
  cliPath: 'Absolute path to the codegraph executable. Empty uses the one on PATH.',
  defaultRoot: 'Project directory used when neither the call nor the session names one. Empty uses the harness home.',
  autoInit: 'Build or refresh the index when a query finds none, instead of only answering from an existing one.',
  staleAfterHours: 'Re-sync a project whose index is older than this before answering. 0 disables the check.',
  queryTimeoutMs: 'Budget for one query, search, or impact run.',
  initTimeoutMs: 'Budget for one index build, which is the slow operation on a large repository.',
  versionTimeoutMs: 'Budget for the CLI version probe and for `status`, which is slow on a large index.',
  shutdownTimeoutMs: 'Grace period before an in-flight child is killed at unload.',
  defaultMaxChars: 'Character budget for a returned result unless the call asks for its own.',
  defaultMaxResults: 'How many results a search returns unless the call asks for its own.',
  defaultDepth: 'How many hops `codegraph_impact` and `codegraph_explore` walk unless the call asks for its own.',
  statusTtlMs: 'How long one successful index-status answer is reused before re-probing. Raise it on a large repository, where the status call is slow.',
}

/**
 * Keys a live configuration change may apply without restarting the world.
 *
 * Every one of these is read per call rather than captured when a handle was
 * built, so applying one takes effect on the next tool call.
 *
 * @type {Set<string>}
 */
export const VOLATILE_KEYS = new Set([
  'cliPath',
  'defaultRoot',
  'autoInit',
  'staleAfterHours',
  'queryTimeoutMs',
  'initTimeoutMs',
  'defaultMaxChars',
  'defaultMaxResults',
  'defaultDepth',
  'statusTtlMs',
])

/**
 * The strict configuration validator, in the shape Standard Schema expects.
 *
 * The generic half — unknown keys, per-key type checks, numeric-string coercion,
 * and the rejection of a non-finite number — comes from `util.js` and is applied
 * first, so every value below is already known to have its declared type.
 *
 * @param {Record<string, any>} [defaults] - default value per known key.
 * @param {Record<string, string>} [types] - expected type per key.
 * @returns {(value: unknown) => { value: any } | { issues: Array<{ message: string, path?: string[] }> }} a Standard Schema validate function.
 */
export function configValidator (defaults = CONFIG_DEFAULTS, types = CONFIG_TYPES) {
  const check = baseConfigValidator(defaults, types)
  return (value) => {
    const result = check(value)
    if (result.issues) return result

    const issues = []
    // A CLI path is the one setting a typo must not reach a spawn. It has to be
    // absolute, because every call resolves it against the harness home rather
    // than the caller's working directory.
    const cli = typeof result.value.cliPath === 'string' ? result.value.cliPath.trim() : ''
    if (cli !== '' && !isAbsolute(cli)) {
      issues.push({ message: 'cliPath must be an absolute path to the codegraph executable', path: ['cliPath'] })
    }
    const root = typeof result.value.defaultRoot === 'string' ? result.value.defaultRoot.trim() : ''
    if (root !== '' && !isAbsolute(root)) {
      issues.push({ message: 'defaultRoot must be an absolute directory path', path: ['defaultRoot'] })
    }
    if (issues.length > 0) return { issues }
    return result
  }
}

/**
 * Fill in the derived paths and bounds a user does not have to configure.
 *
 * Every number is clamped rather than refused, because a clamped preference
 * still expresses intent and a rejected one costs the whole tool surface; the
 * rejections live in {@link configValidator}, where a typo belongs.
 *
 * @param {Record<string, any>} raw - validated plugin configuration.
 * @returns {Record<string, any>} configuration with resolved paths and bounds.
 */
export function resolveConfig (raw) {
  const value = { ...CONFIG_DEFAULTS, ...(isRecord(raw) ? raw : {}) }

  const cli = typeof value.cliPath === 'string' ? value.cliPath.trim() : ''
  // Bare `codegraph` is the PATH lookup the spawn performs; an explicit path is
  // resolved so a relative one cannot follow the caller's working directory.
  value.cliPath = cli === '' ? 'codegraph' : resolve(cli)
  const root = typeof value.defaultRoot === 'string' ? value.defaultRoot.trim() : ''
  value.defaultRoot = root === '' ? homedir() : resolve(root)

  // Booleans are normalised rather than passed through, because resolveConfig is
  // also called with hand-built objects by the scripts and by the tests.
  value.autoInit = value.autoInit !== false
  value.staleAfterHours = clampInt(value.staleAfterHours, CONFIG_DEFAULTS.staleAfterHours, 0, 8760)

  // Every deadline is clamped to a positive minimum. A negative or zero budget
  // would make the deadline helper skip its timer entirely, which turns "no
  // deadline configured" into "wait forever".
  value.queryTimeoutMs = clampInt(value.queryTimeoutMs, CONFIG_DEFAULTS.queryTimeoutMs, 1000)
  value.initTimeoutMs = clampInt(value.initTimeoutMs, CONFIG_DEFAULTS.initTimeoutMs, 5000)
  value.versionTimeoutMs = clampInt(value.versionTimeoutMs, CONFIG_DEFAULTS.versionTimeoutMs, 1000)
  value.shutdownTimeoutMs = clampInt(value.shutdownTimeoutMs, CONFIG_DEFAULTS.shutdownTimeoutMs, 100, 120000)

  value.defaultMaxChars = clampInt(value.defaultMaxChars, CONFIG_DEFAULTS.defaultMaxChars, 1000)
  value.defaultMaxResults = clampInt(value.defaultMaxResults, CONFIG_DEFAULTS.defaultMaxResults, 1, 200)
  value.defaultDepth = clampInt(value.defaultDepth, CONFIG_DEFAULTS.defaultDepth, 1, 10)
  // The cache window has a floor of one second: a zero would mean "re-probe on
  // every call", which is the cost this key exists to remove.
  value.statusTtlMs = clampInt(value.statusTtlMs, CONFIG_DEFAULTS.statusTtlMs, 1000, 3600000)
  return value
}

/**
 * Where this session keeps its graph index, for a status line and for diagnostics.
 *
 * @param {string} root - the project root.
 * @returns {string} the index directory path.
 */
export function indexDirOf (root) {
  return join(root, '.codegraph')
}
