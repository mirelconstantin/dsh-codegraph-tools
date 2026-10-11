/**
 * The CodeGraph engine: one managed child process per command, JSON in, JSON out.
 *
 * ### Why the CLI and not the library or the MCP server
 *
 * Upstream `@colbymchenry/codegraph` also ships a `CodeGraph` class and a
 * `serve --mcp` server. Both were rejected deliberately:
 *
 * - The library's `node:sqlite` path requires Node >= 22.5 **in the host**, which
 *   couples this plugin to the runtime the harness happens to be on and to an
 *   upstream extraction-version bump that forces a re-index. The CLI bundles its
 *   own runtime and is immune to both.
 * - The MCP server speaks newline-delimited JSON-RPC over stdio and holds a
 *   per-project **writer lock**, so a second client either proxies through the
 *   shared daemon or refuses to start. A harness that reloads plugins would be
 *   fighting that lock for the life of the session.
 *
 * The CLI is the integration boundary: it is a process the harness already knows
 * how to own, it survives upstream upgrades, and it is trivially testable.
 *
 * ### The four behaviours this module exists to get right
 *
 * **Never trust the exit code.** `codegraph status --json` on an uninitialized
 * project exits 0 with `{"initialized": false}`. Success is a parsed field, not
 * a status.
 *
 * **Always pass an absolute project path.** Codegraph walks UP the directory tree
 * looking for an index. Run from a subdirectory without `-p`, a query against an
 * unindexed package silently answers from an unrelated ancestor's graph — a wrong
 * answer that looks entirely right.
 *
 * **`NO_COLOR=1` and `--json` together.** Output is `@clack`-styled when it
 * believes a TTY is attached, which puts escape sequences in front of the JSON.
 *
 * **Both pipes are drained before either is awaited.** Awaiting stdout before
 * attaching a stderr reader deadlocks the child once stderr fills its pipe.
 *
 * @module dsh-codegraph-tools/engine
 */

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { describeError } from './util.js'

/**
 * Bytes of stdout and stderr this module will accumulate for one command.
 *
 * A `query --json` over a large graph is the big one; 8 MB is well past any
 * bounded answer and bounds a runaway child that ignores its budget.
 */
export const MAX_CAPTURE_BYTES = 8 * 1024 * 1024

/**
 * The writer-lock message upstream prints when another process owns the index.
 *
 * Anchored to upstream's own wording — `CodeGraph writer lock held by PID …`
 * (`mcp/writer-lock.js` `writerLockHeldMessage`) and `CodeGraph file lock held
 * by another process` (`sync/watcher.js`). Two bare alternatives were tried first
 * and both matched ordinary answer text: `another (?:process|server)` matched the
 * guidance prose upstream itself emits in `explore` output, which turned a fully
 * answered query into a reported lock. Requiring the word "lock" to precede it is
 * what makes the pattern precise enough for {@link runCodegraph} to apply it to a
 * run that failed for some other reason.
 *
 * Matched on the child's stderr rather than its status, because a refused server
 * start and a refused query exit differently across platforms.
 */
export const WRITER_LOCK = /writer[\s-]?lock|lock held by another/i

/**
 * The message {@link runCodegraph} throws when a command overruns its budget.
 *
 * A timeout is the one failure whose guidance ("raise the budget") is the
 * opposite of the launch failure's ("install the CLI"), so the two must never
 * share a classification. Matching the exact sentence the engine throws is
 * precise; matching a loose substring is how a timeout used to be reported as
 * `cli-missing` and sent a model to reinstall a working tool.
 *
 * @type {RegExp}
 */
export const TIMEOUT = /exceeded its \d+ms budget/

/**
 * The message upstream prints for a project that has no index yet.
 *
 * Measured against 1.6.2, which prints on **stderr with exit code 1**:
 * `✗ CodeGraph isn't available here — no .codegraph/ index exists in <path>.`
 * The first two alternatives are the phrases that actually appear there; the
 * `codegraph init` clause is the recovery instruction in the same message.
 * Matching only a literal "not initialized" misses the real refusal entirely,
 * so a query against an unindexed project was classified as `unknown` — the
 * one outcome whose guidance tells a model to reinstall a working tool.
 *
 * @type {RegExp}
 */
export const NOT_INITIALIZED = /not initialized|no such directory|isn't available here|no \.codegraph[/\\] index|ENOENT|codegraph init/i

/**
 * Build the environment for one child.
 *
 * `NO_COLOR` is what makes `--json` emit bare JSON. `CI` suppresses the
 * interactive progress renderer, which otherwise writes to stderr and can hold
 * the terminal open. Everything else is inherited, so a user with the CLI on a
 * custom `PATH` still resolves it.
 *
 * @param {Record<string, string>} [extra] - additional variables.
 * @returns {NodeJS.ProcessEnv} the child environment.
 */
