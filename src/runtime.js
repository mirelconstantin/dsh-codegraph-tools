/**
 * The CodeGraph runtime: the service the tools call.
 *
 * It owns the three things a model needs from a code graph and keeps them in one
 * place: **which project a call is about**, **whether that project has a usable
 * index**, and **the structured answers themselves**.
 *
 * ### Failures are values, not throws
 *
 * A thrown error reaches the model as an unstructured string, which it cannot
 * dispatch on. Every failure below returns a frozen `outcome` a model can branch
 * on — `not-initialized`, `writer-locked`, `cli-missing`, `timed-out` — together
 * with the guidance for what to do next. The one exception is cancellation,
 * which the harness already reports.
 *
 * ### The index is a cache, and a stale one lies
 *
 * CodeGraph's watcher keeps an index fresh while a process watches it, but a
 * harness that never started a watcher leaves the graph frozen at its last build.
 * {@link CodeGraphRuntime#ensureIndexed} therefore re-syncs an index older than
 * `staleAfterHours` before the first query against it, which is what keeps an
 * answer from describing code that has since been edited.
 *
 * @module dsh-codegraph-tools/runtime
 */

import { stat } from 'node:fs/promises'

import { indexDirOf } from './config.js'
import { isNotInitialized, isWriterLock, parseJson, runCodegraph, TIMEOUT } from './engine.js'
import { describeError, formatBytes, trimmed } from './util.js'

/**
 * Every failure this runtime reports, as a frozen constant.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const OUTCOME = Object.freeze({
  ok: 'ok',
  notInitialized: 'not-initialized',
  indexElsewhere: 'index-elsewhere',
  writerLocked: 'writer-locked',
  cliMissing: 'cli-missing',
  timedOut: 'timed-out',
  cancelled: 'cancelled',
  noResults: 'no-results',
  badRequest: 'bad-request',
  unknown: 'unknown',
})

/**
 * The commands this runtime knows how to run, with their JSON support.
 *
 * `explore` is deliberately absent: upstream gives it no `--json`, and its
 * markdown output is what the model wants verbatim rather than re-rendered.
 *
 * @type {Readonly<Record<string, { json: boolean, timeoutKey: string }>>}
 */
const COMMANDS = Object.freeze({
  status: { json: true, timeoutKey: 'versionTimeoutMs' },
  query: { json: true, timeoutKey: 'queryTimeoutMs' },
  callers: { json: true, timeoutKey: 'queryTimeoutMs' },
  callees: { json: true, timeoutKey: 'queryTimeoutMs' },
  impact: { json: true, timeoutKey: 'queryTimeoutMs' },
  files: { json: true, timeoutKey: 'queryTimeoutMs' },
})

/**
 * Where each relationship command puts its answer rows in its JSON.
 *
 * The first key that holds an array wins. `definitions` is the fallback path
 * {@link relationRows} walks when none does, because a `--limit` that caps the
 * union still leaves the per-definition lists populated.
 *
 * @type {Readonly<Record<string, readonly string[]>>}
 */
const RELATION_KEYS = Object.freeze({
  callers: ['callers'],
  callees: ['callees'],
  impact: ['affected'],
})

export class CodeGraphRuntime {
  /**
   * @param {object} deps - the runtime's collaborators.
   * @param {any} deps.ctx - Cordis context.
   * @param {Record<string, any>} deps.config - resolved configuration.
   * @param {(message: string) => void} deps.log - the host logger.
   */
  constructor ({ ctx, config, log }) {
    this.ctx = ctx
    this.config = config
    this.log = log
    /** Per-root in-flight initialisation, so two calls build the index once. */
    this.building = new Map()
    /** Per-root recent status answers, so a query is not gated on a 5s probe. */
    this.statusCache = new Map()
    this.disposed = false
  }

  /**
   * Resolve the project a call is about.
   *
   * Precedence is explicit rather than defaulted at the call site: an argument,
   * then the session's own working directory, then `defaultRoot`. The session cwd
   * is what makes the tools work in the directory the user is actually in, and
   * it is the same header-derived value every other workspace-scoped tool uses.
   *
   * @param {any} exec - the tool execution.
   * @param {string} [requested] - an explicit project path from the model.
   * @returns {string} an absolute project path.
   */
  resolveRoot (exec, requested) {
    const explicit = trimmed(requested)
    if (explicit) return explicit
    const sessionCwd = trimmed(exec?.agent?.session?.header?.cwd)
    if (sessionCwd) return sessionCwd
    return this.config.defaultRoot
  }

  /**
   * Build a failure value the model can act on.
   *
   * @param {string} outcome - one of {@link OUTCOME}.
   * @param {string} message - what went wrong.
   * @param {string} [guidance] - what to do about it.
   * @param {Record<string, any>} [extra] - additional fields.
   * @returns {Record<string, any>} the failure value.
   */
  failure (outcome, message, guidance, extra) {
    return { ok: false, outcome, message, guidance: guidance ?? '', ...(extra ?? {}) }
  }

  /**
   * Probe the CLI once at activation, so an absent installation is a clear
   * activation log line rather than a confusing failure inside the first tool call.
   *
   * @returns {Promise<{ ok: boolean, version?: string, message?: string }>} the probe result.
   */
  async probe () {
    try {
      const run = await runCodegraph(this.ctx, ['version'], {
        cliPath: this.config.cliPath,
        timeoutMs: this.config.versionTimeoutMs,
        graceMs: this.config.shutdownTimeoutMs,
      })
      const version = trimmed(run.stdout) ?? trimmed(run.stderr)
      // A run with no output at all is a launch failure the child never reported
      // — a spawn error surfaces as a null exit code with empty streams, which is
      // what a missing executable looks like through this seam.
      if (version === null) {
        return this.failure(OUTCOME.cliMissing, 'the codegraph CLI produced no output', 'Install it with `npm i -g @colbymchenry/codegraph`, or set cliPath to an absolute path.')
      }
      if (run.exitCode !== 0 && !/\d+\.\d+\.\d+/.test(version)) {
        return this.failure(OUTCOME.cliMissing, describeError(run.stderr))
      }
      // A version is a `x.y.z` string. Anything else that exited 0 is prose — a
      // shim that launched something else, or a wrapper that printed help — and
      // calling it a version would make every later failure report a nonsense
      // build string to the model.
      const semver = /\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?/.exec(version)
      if (semver === null) {
        return this.failure(OUTCOME.cliMissing, `the codegraph CLI did not report a version: ${version}`,
          'Install it with `npm i -g @colbymchenry/codegraph`, or set cliPath to an absolute path.')
      }
      return { ok: true, version: semver[0] }
    } catch (error) {
      return this.failure(OUTCOME.cliMissing, describeError(error))
    }
  }

  /**
   * Run `codegraph status` for one project and classify the result.
   *
   * Two facts about this command drive the whole method. It exits **0** on an
   * uninitialized project, so the `initialized` field is the only honest success
   * test. And it walks **up** the directory tree to find an index, so a project
   * with none of its own resolves its ancestor's graph and reports it as its own
   * — which would let a query about an unindexed project answer from an unrelated
   * repository. {@link #verifyOwnIndex} is what stops that.
   *
   * @param {string} root - the project path.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<Record<string, any>>} the status value.
   */
  async status (root, signal) {
    const run = await this.#exec(root, ['status', root, '--json'], this.config.versionTimeoutMs, signal)
    if (!run.ok) return run
    const parsed = parseJson(run.value.stdout)
    if (parsed === null || typeof parsed !== 'object') {
      return this.failure(OUTCOME.unknown, 'codegraph status produced no JSON', 'The CLI may be a version that does not support --json on status.')
    }
    if (parsed.initialized !== true) {
      return this.failure(OUTCOME.notInitialized, `${root} has no codegraph index yet.`, this.#initGuidance(root))
    }
    return {
      ok: true,
      outcome: OUTCOME.ok,
      ...this.#verifyOwnIndex(root, parsed),
      version: parsed.version ?? null,
      lastIndexed: parsed.lastIndexed ?? null,
      fileCount: parsed.fileCount ?? 0,
      nodeCount: parsed.nodeCount ?? 0,
      edgeCount: parsed.edgeCount ?? 0,
      dbSize: formatBytes(parsed.dbSizeBytes),
      journalMode: parsed.journalMode ?? null,
      languages: Array.isArray(parsed.languages) ? parsed.languages : [],
      nodesByKind: isRecordLike(parsed.nodesByKind) ? parsed.nodesByKind : {},
      pendingChanges: isRecordLike(parsed.pendingChanges) ? parsed.pendingChanges : null,
      reindexRecommended: parsed?.index?.reindexRecommended === true,
      // Whether the graph already describes the code on disk. This is the one
      // question a model asks after editing a file, and answering it from
      // `lastIndexed` alone is wrong on a repository that was indexed today but
      // edited a minute ago.
      hasPendingChanges: hasPending({ pendingChanges: parsed.pendingChanges }),
    }
  }

  /**
   * Confirm that the index upstream found really belongs to this project.
   *
   * `status` reports the index directory it resolved, so comparing it against the
   * one this root owns answers the question directly. The comparison is
   * case-insensitive because Windows and macOS both treat `C:\Code` and `c:\code`
   * as one path.
   *
   * @param {string} root - the project path.
   * @param {Record<string, any>} parsed - the parsed `status` JSON.
   * @returns {{ projectPath: string, indexPath: string, ancestorIndex?: true }} the verified paths.
   */
  #verifyOwnIndex (root, parsed) {
    return verifyOwnIndex(root, parsed)
  }