export function childEnv (extra) {
  return {
    ...process.env,
    NO_COLOR: '1',
    CI: '1',
    FORCE_COLOR: '0',
    ...(isRecordEnv(extra) ? extra : {}),
  }
}

/**
 * Whether a value is a plain object, used only for the env merge above.
 *
 * @param {unknown} value - the candidate.
 * @returns {boolean} whether it is a plain object.
 */
function isRecordEnv (value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Resolve a configured `cliPath` into something a child process can actually run.
 *
 * ### Why this exists
 *
 * On Windows, `npm i -g @colbymchenry/codegraph` leaves `codegraph` on `PATH` as a
 * **`.cmd` shim**, and Node refuses to spawn one without a shell — `spawn` fails
 * with `ENOENT`, or `EINVAL` on Node 24 where the CVE-2024-27980 hardening landed.
 * The failure is silent in the sense that matters: the user sees "codegraph works
 * in my terminal" while every tool call fails.
 *
 * Rather than reaching for a shell — which would put the arguments back under
 * shell interpretation and undo the subprocess seam's quoting guarantee — this
 * runs the npm shim as a **Node script**, which is exactly what the shim is: a
 * thin launcher that execs the vendored per-platform runtime.
 *
 * @param {string} cliPath - the configured path, or a bare name meaning PATH.
 * @returns {{ argv: string[], display: string }} the argument vector and a label for diagnostics.
 */
export function resolveCli (cliPath) {
  const configured = typeof cliPath === 'string' ? cliPath.trim() : ''
  if (configured === '' || configured === 'codegraph') {
    // A bare name is the PATH lookup. On Windows that name resolves to a `.cmd`,
    // so resolve the npm shim next to the global prefix when one is there.
    if (process.platform !== 'win32') return { argv: ['codegraph'], display: 'codegraph' }
    // The per-platform bundle ships its own `node.exe` alongside the CLI entry,
    // so it needs neither this process's runtime nor a PATH lookup. It is the
    // first choice because it is the only candidate that is always a real
    // executable: the harness may run under Electron, where `process.execPath`
    // is an app host, and the seam resolves a bare name without ever trying a
    // `.cmd`.
    const bundle = platformBundle()
    if (bundle !== null) return bundle
    const shim = npmGlobalShim()
    if (shim !== null) return { argv: [process.execPath, shim], display: shim }
    // No npm shim and no bundle. Fall back to the `.cmd` shims npm places on
    // `PATH` when it is configured to create them: the default Windows prefix
    // is `%APPDATA%\npm`, and an installer that put it elsewhere leaves it next
    // to the package this resolver just failed to find. Returning the bare name
    // here would hand the seam a `.cmd` it refuses to spawn, so every call fails
    // with `ENOENT` on a machine where the CLI genuinely works in a terminal.
    const cmdShim = cmdShimIn(globalPrefixes())
    if (cmdShim !== null) return { argv: [process.execPath, cmdShim], display: cmdShim }
    // Nothing found by any route: the bare name is the honest answer, and the
    // caller reports `cli-missing` with the install command rather than a
    // failure that points at a working CLI.
    return { argv: ['codegraph'], display: 'codegraph' }
  }

  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(configured)) {
    // A `.cmd` cannot be spawned directly; run it through Node, which is what the
    // shim expects anyway.
    return { argv: [process.execPath, configured], display: configured }
  }
  return { argv: [configured], display: configured }
}

/**
 * The per-platform bundle's own runtime and CLI entry, when one is installed.
 *
 * `npm i -g @colbymchenry/codegraph` installs a thin shim plus exactly one
 * `@colbymchenry/codegraph-<platform>-<arch>` bundle, and that bundle carries the
 * `node.exe` and the `lib/dist/bin/codegraph.js` entry it runs. Invoking those
 * directly skips every PATH and sha resolution problem: no `.cmd` that needs a
 * shell, no assumption that this process's `execPath` is a usable Node.
 *
 * The two flags the bundle's own shim passes are required, not decoration:
 * `--liftoff-only` keeps the vendored runtime from re-exporting the host `NODE_*`
 * settings, and the warning suppression keeps `node:sqlite`'s experimental notice
 * off stdout, where it would front the `--json` payload.
 *
 * @returns {{ argv: string[], display: string }|null} the invocation, or null when there is no bundle.
 */
function platformBundle () {
  for (const root of globalPrefixes()) {
    const bundles = join(root, 'node_modules', '@colbymchenry', 'codegraph', 'node_modules', '@colbymchenry')
    let entries
    try {
      entries = readdirSync(bundles).filter((name) => /^codegraph-/.test(name))
    } catch {
      continue
    }
    for (const name of entries) {
      const base = join(bundles, name)
      const nodeExe = join(base, 'node.exe')
      const entry = join(base, 'lib', 'dist', 'bin', 'codegraph.js')
      try {
        if (statSync(nodeExe).isFile() && statSync(entry).isFile()) {
          return {
            argv: [nodeExe, '--liftoff-only', '--disable-warning=ExperimentalWarning', entry],
            display: `the codegraph ${name} bundle`,
          }
        }
      } catch {
        /* try the next candidate */
      }
    }
  }
  return null
}

/**
 * The npm global prefixes to look in, in the order npm itself would.
 *
 * @returns {string[]} candidate prefix directories.
 */
function globalPrefixes () {
  const prefixes = []
  const declared = process.env.npm_config_prefix
  if (typeof declared === 'string' && declared !== '') prefixes.push(declared)
  // `APPDATA\npm` is the default global prefix on Windows.
  const appData = process.env.APPDATA
  if (typeof appData === 'string' && appData !== '') prefixes.push(join(appData, 'npm'))
  return prefixes
}

/**
 * Find the npm-installed `codegraph` shim on a global install.
 *
 * npm keeps global packages under a prefix whose `bin` holds the shims, so the
 * package sits at `<prefix>/node_modules/@colbymchenry/codegraph`.
 *
 * @returns {string|null} the shim path, or null when there is none.
 */
function npmGlobalShim () {
  for (const root of globalPrefixes()) {
    const shim = join(root, 'node_modules', '@colbymchenry', 'codegraph', 'npm-shim.js')
    try {
      if (statSync(shim).isFile()) return shim
    } catch {
      /* try the next prefix */
    }
  }
  return null
}

/**
 * Find the `codegraph.cmd` shim npm places on `PATH`.
 *
 * A `.cmd` cannot be spawned directly, so the caller runs it under Node, which
 * is exactly what the shim expects. Reached only when the shim script and the
 * per-platform bundle are both absent, because it is the least reliable of the
 * three: an npm prefix that is not on `PATH` would resolve a `codegraph.cmd`
 * the shell never finds.
 *
 * @param {string[]} prefixes - the candidate global prefix directories.
 * @returns {string|null} the `.cmd` shim path, or null when there is none.
 */
function cmdShimIn (prefixes) {
  for (const root of prefixes) {
    for (const candidate of [join(root, 'codegraph.cmd'), join(root, 'bin', 'codegraph.cmd')]) {
      try {
        if (statSync(candidate).isFile()) return candidate
      } catch {
        /* try the next candidate */
      }
    }
  }
  return null
}

/**
 * Whether a path is a directory the OS itself can resolve.
 *
 * The harness runs from inside its own `app.asar`, so a project root a model
 * names — the DSH checkout, a sibling install, any path reachable only through
 * Electron's patched `fs` — passes Node's `stat` but has no Win32 directory to
 * give a child. Both outcomes are a failure to spawn, and this is the probe that
 * separates them.
 *
 * @param {string} candidate - the path to test.
 * @returns {boolean} whether it is a real directory.
 */
function isDirectory (candidate) {
  if (typeof candidate !== 'string' || candidate.trim() === '') return false
  try {
    return statSync(candidate.trim()).isDirectory()
  } catch {
    // An asar-internal path throws ENOENT from the real filesystem, which is
    // exactly the case this check exists to catch.
    return false
  }
}

/**
 * The working directory a child process can actually be launched in.
 *
 * Windows resolves a child's working directory *before* it resolves the
 * executable: an unresolvable directory makes `CreateProcessW` fail with
 * `ERROR_DIRECTORY`, which the subprocess seam reports as
 * `spawn <argv[0]> ENOENT` — naming a perfectly valid executable and sending
 * the reader to reinstall a CLI that was never missing. The requested project
 * root reaches this module straight from the model-facing `path` argument, so
 * one such call failed every tool at once.
 *
 * Only the *process* working directory is relaxed. The project root still
 * travels as the command's own argument, which is what scopes the index, so
 * falling back keeps the answer about the right project instead of silently
 * retargeting it.
 *
 * @param {string} [requested] - the caller's project root.
 * @returns {string|undefined} a directory the OS can resolve, or undefined to let the provider use its own default.
 */
export function usableCwd (requested) {
  const trimmed = typeof requested === 'string' ? requested.trim() : ''
  if (trimmed !== '' && isDirectory(trimmed)) return trimmed
  if (isDirectory(process.cwd())) return process.cwd()
  return undefined
}