  /**
   * Whether a status value describes an index belonging to an ancestor project.
   *
   * @param {Record<string, any>} status - a status value.
   * @returns {boolean} whether the index is not this project's own.
   */
  #isForeignIndex (status) {
    return status?.ancestorIndex === true
  }

  /**
   * Guidance the model can act on when a project has no index.
   *
   * @param {string} root - the project path.
   * @returns {string} the guidance text.
   */
  #initGuidance (root) {
    return this.#initGuidanceOf(root)
  }

  /**
   * Build a missing index, or refresh an existing one.
   *
   * The two jobs are two different upstream commands, and conflating them breaks
   * the build in both directions:
   *
   * - `init` **creates** a missing index. It is the only command that does: on a
   *   project that already has one it prints "Already initialized" and exits 0
   *   having done nothing, so re-running it to refresh is a silent no-op.
   * - `sync` **applies** an existing index's pending changes — the added,
   *   modified and removed files `status` reports under `pendingChanges`. On a
   *   project with no index at all it also does nothing.
   *
   * @param {object} options - the request.
   * @param {string} options.root - the project path.
   * @param {boolean} [options.force] - rebuild the whole index from scratch.
   * @param {AbortSignal} [options.signal] - caller cancellation.
   * @returns {Promise<Record<string, any>>} the index result.
   */
  async init ({ root, force = false, signal } = {}) {
    const existing = this.building.get(root)
    if (existing) return existing

    const build = this.#build(root, force, signal).finally(() => {
      if (this.building.get(root) === build) this.building.delete(root)
    })
    this.building.set(root, build)
    return build
  }

  /**
   * The actual index work, separated so {@link init} can deduplicate it.
   *
   * @param {string} root - the project path.
   * @param {boolean} force - rebuild the whole index from scratch.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<Record<string, any>>} the index result.
   */
  async #build (root, force, signal) {
    try {
      await stat(root)
    } catch {
      return this.failure(OUTCOME.badRequest, `"${root}" is not a directory that exists.`)
    }

    // Which command the run needs is decided by what the project already has,
    // because neither command can do the other's job: `init` will not refresh an
    // existing index, and `sync` will not create a missing one.
    let command
    let budget
    let purpose
    if (force) {
      command = 'index'
      budget = this.config.initTimeoutMs
      purpose = 'rebuild'
    } else {
      const current = await this.status(root, signal)
      if (current.ok && !current.ancestorIndex) {
        // A healthy index with nothing pending is already the answer.
        if (!current.reindexRecommended && !hasPending(current)) return current
        command = 'sync'
        budget = this.config.queryTimeoutMs
        purpose = 'refresh'
      } else {
        // No index of this project's own — either none at all, or one that
        // belongs to an ancestor. Both are `init`.
        command = 'init'
        budget = this.config.initTimeoutMs
        purpose = 'build'
      }
    }

    // Both commands are safe to interrupt and resume: upstream refuses to start a
    // second build while one is running, so a stale writer is a reason to stop
    // and report rather than to retry blindly.
    const run = await this.#exec(root, [command, root], budget, signal)
    if (!run.ok) return run

    const after = await this.status(root, signal)
    // A build just changed the answer, so the cached one is now a lie.
    this.statusCache.delete(keyOf(root))
    if (!after.ok || after.ancestorIndex) {
      return this.failure(OUTCOME.unknown, 'The index was built but codegraph status could not read it back.', '', { stderr: run.value.stderr.slice(0, 2000) })
    }
    return { ...after, built: purpose !== 'refresh', forced: force, synced: purpose === 'refresh', builtWith: command, purpose }
  }

  /**
   * Search symbols by name, ranked.
   *
   * @param {object} options - the request.
   * @param {string} options.root - the project path.
   * @param {string} options.search - the symbol text.
   * @param {number} [options.limit] - how many results.
   * @param {string} [options.kind] - a node-kind filter.
   * @param {AbortSignal} [options.signal] - caller cancellation.
   * @returns {Promise<Record<string, any>>} the search result.
   */
  async query ({ root, search, limit, kind, signal }) {
    const text = trimmed(search)
    if (text === null) return this.failure(OUTCOME.badRequest, 'search must be a non-empty string.')

    const args = ['query', text, '-p', root, '--limit', String(limit ?? this.config.defaultMaxResults)]
    if (trimmed(kind)) args.push('--kind', trimmed(kind))
    args.push('--json')

    const run = await this.#exec(root, args, this.config.queryTimeoutMs, signal)
    if (!run.ok) return run

    const parsed = parseJson(run.value.stdout)
    const rows = Array.isArray(parsed) ? parsed : []
    const matches = rows.map((row) => {
      const node = row?.node ?? {}
      return {
        name: node.name ?? null,
        qualifiedName: node.qualifiedName ?? null,
        kind: node.kind ?? null,
        filePath: node.filePath ?? null,
        startLine: node.startLine ?? null,
        endLine: node.endLine ?? null,
        language: node.language ?? null,
        signature: node.signature ?? null,
        isExported: node.isExported === true,
        docstring: trimmed(node.docstring),
        score: typeof row?.score === 'number' ? row.score : null,
      }
    })

    if (matches.length === 0) {
      return {
        ok: false,
        outcome: OUTCOME.noResults,
        message: `No indexed symbol matched "${text}".`,
        guidance: 'Try a shorter or different term, drop the kind filter, or run codegraph_files to see what the index actually contains. The graph only knows indexed files.',
        search: text,
        matches: [],
        total: 0,
      }
    }
    return { ok: true, outcome: OUTCOME.ok, search: text, matches, total: matches.length }
  }

  /**
   * Run one of the relationship commands and normalise its JSON.
   *
   * Upstream reports the queried symbol's own definition under `targets`, so
   * `targets` is deliberately **not** the answer: reading it returns the symbol
   * the model asked about, which looks like a result and is not one. The union
   * of the actual relationship rows is what {@link relationRows} extracts.
   *
   * @param {string} command - one of the keys of {@link COMMANDS}.
   * @param {object} options - the request.
   * @returns {Promise<Record<string, any>>} the relationship result.
   */
  async relation (command, { root, symbol, limit, depth, signal }) {
    const text = trimmed(symbol)
    if (text === null) return this.failure(OUTCOME.badRequest, 'symbol must be a non-empty string.')

    const args = [command, text, '-p', root]
    if (limit !== undefined) args.push('--limit', String(limit))
    if (depth !== undefined) args.push('--depth', String(depth))
    args.push('--json')

    const run = await this.#exec(root, args, this.config.queryTimeoutMs, signal)
    if (!run.ok) return run

    const body = trimmed(run.value.stdout)
    if (body === null) {
      return this.failure(OUTCOME.unknown, `codegraph ${command} returned nothing.`)
    }
    const parsed = parseJson(body)
    if (parsed === null) {
      // These commands answer an unknown symbol in plain prose on **exit code
      // 0**, so a parse miss here means "nothing matched" rather than a CLI
      // that broke. Reporting it as no-results keeps the model's next move
      // correct instead of sending it to reinstall the tool.
      if (/not found|no matches/i.test(body)) {
        return {
          ok: false,
          outcome: OUTCOME.noResults,
          command,
          symbol: text,
          message: `No indexed symbol matched "${text}".`,
          guidance: 'Use codegraph_search to find the exact name first — it searches the same index and reports kind, file and line.',
          total: 0,
          entries: [],
        }
      }
      return this.failure(OUTCOME.unknown, `codegraph ${command} produced no JSON.`)
    }
    return { ok: true, outcome: OUTCOME.ok, command, symbol: text, ...normaliseRelation(command, parsed) }
  }

  /**
   * Return one symbol's source, its callers, and the paths between them.
   *
   * `explore` is upstream's one strong tool and its output is markdown built for
   * a model to read, so it is passed through rather than re-rendered.
   *
   * @param {object} options - the request.
   * @param {string} options.root - the project path.
   * @param {string} options.query - the question, as free text.
   * @param {number} [options.maxFiles] - how many files to include source from.
   * @param {AbortSignal} [options.signal] - caller cancellation.
   * @returns {Promise<Record<string, any>>} the explore result.
   */
  async explore ({ root, query, maxFiles, signal }) {
    const text = trimmed(query)
    if (text === null) return this.failure(OUTCOME.badRequest, 'query must be a non-empty string.')

    const args = ['explore', text, '-p', root]
    if (maxFiles !== undefined) args.push('--max-files', String(maxFiles))

    const run = await this.#exec(root, args, this.config.queryTimeoutMs, signal)
    if (!run.ok) return run

    const body = trimmed(run.value.stdout)
    if (body === null) {
      return this.failure(OUTCOME.unknown, 'codegraph explore returned nothing.')
    }
    // `explore` prints the whole graph as source, and this plugin's own module
    // is part of that graph: the "CodeGraph isn't available here" wording is
    // quoted verbatim in `engine.js` above, so matching it against the answer
    // reports a fully answered query as unindexed. The exit code is the honest
    // signal — 1 with no stdout is how upstream refuses an uninitialized project
    // — and the message comes from stderr, which the success path never writes.
    if (run.value.exitCode !== 0 && isNotInitialized({ stderr: run.value.stderr, stdout: '', exitCode: run.value.exitCode })) {
      return this.failure(OUTCOME.notInitialized, `${root} has no codegraph index yet.`, this.#initGuidance(root))
    }
    return { ok: true, outcome: OUTCOME.ok, query: text, markdown: body }
  }

  /**
   * Read one symbol's source with line numbers, plus its caller/callee trail.
   *
   * This is a different upstream command from {@link explore}, and using the
   * right one is not cosmetic: `explore` answers a *question* by searching the
   * graph and returns whole files, so a symbol name handed to it comes back
   * buried in unrelated source. `node` answers a *name* with exactly that one
   * symbol. A file path is passed through the same command's file mode, which
   * returns the file with line numbers and its dependents.
   *
   * @param {object} options - the request.
   * @param {string} options.root - the project path.
   * @param {string} options.symbol - the symbol or file path to read.
   * @param {number} [options.offset] - file mode: 1-based start line.
   * @param {number} [options.limit] - file mode: maximum lines.
   * @param {AbortSignal} [options.signal] - caller cancellation.
   * @returns {Promise<Record<string, any>>} the node result.
   */
  async node ({ root, symbol, offset, limit, signal }) {
    const text = trimmed(symbol)
    if (text === null) return this.failure(OUTCOME.badRequest, 'symbol must be a non-empty string.')

    const args = ['node', text, '-p', root]
    if (offset !== undefined) args.push('--offset', String(offset))
    if (limit !== undefined) args.push('--limit', String(limit))

    const run = await this.#exec(root, args, this.config.queryTimeoutMs, signal)
    if (!run.ok) return run

    const body = trimmed(run.value.stdout)
    if (body === null) {
      return this.failure(OUTCOME.unknown, 'codegraph node returned nothing.')
    }
    // An unknown name is prose on exit code 0 — the command does not fail for it
    // — so the answer itself is classified rather than the exit status.
    if (/^Symbol\b.*\bnot found\b/i.test(body)) {
      return {
        ok: false,
        outcome: OUTCOME.noResults,
        symbol: text,
        message: `No indexed symbol or file matched "${text}".`,
        guidance: 'Use codegraph_search to find the exact name, or codegraph_files to see what the index contains.',
        total: 0,
        entries: [],
      }
    }
    return { ok: true, outcome: OUTCOME.ok, symbol: text, markdown: body }
  }

  /**
   * List the indexed files, optionally under one subpath.
   *
   * Upstream separates the two selectors cleanly: `--filter <dir>` takes a
   * **directory** and recurses into it, while `--pattern <glob>` takes a glob.
   * Passing a directory to `--pattern` is the trap — `dir/*` matches one level
   * only, and `dir/**` matches nothing under directory-aware globs — so the
   * directory the model named is sent to `--filter` and has to carry no glob
   * metacharacter before this module decides it was meant as a pattern.
   *
   * @param {object} options - the request.
   * @param {string} options.root - the project path.
   * @param {string} [options.path] - a subpath to list.
   * @param {number} [options.maxDepth] - how deep to descend.
   * @param {AbortSignal} [options.signal] - caller cancellation.
   * @returns {Promise<Record<string, any>>} the file listing.
   */
  async files ({ root, path, maxDepth, signal }) {
    const target = trimmed(path)
    const args = ['files', '-p', root]
    if (target !== null && target !== '.') {
      const selector = fileSelector(target)
      args.push(selector.flag, selector.value)
    }
    if (maxDepth !== undefined) args.push('--max-depth', String(maxDepth))
    args.push('--json')

    const run = await this.#exec(root, args, this.config.queryTimeoutMs, signal)
    if (!run.ok) return run

    const body = trimmed(run.value.stdout)
    if (body === null) {
      return this.failure(OUTCOME.unknown, 'codegraph files returned nothing.')
    }
    const parsed = parseJson(body)
    // An empty selection is reported in prose on exit code 0, so a parse miss
    // here is a zero-match listing rather than a broken command.
    const files = parsed === null ? [] : Array.isArray(parsed) ? parsed : Array.isArray(parsed.files) ? parsed.files : []
    return {
      ok: true,
      outcome: OUTCOME.ok,
      root,
      path: target ?? '.',
      total: files.length,
      files,
      // Naming the matched selector keeps a zero-result answer diagnosable
      // without a second call.
      selector: target === null ? null : fileSelector(target),
    }
  }

  /**
   * Find the tests affected by a set of changed files.
   *
   * Upstream traces import dependencies transitively from the changed files to
   * whichever files look like tests, so this answers "which tests do I run?" with
   * the graph rather than with a filename glob over everything.
   *
   * @param {object} options - the request.
   * @param {string} options.root - the project path.
   * @param {string[]} options.files - the changed files, repo-relative.
   * @param {string} [options.filter] - a custom test-file glob.
   * @param {number} [options.depth] - how deep to traverse.
   * @param {AbortSignal} [options.signal] - caller cancellation.
   * @returns {Promise<Record<string, any>>} the affected-tests result.
   */
  async affected ({ root, files, filter, depth, signal }) {
    const targets = Array.isArray(files) ? files.map((file) => trimmed(file)).filter((file) => file !== null) : []
    if (targets.length === 0) {
      return this.failure(OUTCOME.badRequest, 'files must name at least one changed file, repo-relative.',
        'Pass the paths as the git repository writes them, for example "src/tools.js".')
    }
    const args = ['affected', ...targets, '-p', root]
    if (depth !== undefined) args.push('--depth', String(depth))
    if (trimmed(filter)) args.push('--filter', trimmed(filter))
    args.push('--json')

    const run = await this.#exec(root, args, this.config.queryTimeoutMs, signal)
    if (!run.ok) return run

    const body = trimmed(run.value.stdout)
    if (body === null) {
      return this.failure(OUTCOME.unknown, 'codegraph affected returned nothing.')
    }
    const parsed = parseJson(body)
    if (parsed === null) {
      // `affected` answers in prose on exit code 0 when it cannot resolve the
      // paths, so a parse miss here is reported as the model can act on it
      // instead of as a CLI that broke.
      return this.failure(OUTCOME.badRequest, `codegraph affected could not resolve the changed files: ${body.slice(0, 300)}`,
        'Pass repo-relative paths exactly as git writes them, and check codegraph_files to see what the index contains.')
    }
    const tests = Array.isArray(parsed.affectedTests) ? parsed.affectedTests : []
    return {
      ok: true,
      outcome: OUTCOME.ok,
      changedFiles: Array.isArray(parsed.changedFiles) ? parsed.changedFiles : targets,
      totalDependentsTraversed: parsed.totalDependentsTraversed ?? 0,
      total: tests.length,
      affectedTests: tests,
      // An empty list is an answer, not a miss: it means the graph found no test
      // depending on these files, which is exactly what a model needs to know
      // before it assumes a change is covered.
      coverage: tests.length === 0
        ? 'The graph found no test file depending on these changes. Verify manually rather than assuming coverage.'
        : null,
    }
  }

  /**
   * List the files changed in this session's working copy.
   *
   * `codegraph affected` needs a list of changed files, and the harness knows
   * them far more cheaply than git does: a session's own edits are the files its
   * tools wrote. Handing that list straight to the graph turns "which tests do I
   * run for what I just changed" into one call.
   *
   * @param {object} options - the request.
   * @param {string} options.root - the project path.
   * @param {string[]} options.files - absolute or relative changed files.
   * @returns {Promise<Record<string, any>>} the repo-relative file list.
   */
  async changed ({ root, files }) {
    const targets = Array.isArray(files) ? files.map((file) => trimmed(file)).filter((file) => file !== null) : []
    if (targets.length === 0) {
      return this.failure(OUTCOME.badRequest, 'files must name at least one changed file.',
        'Pass the absolute paths you edited, or repo-relative ones.')
    }
    const prefix = keyOf(root)
    const relative = targets.map((file) => {
      const normalised = keyOf(file)
      return normalised.startsWith(`${prefix}/`) ? normalised.slice(prefix.length + 1) : file
    })
    return { ok: true, outcome: OUTCOME.ok, root, total: relative.length, changedFiles: relative }
  }

  /**
   * Report the index for the project a call is about, building it when configured.
   *
   * This is the one entry point every other query relies on to decide whether it
   * can run at all, and it is where the ancestor-index hazard is contained: a
   * status that resolved a parent's graph is **not** treated as this project's
   * index. With `autoInit` on, the correct index is built; with it off, the call
   * reports `index-elsewhere` rather than answering from a different repository.
   *
   * @param {object} options - the request.
   * @param {string} options.root - the project path.
   * @param {AbortSignal} [options.signal] - caller cancellation.
   * @returns {Promise<Record<string, any>>} the status value, or a failure.
   */
  async ensureIndexed ({ root, signal } = {}) {
    const current = await this.statusCached(root, signal)

    if (this.#isForeignIndex(current)) {
      if (!this.config.autoInit) {
        return this.failure(
          OUTCOME.indexElsewhere,
          `${root} has no index of its own; the only graph found belongs to ${current.projectPath}.`,
          `Querying it would answer from another project. Call codegraph_status with init: true to index ${root}, or pass "${current.projectPath}" as \`path\` if you meant that one.`,
          { foundFor: current.projectPath },
        )
      }
      this.log(`codegraph: ${root} has no index of its own (status resolved ${current.projectPath}); building one`)
      return this.init({ root, signal })
    }

    if (current.ok) {
      if (!this.#isStale(current) || !this.config.autoInit) return current
      this.log(`codegraph index for ${root} is older than ${this.config.staleAfterHours}h; refreshing it before the query`)
      return this.init({ root, signal })
    }
    if (current.outcome !== OUTCOME.notInitialized || !this.config.autoInit) return current
    return this.init({ root, signal })
  }

  /**
   * Report the index for a project, reusing a recent answer.
   *
   * Measured on this machine against the harness-home index: `status --json`
   * costs ~14.8s cold and ~1.1s warm, while `query --json` costs ~0.6s and
   * `affected --json` ~0.7s. Probing before every query would therefore spend up
   * to ~25x the query's cost proving the query was allowed to run, which is the
   * wrong trade — so a positive status is reused for {@link statusTtlMs} and the
   * default window is generous for exactly that reason.
   *
   * Only success is cached. A failure is returned as-is, because its whole point
   * is that the next call tries again. A cached answer is also never the last
   * word on freshness: `pendingChanges` is read on every call, so an index that
   * went stale inside the window still triggers a refresh.
   *
   * @param {string} root - the project path.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<Record<string, any>>} the status value.
   */
  async statusCached (root, signal) {
    const key = keyOf(root)
    const hit = this.statusCache.get(key)
    const now = Date.now()
    if (hit && now - hit.at < this.config.statusTtlMs) return hit.value

    const value = await this.status(root, signal)
    if (value.ok) this.statusCache.set(key, { at: now, value })
    return value
  }

  /**
   * Whether a status value is old enough to be worth refreshing.
   *
   * @param {Record<string, any>} status - a successful status value.
   * @returns {boolean} whether the index is stale.
   */
  #isStale (status) {
    const hours = this.config.staleAfterHours
    if (!Number.isFinite(hours) || hours <= 0) return false
    const stamp = Date.parse(String(status.lastIndexed ?? ''))
    if (!Number.isFinite(stamp)) return false
    return Date.now() - stamp > hours * 3600_000
  }

  /**
   * Run one command and classify every failure mode into an outcome.
   *
   * @param {string} root - the project path.
   * @param {string[]} args - the full argument list.
   * @param {number} timeoutMs - the budget.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @param {number} [graceMs] - terminate grace for the child.
   * @returns {Promise<Record<string, any>>} `{ ok: true, value }` or a failure value.
   */
  async #exec (root, args, timeoutMs, signal, graceMs = this.config.shutdownTimeoutMs) {
    let run
    try {
      run = await runCodegraph(this.ctx, args, {
        cliPath: this.config.cliPath,
        timeoutMs,
        signal,
        cwd: root,
        // The configured shutdown grace reaches the child through the spawn
        // spec, so a Settings change to `shutdownTimeoutMs` is honoured instead
        // of being silently replaced by the seam's own default.
        graceMs,
      })
    } catch (error) {
      const message = describeError(error)
      // An unresolvable working directory reaches the OS before the executable
      // does, so the seam reports it as `spawn <executable> ENOENT` even though
      // the executable is present. Reinstalling nothing here would fix nothing.
      if (/ENOENT/.test(message) && trimmed(this.config.cliPath) !== null) {
        return this.failure(OUTCOME.cliMissing, message,
          `The CLI at "${this.config.cliPath}" could not be launched. If it runs from a terminal, the working directory "${root}" is what the child process cannot use; a project root inside an app.asar is not a real directory for the OS.`)
      }
      // A timeout is classified against the sentence the engine actually
      // throws, not against a loose substring: a launch failure and a timeout
      // need opposite guidance, and conflating them sends a model to reinstall
      // a CLI that is present and merely slow.
      if (TIMEOUT.test(message)) {
        return this.failure(OUTCOME.timedOut, message,
          'Raise queryTimeoutMs or initTimeoutMs, or narrow the request to a subdirectory.')
      }
      return this.failure(OUTCOME.cliMissing, message,
        'Install it with `npm i -g @colbymchenry/codegraph`, or set cliPath to an absolute path to the executable.')
    }

    return this.classifyRun(run, signal, root)
  }

  /**
   * Classify one completed child run into either a value or a failure.
   *
   * The classification half of {@link #exec}, separated so a test can drive it
   * without a real child. The rules are order-sensitive: an aborted signal, a
   * launch that never started, a refused writer lock and an empty result are
   * four different situations, and each is reported as the outcome a model can
   * branch on.
   *
   * @param {{ stdout: string, stderr: string, exitCode: number|null }} run - the completed run.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @param {string} [root] - the project the run was about, named in guidance.
   * @returns {Record<string, any>} `{ ok: true, value: run }` or a failure value.
   */
  classifyRun (run, signal, root) {
    if (signal?.aborted) return this.failure(OUTCOME.cancelled, 'The call was cancelled.')
    // A run that never started reports a null exit code and empty streams. That
    // is the seam's only signal for a failed launch, and it must not be reported
    // as the CLI's own opaque exit status.
    if (run.exitCode === null && trimmed(run.stdout) === null) {
      return this.failure(OUTCOME.cliMissing, `the codegraph CLI did not start and reported no output (${this.config.cliPath}).`,
        'Install it with `npm i -g @colbymchenry/codegraph`, or set cliPath to an absolute path to the executable.')
    }
    // The writer lock is only ever a refusal, so it is classified **after** the
    // launch checks and **only for a failed run**. A successful `explore`
    // returns markdown whose own prose says "another codegraph_explore"
    // (upstream's model-facing guidance, `mcp/tools.js`), which the lock pattern
    // would otherwise match — reporting a fully answered query as locked.
    if (run.exitCode !== 0 && isWriterLock(run)) {
      return this.failure(OUTCOME.writerLocked, 'Another CodeGraph process holds the writer lock for this project.',
        'Run `codegraph daemon` and stop the background daemon, or `codegraph unlock <path>` if no process is alive.')
    }
    // Exit code 0 is NOT success here: an uninitialized `status` exits 0. The
    // per-command check that matters happens in the callers; this catches the
    // commands that produce nothing at all when they fail.
    if (run.exitCode !== 0 && trimmed(run.stdout) === null) {
      const guidance = isNotInitialized(run) ? this.#initGuidanceOf(root) : undefined
      return this.failure(
        isNotInitialized(run) ? OUTCOME.notInitialized : OUTCOME.unknown,
        // The refusal is reported in the project's own terms rather than as
        // upstream's raw prose, so every not-initialized failure names the
        // project and carries the action that resolves it.
        isNotInitialized(run) ? `${root} has no codegraph index yet.` : (describeError(run.stderr) || `codegraph exited with status ${run.exitCode}.`),
        guidance,
      )
    }
    return { ok: true, value: run }
  }

  /**
   * The guidance a not-initialized failure carries.
   *
   * @param {string} root - the project path.
   * @returns {string} the guidance text.
   */
  #initGuidanceOf (root) {
    if (!this.config.autoInit) {
      return `Run \`codegraph init "${root}"\` yourself, then ask again. Auto-init is off in this configuration.`
    }
    // The tool a model can actually call is `codegraph_status` with `init: true`;
    // naming a `codegraph_init` sends it looking for a tool that does not exist.
    return `Call codegraph_status with path "${root}" and init: true to build it; a first index of a large repository takes minutes, and every call after it is fast.`
  }

  /**
   * Close the runtime.
   *
   * The children are owned by the harness's managed process range, so disposal
   * only has to stop accepting work and let the host reap them.
   *
   * @returns {Promise<void>} resolves once the runtime is closed.
   */
  async dispose () {
    this.disposed = true
    this.building.clear()
    this.statusCache.clear()
  }
}