/**
 * Run one codegraph command as a managed child and capture its output.
 *
 * The subprocess seam is probed rather than injected: the whole tool surface must
 * not sit PENDING forever because a host has no subprocess service, so an absent
 * seam is reported as a clear error at the call that needs it instead.
 *
 * @param {any} ctx - Cordis context.
 * @param {string[]} args - arguments after the executable.
 * @param {object} [options] - run options.
 * @param {string} options.cliPath - the executable to run.
 * @param {number} [options.timeoutMs] - overall budget.
 * @param {AbortSignal} [options.signal] - caller cancellation.
 * @param {number} [options.graceMs] - terminate grace.
 * @param {Record<string, string>} [options.env] - extra environment variables.
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number|null, timedOut: boolean, cancelled: boolean }>} the completed run.
 * @throws {Error} when the CLI cannot be launched.
 */
export async function runCodegraph (ctx, args, options) {
  const subprocess = typeof ctx?.get === 'function' ? ctx.get('subprocess') : undefined
  if (!subprocess || typeof subprocess.spawn !== 'function') {
    throw new Error('this session has no subprocess service, so the codegraph CLI cannot be run')
  }

  const budget = options.timeoutMs ?? 60000
  const cli = resolveCli(options.cliPath)
  const argv = [...cli.argv, ...args]
  const cwd = usableCwd(options.cwd)
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, budget)
  timer.unref?.()
  const onOuter = () => controller.abort()
  options.signal?.addEventListener('abort', onOuter, { once: true })

  let handle
  try {
    handle = subprocess.spawn({
      argv,
      cwd,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      // The configured grace, not a literal: a value the Settings UI shows and
      // the runtime then ignores is a knob that does nothing.
      graceMs: options.graceMs ?? 2000,
      signal: controller.signal,
      env: childEnv(options.env),
    })
  } catch (error) {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onOuter)
    throw new Error(`the codegraph CLI could not be launched from "${cli.display}": ${describeError(error)}`)
  }

  // Attach BOTH readers before awaiting either — see the module note.
  const stdoutP = collect(handle.stdout)
  const stderrP = collect(handle.stderr)

  try {
    const [stdout, stderr, outcome] = await Promise.all([stdoutP, stderrP, handle.done])
    if (timedOut) {
      throw new Error(`\`codegraph ${args[0]}\` exceeded its ${budget}ms budget on this project; the graph may be too large to index here, or a stale writer lock is holding the index`)
    }
    return {
      stdout,
      stderr,
      exitCode: outcome?.exitCode ?? null,
      timedOut: false,
      cancelled: options.signal?.aborted === true,
    }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onOuter)
  }
}

/**
 * Drain one stream into a bounded string.
 *
 * @param {any} stream - the readable, or a missing stream.
 * @returns {Promise<string>} the collected text.
 */
function collect (stream) {
  return new Promise((resolve) => {
    if (!stream) return resolve('')
    let text = ''
    stream.setEncoding('utf8')
    stream.on('data', (chunk) => {
      if (text.length <= MAX_CAPTURE_BYTES) text += chunk
    })
    stream.on('end', () => resolve(text))
    stream.on('error', () => resolve(text))
  })
}

/**
 * Extract the first JSON value from a child that may have prefixed it with
 * diagnostics.
 *
 * Upstream writes progress lines to stderr and JSON to stdout, but a TTY-aware
 * renderer can interleave. The array pair is tried first: a stream that opens with
 * a diagnostic line and then carries `[{"…"}]` has no `{` before its own array,
 * so an object-first scan would slice `{…"a":1}` out of the middle of it and
 * return the wrong type entirely.
 *
 * @param {string} text - the child's stdout.
 * @returns {any|null} the parsed value, or null when there is none.
 */
export function parseJson (text) {
  const value = typeof text === 'string' ? text.trim() : ''
  if (value === '') return null
  try {
    return JSON.parse(value)
  } catch {
    /* the stream carried diagnostics too; fall through to the scan */
  }
  for (const [open, close] of [['[', ']'], ['{', '}']]) {
    const start = value.indexOf(open)
    if (start < 0) continue
    const end = value.lastIndexOf(close)
    if (end <= start) continue
    try {
      return JSON.parse(value.slice(start, end + 1))
    } catch {
      /* not this pair; try the next */
    }
  }
  return null
}

/**
 * Whether a failed run looks like the index is locked by another process.
 *
 * @param {{ stderr: string, stdout: string, exitCode: number|null }} run - the completed run.
 * @returns {boolean} whether the writer lock is the reported cause.
 */
export function isWriterLock (run) {
  return WRITER_LOCK.test(`${run?.stderr ?? ''}\n${run?.stdout ?? ''}`)
}

/**
 * Whether a failed run looks like the project has no index.
 *
 * @param {{ stderr: string, stdout: string, exitCode: number|null }} run - the completed run.
 * @returns {boolean} whether a missing index is the reported cause.
 */
export function isNotInitialized (run) {
  return NOT_INITIALIZED.test(`${run?.stderr ?? ''}\n${run?.stdout ?? ''}`)
}