/**
 * Which selector flag a caller's string is, and what to send with it.
 *
 * A string that carries a glob metacharacter (`*`, `?`, `[`) is a pattern and
 * goes to `--pattern`; anything else is a directory and goes to `--filter`.
 * Getting that the wrong way round is silent: a directory sent to `--pattern`
 * matches nothing under a directory-aware glob, and a glob sent to `--filter`
 * is a literal path that also matches nothing.
 *
 * The directory is sent **with a trailing separator**. Upstream's `--filter` is
 * a prefix match, not a directory match: measured on 1.6.2 against an index
 * holding `src/alpha.js`, `src-extra.js` and `srclib.js`, `--filter src`
 * returns all three, while `--filter src/` returns only the file inside `src`.
 * Without the separator, every directory listing silently includes unrelated
 * top-level files whose names share a prefix.
 *
 * @param {string} target - the directory or pattern the caller named.
 * @returns {{ flag: string, value: string }} the flag and its argument.
 */
export function fileSelector (target) {
  const bare = String(target ?? '').trim().replace(/^\.\//, '')
  if (/[*?[]/.test(bare)) {
    return { flag: '--pattern', value: bare.replace(/[\\/]+$/, '') }
  }
  // A bare `.` means "the whole project", which is the default and needs no
  // selector at all; every other directory gets the trailing separator.
  const directory = bare === '' || bare === '.' ? '.' : `${bare.replace(/[\\/]+$/, '')}/`
  return { flag: '--filter', value: directory }
}

/**
 * Whether a status value reports index changes that are not in the graph yet.
 *
 * `pendingChanges` is upstream's own count of files added, modified or removed
 * since the last index, so it is the honest answer to "does the graph still
 * describe the code on disk" without a walk of the tree.
 *
 * @param {Record<string, any>} status - a successful status value.
 * @returns {boolean} whether the index has changes to apply.
 */
export function hasPending (status) {
  const pending = status?.pendingChanges
  if (!isRecordLike(pending)) return false
  return (Number(pending.added) || 0) + (Number(pending.modified) || 0) + (Number(pending.removed) || 0) > 0
}

/**
 * The cache key for one project.
 *
 * Case-folded, so `C:\Work` and `c:\work` do not each get their own entry.
 *
 * @param {string} root - the project path.
 * @returns {string} the key.
 */
function keyOf (root) {
  return String(root ?? '').replace(/[\\/]+$/, '').toLowerCase()
}

/**
 * Confirm that the index a `status` run resolved really belongs to this project.
 *
 * `status` reports the index directory it found, so comparing it against the one
 * this root owns answers the question directly. The comparison is
 * case-insensitive because Windows and macOS both treat `C:\Code` and `c:\code`
 * as one path.
 *
 * @param {string} root - the project path.
 * @param {Record<string, any>} parsed - the parsed `status` JSON.
 * @returns {{ projectPath: string, indexPath: string, ancestorIndex?: true }} the verified paths.
 */
export function verifyOwnIndex (root, parsed) {
  const reportedIndex = trimmed(parsed?.indexPath)
  const reportedProject = trimmed(parsed?.projectPath) ?? root
  if (reportedIndex !== null && samePath(reportedIndex, indexDirOf(root))) {
    return { projectPath: reportedProject, indexPath: reportedIndex }
  }
  // The ancestor's index is still worth reporting: it says a graph exists for
  // that larger project, and naming it is what lets the model decide whether to
  // use it deliberately instead of by accident.
  return { projectPath: reportedProject, indexPath: reportedIndex ?? '', ancestorIndex: true }
}

/**
 * Whether two paths name the same place.
 *
 * Case-insensitive and separator-normalised, because Windows and macOS both treat
 * `C:\Code` and `c:/code` as one path while Linux treats them as two.
 *
 * @param {string} left - one path.
 * @param {string} right - the other.
 * @returns {boolean} whether they are the same path.
 */
function samePath (left, right) {
  // Separators are normalised as well as case: codegraph reports Windows paths
  // with backslashes while `join` builds them with the platform separator, and
  // the two are the same path.
  const canon = (value) => String(value ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const a = canon(left)
  const b = canon(right)
  return a !== '' && a === b
}

/**
 * Whether a value is a plain object.
 *
 * @param {unknown} value - the candidate.
 * @returns {boolean} whether it is a plain object.
 */
function isRecordLike (value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The relationship rows a command answered with, never the queried definition.
 *
 * Upstream's three relationship commands share one response envelope: the queried
 * symbol's own definition under `targets`, the per-definition breakdown under
 * `definitions`, and the **union of the actual rows** under a command-specific key
 * (`callers`, `callees`, `affected`). Reading `targets` instead returns the symbol
 * that was asked about — a row that is always present, always matches, and never
 * answers the question, which is the failure this function exists to prevent.
 *
 * An empty union array is skipped rather than returned, because `--limit` caps
 * the union to zero on a result that still has rows under `definitions`.
 *
 * @param {any} parsed - the parsed JSON.
 * @param {readonly string[]} keys - the command-specific union keys, best first.
 * @returns {any[]} the relationship rows.
 */
export function relationRows (parsed, keys) {
  for (const key of keys) {
    const rows = parsed?.[key]
    if (Array.isArray(rows) && rows.length > 0) return rows
  }
  const definitions = parsed?.definitions
  if (Array.isArray(definitions)) {
    const nested = []
    for (const definition of definitions) {
      for (const key of keys) {
        if (Array.isArray(definition?.[key])) nested.push(...definition[key])
      }
    }
    if (nested.length > 0) return nested
  }
  return []
}

/**
 * Normalise one relationship command's JSON into stable fields.
 *
 * @param {string} command - the command name.
 * @param {any} parsed - the parsed JSON.
 * @returns {Record<string, any>} the normalised fields.
 */
function normaliseRelation (command, parsed) {
  const rows = Array.isArray(parsed) ? parsed : null
  const list = rows ?? relationRows(parsed, RELATION_KEYS[command] ?? [])
  const entries = list.map((entry) => ({
    name: entry?.name ?? null,
    qualifiedName: entry?.qualifiedName ?? null,
    kind: entry?.kind ?? null,
    filePath: entry?.filePath ?? null,
    startLine: entry?.startLine ?? null,
    relationships: Array.isArray(entry?.relationships) ? entry.relationships : null,
  }))
  const base = {
    total: typeof parsed?.total === 'number' ? parsed.total : entries.length,
    truncated: parsed?.truncated === true,
    ambiguous: parsed?.ambiguous === true,
    entries,
  }
  if (command === 'impact') {
    return {
      ...base,
      depth: parsed?.depth ?? null,
      nodeCount: parsed?.nodeCount ?? null,
      edgeCount: parsed?.edgeCount ?? null,
    }
  }
  return base
}

export { COMMANDS }
