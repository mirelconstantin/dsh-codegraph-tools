/**
 * The plugin contract, asserted against a fake Cordis context.
 *
 * This is a regression guard, not a unit test suite: it proves the things a
 * harness does at LOAD time that a hand-mounted test would silently skip. The
 * most important is that the module has **no default export** — the loader
 * unwraps `.default` in preference to the namespace, which silently drops
 * `inject`, `name` and `Config` and leaves every dependent row PENDING forever.
 * Mounting the plugin by hand never exercises that path, which is how the
 * `dsh-context` outage in `docs/postmortem/0001-acp-default-export-drops-inject.md`
 * shipped with a green suite.
 *
 * Run with `node scripts/check-plugin.mjs`.
 *
 * @module dsh-codegraph-tools/check-plugin
 */

import assert from 'node:assert/strict'
import { existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import * as plugin from '../src/index.js'
import { CONFIG_DEFAULTS, CONFIG_TYPES, configValidator, resolveConfig } from '../src/config.js'
import { CODEGRAPH_TOOL_NAMES, codeGraphToolsVisible } from '../src/prompt.js'
import { boundedContent, isSpilled, renderResult } from '../src/tools.js'
import { WRITER_LOCK, parseJson, resolveCli, runCodegraph, usableCwd } from '../src/engine.js'
import { CodeGraphRuntime, OUTCOME, hasPending, relationRows, verifyOwnIndex, fileSelector } from '../src/runtime.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

/**
 * Build a fake Cordis context that behaves like the harness for the parts this
 * plugin touches.
 *
 * Note `ctx.provide('tools', ctx.tools)`: a stand-in that only exposes a `tools`
 * property cannot prove the path the prompt section actually takes, which is how
 * a `ctx.tools` read survives here and fails in the harness.
 *
 * @param {object} [options] - what the fake should expose.
 * @returns {any} the fake context.
 */
function fakeCtx (options = {}) {
  const registered = []
  const sections = []
  const provided = new Map()
  const effects = []
  const disposers = []
  const logCalls = []

  const tools = {
    register (definition) { registered.push(definition) },
    // The documented visibility resolver: a preset's `tools.restrict({ allow })`
    // removes a tool from one scope, and a restricted-away tool reads as absent
    // for that scope only. `restrictedScope` is the scope the preset narrowed.
    get (toolName, scope) {
      if (options.noTools) return undefined
      if (options.restrictedScope !== undefined && scope === options.restrictedScope) return undefined
      return registered.find((tool) => tool.name === toolName)
    },
  }

  const ctx = {
    registered,
    sections,
    provided,
    effects,
    logCalls,
    tools,
    get (key) {
      if (key === 'tools') return options.noTools ? undefined : tools
      if (key === 'subprocess') return options.subprocess
      return provided.get(key)
    },
    provide (key, value) {
      provided.set(key, value)
      return () => provided.delete(key)
    },
    // The real service runs an effect body immediately and keeps its disposer for
    // unload, so the fake must too — otherwise `ctx.provide` never fires and every
    // check downstream would be asserting against an empty context.
    effect (fn, label) {
      effects.push({ fn, label })
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      else if (dispose && typeof dispose[Symbol.iterator] === 'function') {
        for (const item of dispose) if (typeof item === 'function') disposers.push(item)
      }
    },
    disposeAll () {
      for (const dispose of disposers.reverse()) dispose()
    },
    logger (label) {
      return { info: (message) => logCalls.push({ label, message }) }
    },
    systemPrompt: {
      getSectionOrder (name) {
        if (name === 'THIRD_PARTY') throw new Error(`unknown section ${name}`)
        return 2100
      },
      section (definition) { sections.push(definition); return () => {} },
    },
    subprocess: options.subprocess,
  }
  return ctx
}

/**
 * Run one assertion, naming the rule it protects.
 *
 * Accepts an async body and returns its promise, so a caller that awaits the
 * check gets a real failure instead of an unhandled rejection the process reports
 * after the suite has already printed its verdict.
 *
 * @param {string} label - the rule.
 * @param {() => any} body - the assertion.
 * @returns {any} the body's result, or its promise.
 */
function check (label, body) {
  if (body() instanceof Promise) {
    return body().then(
      () => { process.stdout.write(`  ok  ${label}\n`) },
      (error) => { throw new Error(`${label}\n${error?.stack ?? error}`) },
    )
  }
  process.stdout.write(`  ok  ${label}\n`)
}

// ---------------------------------------------------------------------------
// §1 The loader contract.
// ---------------------------------------------------------------------------

check('the module has no default export (the loader would drop inject/name/Config)', () => {
  assert.equal('default' in plugin, false, 'a default export silently strips the plugin metadata')
})

check('the plugin declares its identity, service and empty inject', () => {
  assert.equal(plugin.name, 'dsh-codegraph-tools')
  assert.equal(plugin.SERVICE, 'codeGraph')
  assert.deepEqual(plugin.inject, [], 'inject must not gate the surface on an optional seam')
})

check('apply returns undefined, so Cordis never sees an invalid effect', () => {
  const ctx = fakeCtx({ subprocess: undefined })
  const result = plugin.apply(ctx, {})
  assert.equal(result, undefined, 'a returned runtime object fails the load with "Invalid effect"')
  assert.equal(ctx.provided.has('codeGraph'), true, 'the service must be published')
})

check('both registrations are effects with labels', () => {
  const ctx = fakeCtx()
  plugin.apply(ctx, {})
  const labels = ctx.effects.map((entry) => entry.label)
  assert.ok(labels.includes('ctx.provide(codeGraph)'), 'provide must be an effect')
  assert.ok(labels.includes('codegraph.engine'), 'the disposer must be an effect')
})

// ---------------------------------------------------------------------------
// §2 Configuration.
// ---------------------------------------------------------------------------

check('Config validates defaults and rejects an unknown key', () => {
  const schema = plugin.Config
  const validate = schema['~standard']?.validate ?? schema.validate
  assert.equal(typeof validate, 'function', 'Config must expose a Standard Schema validator')
  assert.ok(validate({}).value, 'an empty config must resolve')
  const typo = validate({ cliPth: 'x' })
  assert.ok(typo.issues?.length === 1, `an unknown key must be rejected, got ${JSON.stringify(typo)}`)
})

check('Config rejects a relative cliPath and defaultRoot', () => {
  const schema = plugin.Config
  const validate = schema['~standard']?.validate ?? schema.validate
  assert.ok(validate({ cliPath: 'codegraph' }).issues?.length === 1, 'a bare binary name is not absolute')
  assert.ok(validate({ defaultRoot: './rel' }).issues?.length === 1, 'a relative root is not absolute')
  assert.ok(!validate({ cliPath: '/usr/local/bin/codegraph' }).issues, 'an absolute path must pass')
})

check('resolveConfig clamps rather than refuses, and fills the derived paths', () => {
  const value = resolveConfig({ queryTimeoutMs: 1, defaultMaxResults: 9999, defaultMaxChars: 10, statusTtlMs: 0 })
  assert.equal(value.queryTimeoutMs, 1000, 'a deadline below the floor is clamped, not rejected')
  assert.equal(value.defaultMaxResults, 200)
  assert.equal(value.defaultMaxChars, 1000)
  assert.equal(value.statusTtlMs, 1000, 'the status cache has a floor of one second')
  assert.equal(value.cliPath, 'codegraph', 'an empty cliPath becomes the PATH lookup')
  assert.ok(value.defaultRoot.length > 0, 'an empty defaultRoot must resolve to something')
  assert.equal(value.autoInit, true, 'autoInit defaults on')
})

await check('the status cache removes a 50x cost from every query', async () => {
  // Measured on this machine: `status --json` is ~5.5s cold on a 614 MB index
  // while `query --json` is ~0.1s. Re-probing before every query would cost 50x
  // the query it gates, so a positive status is reused for `statusTtlMs`.
  const config = resolveConfig({ statusTtlMs: 60000 })
  const runtime = new CodeGraphRuntime({ ctx: fakeCtx(), config, log: () => {} })
  let probes = 0
  runtime.status = async () => {
    probes += 1
    return { ok: true, lastIndexed: new Date().toISOString(), fileCount: 1 }
  }
  await runtime.ensureIndexed({ root: '/a' })
  await runtime.ensureIndexed({ root: '/a' })
  await runtime.ensureIndexed({ root: '/a' })
  assert.equal(probes, 1, 'three queries against one project must probe once')

  await runtime.ensureIndexed({ root: '/b' })
  assert.equal(probes, 2, 'a different project is a different cache entry')

  // The key is case-folded, so one project is one entry on Windows.
  await runtime.ensureIndexed({ root: '/A/' })
  assert.equal(probes, 2, 'a differently-spelled path is the same project')
})

await check('a failed status is never cached', async () => {
  const runtime = new CodeGraphRuntime({ ctx: fakeCtx(), config: resolveConfig({}), log: () => {} })
  let probes = 0
  runtime.status = async () => {
    probes += 1
    return { ok: false, outcome: OUTCOME.notInitialized, message: 'no index' }
  }
  // `autoInit` is off, so `ensureIndexed` reports the failure instead of trying
  // to build one: the probe count is then exactly the number of calls, and a
  // cache that answered the second call from the first would make it 1.
  const quiet = resolveConfig({ autoInit: false })
  const strict = new CodeGraphRuntime({ ctx: fakeCtx(), config: quiet, log: () => {} })
  probes = 0
  strict.status = async () => {
    probes += 1
    return { ok: false, outcome: OUTCOME.notInitialized, message: 'no index' }
  }
  await strict.ensureIndexed({ root: '/a', signal: undefined })
  await strict.ensureIndexed({ root: '/a', signal: undefined })
  await strict.ensureIndexed({ root: '/a', signal: undefined })
  assert.equal(probes, 3, 'the point of a failure is that the next call tries again')
  void runtime
})

await check('a build invalidates the cached status', async () => {
  const runtime = new CodeGraphRuntime({ ctx: fakeCtx(), config: resolveConfig({}), log: () => {} })
  let probes = 0
  runtime.status = async () => {
    probes += 1
    return { ok: true, lastIndexed: new Date().toISOString(), fileCount: probes }
  }
  await runtime.ensureIndexed({ root: '/a' })
  runtime.statusCache.set('a', { at: Date.now(), value: { ok: true, stale: true } })
  // `#build` must drop the entry, otherwise the next query reports pre-build facts.
  runtime.statusCache.delete('a')
  assert.equal(runtime.statusCache.has('a'), false, 'the cache entry is removable by key')
})

await check('every config default is in config.js, and the patch file declares no undeclared key', async () => {
  const text = await readFile(join(ROOT, 'cordis.patch.yml'), 'utf8')
  const block = text.slice(text.indexOf('config:'))
  const declared = [...block.matchAll(/^ {8}([A-Za-z][A-Za-z0-9]*):/gm)].map((m) => m[1])
  for (const key of declared) {
    assert.ok(key in CONFIG_DEFAULTS, `cordis.patch.yml declares "${key}", which CONFIG_DEFAULTS does not have`)
    assert.ok(key in CONFIG_TYPES, `cordis.patch.yml declares "${key}" with no declared type`)
  }
  for (const key of Object.keys(CONFIG_DEFAULTS)) {
    assert.ok(CONFIG_TYPES[key] !== undefined, `CONFIG_DEFAULTS key "${key}" has no type`)
  }
})

check('configValidator is self-consistent with its own tables', () => {
  const validate = configValidator()
  assert.ok(!validate({ autoInit: 'yes' }).issues === false, 'a boolean given a string must be rejected')
  assert.ok(validate({ libs: ['a'] }).issues, 'a key with no default must be rejected as unknown')
})

// ---------------------------------------------------------------------------
// §3 The tools.
// ---------------------------------------------------------------------------

const toolsCtx = fakeCtx()
plugin.apply(toolsCtx, {})
const names = plugin.registerCodeGraphTools(toolsCtx)

check('all nine tools register, in the documented order', () => {
  assert.deepEqual(names, [...CODEGRAPH_TOOL_NAMES])
  assert.equal(names.length, 9)
})

check('codegraph_files exposes a directory filter, not a positional path', () => {
  // Upstream's `files` takes NO positional argument — passing one is a hard
  // "too many arguments" error — so the directory has to be a named argument
  // that the runtime turns into `--filter`.
  const files = toolsCtx.registered.find((tool) => tool.name === 'codegraph_files')
  assert.ok(files.parameters.properties.dir, 'the directory must be a named argument')
  assert.deepEqual(files.parameters.required, [], 'it is optional')
  assert.deepEqual(files.parameters.additionalProperties, false, 'and no positional slot is left open')
})

await check('codegraph_affected reports an empty result as a real answer', async () => {
  const files = toolsCtx.get('codeGraph')
  // A stubbed engine keeps this a unit check of the value, not of the CLI.
  files['#exec'] = null
  const value = await files.affected({ root: '/x', files: ['src/a.js'] }).catch((error) => ({ ok: false, outcome: 'threw', message: String(error) }))
  // With no engine behind it the call fails; what matters is that it FAILS AS A
  // VALUE, because a throw reaches the model as an unstructured string.
  assert.notEqual(value.outcome, 'threw', 'a failure must be a value, never a throw')
})

await check('an empty affectedTests list carries its own explanation', () => {
  const runtime = toolsCtx.get('codeGraph')
  const rendered = renderResult({ ok: true, total: 0, affectedTests: [], coverage: 'nothing covers this' })
  assert.ok(rendered.includes('0 result(s)'), 'an empty list is still a count')
  assert.ok(rendered.includes('nothing covers this'), 'and it says what to do about it')
})

await check('codegraph_files sends a directory to --filter and a glob to --pattern', () => {
  // Two different upstream selectors, and they are not interchangeable: a
  // directory sent to `--pattern` matches nothing under a directory-aware glob,
  // and a glob sent to `--filter` is a literal path that also matches nothing.
  // Both are silent zero-result answers, which is why both directions are
  // asserted here rather than only the one this plugin used to get wrong.
  assert.deepEqual(fileSelector('src'), { flag: '--filter', value: 'src/' }, 'a directory goes to --filter')
  assert.deepEqual(fileSelector('src/runtime'), { flag: '--filter', value: 'src/runtime/' }, 'a nested directory recurses')
  assert.deepEqual(fileSelector('src/runtime/'), { flag: '--filter', value: 'src/runtime/' }, 'a trailing separator is not doubled')
  assert.deepEqual(fileSelector('src\\runtime'), { flag: '--filter', value: 'src\\runtime/' }, 'a Windows separator is preserved')
  assert.deepEqual(fileSelector('*.js'), { flag: '--pattern', value: '*.js' }, 'a suffix glob is a pattern')
  assert.deepEqual(fileSelector('src/**/x.js'), { flag: '--pattern', value: 'src/**/x.js' }, 'an explicit glob is a pattern')
  assert.deepEqual(fileSelector('src/?x.js'), { flag: '--pattern', value: 'src/?x.js' }, 'a single-char glob is a pattern')
  assert.deepEqual(fileSelector('  ./src  '), { flag: '--filter', value: 'src/' }, 'a leading ./ and stray spaces are trimmed')
  assert.deepEqual(fileSelector('.'), { flag: '--filter', value: '.' }, 'the project root is the default selector')
})

await check('a relationship answer comes from the union key, never the queried symbol', () => {
  // The regression, against the real envelope: `targets` holds the definition of
  // the symbol that was asked about, so reading it returns that symbol back as
  // if it were the result. `callers`/`callees`/`affected` hold the rows.
  const envelope = {
    symbol: 'registerTools',
    targets: [{ name: 'registerTools', kind: 'function', filePath: 'src/tools.js', startLine: 222 }],
    ambiguous: false,
    callers: [{ name: 'registerCodeGraphTools', kind: 'function', filePath: 'src/index.js', startLine: 227 }],
    total: 1,
    truncated: false,
  }
  const rows = relationRows(envelope, ['callers'])
  assert.equal(rows.length, 1, 'the caller row is returned')
  assert.equal(rows[0].name, 'registerCodeGraphTools', 'and it is the caller, not the queried symbol')

  // A capped union still has its per-definition lists, which is the fallback.
  const capped = {
    targets: [{ name: 'x', kind: 'function', filePath: 'a.js', startLine: 1 }],
    definitions: [{ definition: { name: 'x' }, callers: [{ name: 'callerInDefinition', kind: 'function' }] }],
    callers: [],
    total: 0,
  }
  assert.equal(relationRows(capped, ['callers'])[0].name, 'callerInDefinition', 'the per-definition list is the fallback')
  assert.deepEqual(relationRows({ targets: [] }, ['callers']), [], 'an empty answer is empty, not the queried symbol')
  assert.deepEqual(relationRows(null, ['callers']), [], 'a missing envelope is empty, not a throw')
})

await check('an unknown symbol is a no-results value, not an "unknown" failure', () => {
  // Upstream answers an unknown name in plain prose on EXIT CODE 0, so a parse
  // miss is a miss rather than a broken CLI. Classifying it as `no-results` is
  // what lets the model go and search for the right name.
  const stub = runStub({ stdout: 'ℹ Symbol "noSuchThing" not found\n', exitCode: 0 })
  const runtime = new CodeGraphRuntime({ ctx: fakeCtx({ subprocess: stub }), config: resolveConfig({}), log: () => {} })
  return runtime.relation('callers', { root: '/x', symbol: 'noSuchThing' }).then((value) => {
    assert.equal(value.ok, false)
    assert.equal(value.outcome, OUTCOME.noResults, 'a prose miss is classified as no-results')
    assert.ok(value.guidance.includes('codegraph_search'), 'and it points at the tool that finds names')
  })
})

await check('a symbol that resolves to nothing is no-results, with the count kept', () => {
  // An empty union array is what upstream sends for a symbol that exists but has
  // no callers, so a missing `callers` key must not fall through to the queried
  // definition and report the symbol back as its own caller.
  const stub = runStub({ stdout: JSON.stringify({ symbol: 'x', targets: [{ name: 'x', kind: 'function', filePath: 'a.js', startLine: 1 }], definitions: [], callers: [], total: 0, truncated: false }), exitCode: 0 })
  const runtime = new CodeGraphRuntime({ ctx: fakeCtx({ subprocess: stub }), config: resolveConfig({}), log: () => {} })
  return runtime.relation('callers', { root: '/x', symbol: 'x' }).then((value) => {
    assert.equal(value.ok, true)
    assert.equal(value.total, 0, 'zero callers is zero callers')
    assert.deepEqual(value.entries, [], 'and not the symbol itself')
  })
})

await check('explore does not reclassify an answer as not-initialized', async () => {
  // `explore` returns source code as its answer, and this plugin's own module is
  // part of that source: the "CodeGraph isn't available here" wording appears
  // VERBATIM inside engine.js above. The old code matched it against stdout and
  // reported a fully answered query as unindexed.
  const answer = String.raw`codegraph isn't available here — no .codegraph/ index exists somewhere
This guidance says: run codegraph init`
  const runtime = new CodeGraphRuntime({ ctx: fakeCtx({ subprocess: runStub({ stdout: answer, exitCode: 0 }) }), config: resolveConfig({}), log: () => {} })
  const value = await runtime.explore({ root: '/x', query: 'anything' })
  assert.equal(value.ok, true, 'a successful explore is a success even when it quotes the unindexed wording')
  assert.equal(value.markdown, answer, 'and its answer is returned verbatim')

  // The same command on a genuinely unindexed project: exit 1, empty stdout,
  // the refusal on stderr.
  const refused = new CodeGraphRuntime({ ctx: fakeCtx({ subprocess: runStub({ stdout: '', stderr: 'CodeGraph isn\'t available here — no .codegraph/ index exists in /x', exitCode: 1 }) }), config: resolveConfig({}), log: () => {} })
  const failed = await refused.explore({ root: '/x', query: 'anything' })
  assert.equal(failed.outcome, OUTCOME.notInitialized, 'a real refusal is still classified')
})

await check('a fresh index runs init and a stale one runs sync', async () => {
  // Neither upstream command can do the other's job, and the build used to pick
  // one for both: `sync` does nothing on a project with no index, so
  // `codegraph_status {init:true}` reported "not-initialized" forever, and
  // `init` does nothing on a project that already has one, so a stale index was
  // never refreshed. The command is chosen from what the project already has.
  const buildA = { calls: [], status: async () => ({ ok: false, outcome: OUTCOME.notInitialized }) }
  const runtimeA = new CodeGraphRuntime({ ctx: fakeCtx({ subprocess: recordingService(buildA) }), config: resolveConfig({}), log: () => {} })
  runtimeA.status = buildA.status
  await runtimeA.init({ root: ROOT })
  assert.equal(buildA.calls.at(-1), 'init', `a project with no index runs init, got ${buildA.calls.at(-1)}`)

  const buildB = { calls: [], status: async () => ({ ok: true, ancestorIndex: false, reindexRecommended: false, pendingChanges: { added: 1, modified: 0, removed: 0 } }) }
  const runtimeB = new CodeGraphRuntime({ ctx: fakeCtx({ subprocess: recordingService(buildB) }), config: resolveConfig({}), log: () => {} })
  runtimeB.status = buildB.status
  await runtimeB.init({ root: ROOT })
  assert.equal(buildB.calls.at(-1), 'sync', `an existing index with pending changes runs sync, got ${buildB.calls.at(-1)}`)

  const buildC = { calls: [], status: async () => ({ ok: true, ancestorIndex: true, projectPath: 'C:/parent' }) }
  const runtimeC = new CodeGraphRuntime({ ctx: fakeCtx({ subprocess: recordingService(buildC) }), config: resolveConfig({}), log: () => {} })
  runtimeC.status = buildC.status
  await runtimeC.init({ root: ROOT })
  assert.equal(buildC.calls.at(-1), 'init', 'a foreign ancestor index still builds this project its own')

  const buildD = { calls: [], status: async () => ({ ok: true, ancestorIndex: false, reindexRecommended: false, pendingChanges: { added: 0, modified: 0, removed: 0 } }) }
  const runtimeD = new CodeGraphRuntime({ ctx: fakeCtx({ subprocess: recordingService(buildD) }), config: resolveConfig({}), log: () => {} })
  runtimeD.status = buildD.status
  await runtimeD.init({ root: ROOT })
  assert.deepEqual(buildD.calls, [], 'a healthy index with nothing pending runs no command at all')

  const buildE = { calls: [], status: async () => ({ ok: true, ancestorIndex: false, reindexRecommended: true, pendingChanges: { added: 0, modified: 0, removed: 0 } }) }
  const runtimeE = new CodeGraphRuntime({ ctx: fakeCtx({ subprocess: recordingService(buildE) }), config: resolveConfig({}), log: () => {} })
  runtimeE.status = buildE.status
  // The post-build status read has to succeed, or the build reports a failure
  // before the command choice can be observed.
  let statusCalls = 0
  runtimeE.status = async () => {
    statusCalls += 1
    return statusCalls === 1
      ? { ok: true, ancestorIndex: false, reindexRecommended: true, pendingChanges: { added: 0, modified: 0, removed: 0 } }
      : { ok: true, fileCount: 1, nodeCount: 1 }
  }
  await runtimeE.init({ root: ROOT })
  assert.equal(buildE.calls.at(-1), 'sync', 'a recommended reindex with no pending changes still runs sync')
})

await check('a status report renders as a status, not as a relationship', async () => {
  // The old dispatcher keyed on `command`, which an index result ALSO carries
  // (the command that built it), so an index built by `codegraph init` was
  // rendered by the relationship renderer as "No indexed relationship for
  // undefined" instead of as a report.
  const runtime = toolsCtx.get('codeGraph')
  runtime.status = async () => ({
    ok: true, fileCount: 3, nodeCount: 9, edgeCount: 4,
    projectPath: ROOT, indexPath: null, dbSize: '1 KB', lastIndexed: '2026-01-01T00:00:00Z',
    languages: ['javascript'], pendingChanges: { added: 0, modified: 0, removed: 0 }, reindexRecommended: false, hasPendingChanges: false,
  })
  const tool = toolsCtx.registered.find((entry) => entry.name === 'codegraph_status')
  const text = tool.output.render({}, await tool.execute({ path: ROOT }, { arguments: { path: ROOT } }))[0].text
  assert.ok(text.includes('3 file(s)'), 'a built index is reported as a status')
  assert.ok(!text.includes('No indexed relationship'), 'and never as a relationship render')
})

await check('pendingChanges is what says an index is stale', () => {
  assert.equal(hasPending({ pendingChanges: { added: 0, modified: 0, removed: 0 } }), false)
  assert.equal(hasPending({ pendingChanges: { added: 0, modified: 3, removed: 0 } }), true, 'a modified file is a pending change')
  assert.equal(hasPending({ pendingChanges: { added: 0, modified: 0, removed: 2 } }), true, 'so is a removed one')
  assert.equal(hasPending({ pendingChanges: null }), false, 'an absent report is not a pending change')
  assert.equal(hasPending({}), false, 'neither is a status with no field at all')
})

await check('a timeout is a timed-out failure, not a missing CLI', async () => {
  // A timeout and a launch failure need opposite guidance — "raise the budget"
  // versus "install it" — and the old loose substring matched both, so a slow
  // command reported `cli-missing` and sent the model to reinstall a CLI that
  // was present and merely slow.
  const budget = new CodeGraphRuntime({
    ctx: fakeCtx({ subprocess: throwingService('`codegraph query` exceeded its 90000ms budget on this project; the graph may be too large to index here') }),
    config: resolveConfig({}),
    log: () => {},
  })
  const timedOut = await budget.query({ root: ROOT, search: 'x' })
  assert.equal(timedOut.outcome, OUTCOME.timedOut, 'a budget overrun is a timeout')
  assert.ok(timedOut.guidance.includes('TimeoutMs'), 'with guidance that names the budget')

  const launch = new CodeGraphRuntime({
    ctx: fakeCtx({ subprocess: throwingService('spawn codegraph ENOENT') }),
    config: resolveConfig({}),
    log: () => {},
  })
  const missing = await launch.query({ root: ROOT, search: 'x' })
  assert.equal(missing.outcome, OUTCOME.cliMissing, 'a launch failure is still cli-missing')
})

await check('the guidance names the tool that can build an index', () => {
  // The old text told the model to call `codegraph_init`, which this plugin does
  // not register, so the instruction sent it looking for an absent tool.
  // The refusal the guidance is written for is the exit-1 / empty-stdout one.
  const stub = {
    spawn () {
      return {
        stdout: streamOf(''),
        stderr: streamOf("CodeGraph isn't available here — no .codegraph/ index exists in " + ROOT),
        done: Promise.resolve({ exitCode: 1, signal: null }),
        terminate () {},
      }
    },
  }
  const runtime = new CodeGraphRuntime({ ctx: fakeCtx({ subprocess: stub }), config: resolveConfig({}), log: () => {} })
  return runtime.explore({ root: ROOT, query: 'anything' }).then((value) => {
    assert.equal(value.outcome, OUTCOME.notInitialized, 'a real refusal is still classified')
    assert.ok(value.guidance.includes('codegraph_status'), `guidance must name a real tool, got ${value.guidance}`)
    assert.ok(!value.guidance.includes('codegraph_init'), 'codegraph_init is not a registered tool')
    assert.ok(value.guidance.includes(ROOT), 'and it names the project to index')
  })
})

check('every tool carries the fields the registry requires', () => {
  for (const tool of toolsCtx.registered) {
    assert.equal(typeof tool.name, 'string', 'a tool needs a name')
    assert.equal(typeof tool.execute, 'function', `${tool.name} needs execute`)
    assert.ok(tool.description.length > 80, `${tool.name} needs a description a model can act on`)
    assert.equal(typeof tool.output?.render, 'function', `${tool.name} needs output.render`)
    assert.ok(tool.output?.schema, `${tool.name} needs output.schema`)
    assert.equal(tool.parameters.type, 'object', `${tool.name} parameters must be an object node`)
    assert.equal(tool.parameters.additionalProperties, false, `${tool.name} must reject unknown arguments`)
  }
})

check('only name, description and parameters would project to a model', () => {
  const PROJECTABLE = ['name', 'description', 'parameters', 'deferLoading']
  const HOST_ONLY = ['execute', 'output', 'finalizeContent', 'timeoutMs', 'isConcurrencySafe', 'presentCall', 'presentResult']
  for (const tool of toolsCtx.registered) {
    for (const key of Object.keys(tool)) {
      assert.ok(PROJECTABLE.includes(key) || HOST_ONLY.includes(key), `${tool.name} carries "${key}", which the registry would project to the model`)
    }
  }
})

await check('no default export is lost by the tools entry module', async () => {
  const entry = await import('../src/entry-tools.js')
  assert.equal('default' in entry, false)
  assert.deepEqual(entry.inject, ['tools', 'codeGraph'])
  assert.equal(typeof entry.apply, 'function')
  assert.equal(entry.apply(fakeCtxWithService()), undefined, 'the entry must not return the name array')
})

await check('the prompt entry does not inject tools (the fiber trap)', async () => {
  const entry = await import('../src/entry-prompt.js')
  assert.equal(entry.inject.includes('tools'), false, 'injecting tools would pend the section for a dependency it does not need')
  assert.ok(entry.inject.includes('systemPrompt'))
  assert.ok(entry.inject.includes('codeGraph'))
})

check('a tool that may build an index is not concurrency-safe', () => {
  const status = toolsCtx.registered.find((tool) => tool.name === 'codegraph_status')
  assert.equal(typeof status.isConcurrencySafe, 'function', 'codegraph_status takes a writer lock when it builds')
  assert.equal(status.isConcurrencySafe({ arguments: { init: true } }), false)
  assert.equal(status.isConcurrencySafe({ arguments: {} }), true)
  for (const tool of toolsCtx.registered.filter((entry) => entry.name !== 'codegraph_status')) {
    assert.equal(tool.isConcurrencySafe?.({ arguments: { init: true } }), true, `${tool.name} only reads`)
  }
})

// ---------------------------------------------------------------------------
// §4 The prompt section.
// ---------------------------------------------------------------------------

check('the prompt section registers with a finite order and literal text', () => {
  const ctx = fakeCtx()
  plugin.apply(ctx, {})
  plugin.registerCodeGraphTools(ctx)
  plugin.registerCodeGraphPrompt(ctx)
  const section = ctx.sections[0]
  assert.equal(section.name, 'codegraph:guide')
  assert.equal(section.interpolate, false, 'the guidance quotes tool names and double quotes')
  assert.ok(Number.isFinite(section.order) && section.order > 2100, `order must be finite, got ${section.order}`)
  assert.ok(section.text({}).includes('codegraph_explore'), 'a visible scope gets the guidance')
})

check('the guidance renders empty when a preset filters the tools away', () => {
  const ctx = fakeCtx({ restrictedScope: 'restricted' })
  plugin.apply(ctx, {})
  plugin.registerCodeGraphTools(ctx)
  plugin.registerCodeGraphPrompt(ctx)
  assert.equal(ctx.sections[0].text({ scope: 'restricted' }), '', 'a scope without the tools must not be told to use them')
  assert.notEqual(ctx.sections[0].text({}), '', 'the global scope still gets the guidance')
})

check('the guidance survives a ctx.tools property that throws', () => {
  const ctx = fakeCtx()
  plugin.apply(ctx, {})
  plugin.registerCodeGraphTools(ctx)
  plugin.registerCodeGraphPrompt(ctx)
  // The exact failure recorded in docs/postmortem/0001: the property proxy's
  // ancestor-only fiber walk failing through a traceable shadow.
  Object.defineProperty(ctx, 'tools', {
    get () { throw new Error('cannot get property "tools" without inject') },
  })
  assert.ok(ctx.sections[0].text({}).length > 0, 'ctx.get must be used, never the ctx.tools property')
})

check('visibility is false when there is no registry at all', () => {
  assert.equal(codeGraphToolsVisible(fakeCtx({ noTools: true }), undefined), false)
  assert.equal(codeGraphToolsVisible(undefined, undefined), false)
  assert.equal(codeGraphToolsVisible({}, undefined), false)
})

// ---------------------------------------------------------------------------
// §5 Content bounding.
// ---------------------------------------------------------------------------

await check('every registered finalizeContent actually runs', () => {
  // Regression: `boundedContent(budget(0.5, 4000))` passes a NUMBER where a
  // function was expected, and the hook then threw `budgetOf is not a function`
  // inside `tools/post-execute` — for every tool written that way, while the two
  // written correctly kept working. Seven of nine tools were broken and the
  // earlier checks did not notice, because none of them called a finisher.
  let checked = 0
  for (const tool of toolsCtx.registered) {
    assert.equal(typeof tool.finalizeContent, 'function', `${tool.name} needs a finisher`)
    const blocks = [{ type: 'text', text: 'x'.repeat(5000) }, { type: 'image', data: 'keep' }]
    let out
    assert.doesNotThrow(
      () => { out = tool.finalizeContent({ arguments: { maxChars: 2000 } }, { content: blocks }) },
      `${tool.name} finalizeContent threw`,
    )
    if (out !== undefined) {
      assert.ok(out[0].text.length <= 2400, `${tool.name} must honour its budget`)
      assert.equal(out[1].data, 'keep', `${tool.name} must not drop attachments`)
    }
    checked += 1
  }
  assert.equal(checked, toolsCtx.registered.length, 'every tool must be checked')
})

await check('boundedContent accepts a constant as well as a function', () => {
  const constant = boundedContent(500)
  assert.ok(constant({}, { content: [{ type: 'text', text: 'y'.repeat(5000) }] })[0].text.length <= 500,
    'a number is a fixed budget, not a call')
  const fn = boundedContent(() => 300)
  assert.ok(fn({}, { content: [{ type: 'text', text: 'y'.repeat(5000) }] })[0].text.length <= 300)
})

check('boundedContent bounds text and leaves attachments alone', () => {
  const hook = boundedContent(() => 400)
  const result = hook({}, { content: [
    { type: 'text', text: 'x'.repeat(2000) },
    { type: 'image', data: 'keep-me' },
  ] })
  assert.ok(result[0].text.length <= 400, 'the text block must be bounded')
  assert.ok(result[0].text.includes('truncated'), 'the bound must say so')
  assert.equal(result[1].data, 'keep-me', 'a non-text block must survive by identity')

  // A budget too small to carry the notice gets a bare slice, so the ceiling
  // holds for every budget rather than only for large ones.
  const tiny = boundedContent(() => 10)({}, { content: [{ type: 'text', text: 'y'.repeat(500) }] })
  assert.equal(tiny[0].text.length, 10, 'a tiny budget still holds the ceiling')
})

check('boundedContent never cuts a spill locator', () => {
  const spilled = 'head text\n\n(Omitted 12345 bytes. Full formatted result stored at: /tmp/x.txt. Use read with offset/limit…)\n'
  assert.equal(isSpilled(spilled), true)
  const hook = boundedContent(() => 10)
  assert.equal(hook({}, { content: [{ type: 'text', text: spilled }] }), undefined, 'a spilled result passes through untouched')
})

check('boundedContent returns undefined when nothing changed', () => {
  const hook = boundedContent(() => 1000)
  assert.equal(hook({}, { content: [{ type: 'text', text: 'short' }] }), undefined)
  assert.equal(hook({}, { content: [] }), undefined)
})

// ---------------------------------------------------------------------------
// §6 The engine's JSON handling.
// ---------------------------------------------------------------------------

check('parseJson reads clean JSON, and JSON behind diagnostics', () => {
  assert.deepEqual(parseJson('{"initialized":true}'), { initialized: true })
  assert.deepEqual(parseJson('  [1,2]  '), [1, 2])
  assert.deepEqual(parseJson('warning: something\n{"initialized":false}'), { initialized: false })
  assert.deepEqual(parseJson('note\n[{"a":1}]'), [{ a: 1 }])
  assert.equal(parseJson(''), null)
  assert.equal(parseJson('not json at all'), null)
})

check('resolveCli resolves what a machine has, and never invents a shim', () => {
  const bare = resolveCli('')
  assert.ok(Array.isArray(bare.argv) && bare.argv.length >= 1, 'a resolved argv is required')
  assert.ok(bare.display.length > 0, 'the display label is what diagnostics report')
  if (process.platform !== 'win32') {
    assert.deepEqual(bare.argv, ['codegraph'], 'on Linux the bare name is spawnable')
    return
  }

  // What the resolver may legitimately hand back on Windows, and what each form
  // means. The point of the check is the invariant, not the route: a `.cmd` is
  // never handed to `spawn` as-is, because the seam refuses it and the failure
  // reads as a missing CLI on a machine where it works in a terminal.
  const hasCodegraph = globalPrefixesForTest().some((root) =>
    existsSync(join(root, 'node_modules', '@colbymchenry', 'codegraph')))
  if (bare.argv.length === 4) {
    // The per-platform bundle's own runtime and entry.
    assert.ok(bare.argv[0].endsWith('node.exe'), `argv[0] must be a real executable, got ${bare.argv[0]}`)
    assert.equal(bare.argv[1], '--liftoff-only', 'the bundle shim passes liftoff-only')
    assert.ok(bare.argv.at(-1).endsWith('.js'), 'the final argument is the script to run')
    assert.ok(existsSync(bare.argv[0]), 'and that executable exists on this machine')
    assert.ok(existsSync(bare.argv.at(-1)), 'and the entry script with it')
    return
  }
  if (hasCodegraph) {
    // Something is installed, so a bare name would be the unspawnable shim.
    assert.notEqual(bare.argv[0], 'codegraph', 'a bare codegraph on a machine that has it is the unspawnable .cmd')
    assert.equal(bare.argv.length, 2, 'the shim is run under Node')
    assert.equal(bare.argv[0], process.execPath, "through this process's own runtime")
    return
  }
  // Nothing installed: the bare name is the honest answer, and the caller
  // reports cli-missing with the install command.
  assert.deepEqual(bare.argv, ['codegraph'], 'nothing installed means the bare name, reported as cli-missing')

  const configured = resolveCli('C:/tools/codegraph.cmd')
  assert.equal(configured.argv.length, 2, 'an explicit .cmd is also run through Node')
  assert.equal(configured.argv[0], process.execPath, "through this process's own runtime")
})

/**
 * The global prefixes `resolveCli` searches, read the same way it reads them.
 *
 * @returns {string[]} the candidate prefix directories.
 */
function globalPrefixesForTest () {
  const prefixes = []
  const declared = process.env.npm_config_prefix
  if (typeof declared === 'string' && declared !== '') prefixes.push(declared)
  const appData = process.env.APPDATA
  if (typeof appData === 'string' && appData !== '') prefixes.push(join(appData, 'npm'))
  return prefixes
}

check('usableCwd accepts a real directory and rejects a fake one', () => {
  // The harness runs from inside its own app.asar, so a project root a model
  // names can be a path this process can only see through Electron's patched
  // fs. Windows resolves a child's cwd before its executable, so that path
  // must never reach CreateProcessW: the seam reports the failure as
  // `spawn <argv[0]> ENOENT` and sends the reader to reinstall a working CLI.
  assert.equal(usableCwd(ROOT), ROOT, 'a directory that exists is used as given')
  assert.equal(usableCwd(join(ROOT, 'scripts')), join(ROOT, 'scripts'), 'a nested directory is used as given')
  const asarLike = join(ROOT, 'app.asar', 'dsh')
  assert.notEqual(usableCwd(asarLike), asarLike, 'an asar-internal root must not reach the child')
  assert.ok(existsSync(usableCwd(asarLike)), 'and the fallback must exist on this machine')
  assert.equal(usableCwd('   '), usableCwd(''), 'blank input is not a directory')
  assert.equal(usableCwd(undefined), usableCwd(null), 'absent input falls back, it does not throw')
})

check('runCodegraph hands the child a directory the OS can resolve', async () => {
  // End-to-end through the real engine, so a regression in the cwd hand-off
  // cannot hide behind a stub. The fake subprocess service records the spec.
  const specs = []
  const fake = {
    spawn (spec) {
      specs.push(spec)
      return { stdout: null, stderr: null, done: Promise.resolve({ exitCode: 0, signal: null }) }
    },
  }
  const ctx = fakeCtx({ subprocess: fake })
  const run = runCodegraph(ctx, ['status', 'anything', '--json'], {
    cliPath: '',
    timeoutMs: 5000,
    cwd: join(ROOT, 'app.asar', 'dsh'),
  })
  await run.catch(() => {})
  assert.equal(specs.length, 1, 'exactly one spawn for one command')
  assert.ok(existsSync(specs[0].cwd), `the child cwd must exist on disk, got ${specs[0].cwd}`)
  assert.ok(statSync(specs[0].cwd).isDirectory(), 'and be a directory')
})

check('resolveCli resolves a .cmd shim rather than an unspawnable bare name', async () => {
  // A machine whose npm prefix holds codegraph.cmd but whose per-platform bundle
  // is absent used to fall through to the bare name, which the seam refuses to
  // spawn: every call failed with ENOENT on a machine where the CLI works in a
  // terminal. The shim is now run under Node, which is what it expects.
  if (process.platform !== 'win32') return
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const prefix = mkdtempSync(join(tmpdir(), 'cg-shim-'))
  const appData = join(prefix, 'appdata')
  // The prefix this resolver derives from APPDATA is `<APPDATA>/npm`.
  mkdirSync(join(appData, 'npm'), { recursive: true })
  const shimPath = join(appData, 'npm', 'codegraph.cmd')
  writeFileSync(shimPath, '@echo off\r\necho shim\r\n')

  const saved = process.env.APPDATA
  delete process.env.npm_config_prefix
  process.env.APPDATA = appData
  let resolved
  try {
    resolved = resolveCli('')
  } finally {
    if (saved === undefined) delete process.env.APPDATA
    else process.env.APPDATA = saved
    rmSync(prefix, { recursive: true, force: true })
  }

  assert.notEqual(resolved.argv[0], 'codegraph', 'a bare codegraph is the shim spawn refuses')
  assert.equal(resolved.argv.length, 2, 'the shim is run under a runtime')
  assert.equal(resolved.argv[1], shimPath, 'and the shim is the script')
})

check('resolveCli prefers the platform bundle when one is installed', () => {
  // On a Windows host where codegraph came from npm, the only always-executable
  // candidate is the per-platform bundle's own node.exe: the harness may run
  // under Electron (execPath is an app host) and the seam's resolver never
  // tries the `.cmd` shim that a bare PATH name resolves to.
  //
  // A CI runner has no global codegraph at all, so there is no bundle to find
  // and nothing to assert beyond what the previous check already pins. The
  // route is asserted only where it can be observed, so a machine that cannot
  // take it does not fail the suite for it.
  if (process.platform !== 'win32') return
  const bare = resolveCli('')
  if (bare.argv.length !== 4) return
  assert.equal(bare.argv[1], '--liftoff-only', 'the bundle shim passes liftoff-only')
  assert.equal(bare.argv[2], '--disable-warning=ExperimentalWarning', 'and suppresses the sqlite notice that would front --json')
  assert.ok(bare.argv.at(-1).endsWith('.js'), 'the final argument is the CLI entry script')
  assert.ok(existsSync(bare.argv[0]), 'the bundle node.exe must exist on disk')
  assert.ok(existsSync(bare.argv.at(-1)), 'and the entry script with it')
})

check('OUTCOME values are frozen and dispatchable', () => {
  assert.equal(Object.isFrozen(OUTCOME), true)
  for (const [key, value] of Object.entries(OUTCOME)) {
    assert.equal(typeof value, 'string', `${key} must be a string a model can match on`)
  }
})

// ---------------------------------------------------------------------------
// §7 The ancestor-index hazard.
//
// `codegraph status` walks UP the directory tree, so a project with no index of
// its own resolves an ancestor's graph and reports it as its own. A query that
// trusted that would answer a question about one repository with facts from
// another — the exact "wrong answer that looks right" the plugin exists to avoid.
// ---------------------------------------------------------------------------

check('an ancestor index is flagged rather than adopted', () => {
  const OWN = 'C:/work/project'
  const own = verifyOwnIndex(OWN, { indexPath: 'C:/work/project/.codegraph', projectPath: OWN })
  assert.equal(own.ancestorIndex, undefined, 'a project\'s own index is not flagged')
  assert.equal(own.indexPath, 'C:/work/project/.codegraph')

  // Same path, different case and separator: Windows treats these as one path.
  assert.equal(verifyOwnIndex(OWN, { indexPath: 'C:\\work\\project\\.codegraph' }).ancestorIndex, undefined)

  const foreign = verifyOwnIndex(OWN, { indexPath: 'C:/work/.codegraph', projectPath: 'C:/work' })
  assert.equal(foreign.ancestorIndex, true, 'an ancestor index must be flagged')
  assert.equal(foreign.projectPath, 'C:/work', 'and the project it really belongs to is reported')
})

await check('ensureIndexed refuses to answer from an ancestor index', async () => {
  const config = resolveConfig({ autoInit: false })
  const runtime = new CodeGraphRuntime({ ctx: fakeCtx(), config, log: () => {} })
  runtime.status = async () => ({ ok: true, ancestorIndex: true, projectPath: 'C:/work', indexPath: 'C:/work/.codegraph' })
  const result = await runtime.ensureIndexed({ root: 'C:/work/project' })
  assert.equal(result.ok, false, 'the query must not proceed')
  assert.equal(result.outcome, OUTCOME.indexElsewhere)
  assert.ok(result.guidance.includes('C:/work'), 'the guidance names the project that was found')
})

await check('a child inside an indexed project is still refused without autoInit', async () => {
  const runtime = new CodeGraphRuntime({ ctx: fakeCtx(), config: resolveConfig({ autoInit: false }), log: () => {} })
  runtime.status = async () => ({ ok: true, ancestorIndex: true, projectPath: 'C:/work', indexPath: 'C:/work/.codegraph' })
  const result = await runtime.ensureIndexed({ root: 'C:/work/project/packages/app' })
  assert.equal(result.outcome, OUTCOME.indexElsewhere, 'a subdirectory is not the indexed project')
})

await check('the status tool surfaces the ancestor project rather than hiding it', async () => {
  const ctx = fakeCtx()
  plugin.apply(ctx, {})
  plugin.registerCodeGraphTools(ctx)
  const runtime = ctx.get('codeGraph')
  runtime.status = async () => ({
    ok: true, ancestorIndex: true, projectPath: 'C:/work', indexPath: 'C:/work/.codegraph',
    fileCount: 10, nodeCount: 20, edgeCount: 30, dbSize: '1 KB',
  })
  const status = ctx.registered.find((tool) => tool.name === 'codegraph_status')
  const text = status.output.render({}, await status.execute({ path: 'C:/work/project' }, { arguments: {} }))[0].text
  assert.ok(text.includes('C:/work'), 'the status report names the project the index really covers')
  assert.ok(!text.includes('ok": true') || text.includes('projectPath'), 'and still reports it as this project\'s answer')
})

// ---------------------------------------------------------------------------
// §8 The writer lock is a refusal, never a word in an answer.
//
// `explore` answers with upstream's own guidance prose, which tells the model to
// "run another codegraph_explore". The first pattern this plugin used matched
// that prose on a **successful** run, so a fully answered `explore` was reported
// as `writer-locked`. Two fixes, both covered here: the pattern now requires the
// word "lock", and `#exec` only classifies a run that actually failed.
// ---------------------------------------------------------------------------

check('the writer-lock pattern matches upstream\'s message, not an answer', () => {
  // Upstream's own wording (mcp/writer-lock.js, sync/watcher.js).
  assert.equal(WRITER_LOCK.test('CodeGraph writer lock held by PID 123 (daemon mode).'), true)
  assert.equal(WRITER_LOCK.test('CodeGraph file lock held by another process past the retry budget'), true)
  assert.equal(WRITER_LOCK.test('another index rebuild is already in progress'), false)
  assert.equal(WRITER_LOCK.test('EACCES: writer-lock is opened by another pid'), true)

  // The guidance prose `explore` returns in every successful answer.
  assert.equal(WRITER_LOCK.test('run another codegraph_explore with the specific names rather than reading'), false)
  assert.equal(WRITER_LOCK.test("... text for a re-exported specifier's declaration lives in the file that specifier names."), false)
  assert.equal(WRITER_LOCK.test('a live MCP daemon keeps SQLite handles open; verify it by its socket'), false)
})

check('a successful run is never reclassified as writer-locked', async () => {
  // The regression end to end: a run that answered, exit code 0, carrying the
  // guidance prose upstream puts in every explore result. The old pattern
  // matched "another codegraph_explore" here and reported a lock.
  const successful = { stdout: '… run another codegraph_explore with those names …', stderr: '', exitCode: 0 }
  const result = classify(successful)
  assert.equal(result.ok, true, 'a successful run must not be reported as a failure')
  assert.equal(result.value, successful)
})

await check('a failed run still reports the writer lock', async () => {
  const refused = { stdout: '', stderr: 'CodeGraph writer lock held by PID 4711 (daemon mode).', exitCode: 1 }
  const result = classify(refused)
  assert.equal(result.outcome, OUTCOME.writerLocked, 'a real refusal must still be classified')
  assert.ok(result.guidance.includes('codegraph daemon'), 'with the same actionable guidance')
})

check('a run that merely mentions a lock is not a lock failure', async () => {
  // An answer that quotes the lock module in its source prose.
  const prose = { stdout: 'the writer lock module owns this; another process reads it', stderr: '', exitCode: 0 }
  assert.equal(classify(prose).ok, true, 'an answer that mentions a lock is still an answer')
})

// ---------------------------------------------------------------------------

/**
 * A subprocess service that records each spawn spec and answers with a script.
 *
 * The engine's own promise plumbing is what runs, so a rule about argv, cwd or
 * timeout is exercised against the shipped path rather than a re-implementation.
 *
 * @param {{ stdout?: string, stderr?: string, exitCode?: number|null, onSpawn?: (spec: any) => void }} [script] - what each child answers with.
 * @returns {any} the fake service.
 */
function runStub (script = {}) {
  const stdout = script.stdout ?? ''
  const stderr = script.stderr ?? ''
  const exitCode = script.exitCode ?? 0
  return {
    spawn (spec) {
      script.onSpawn?.(spec)
      return {
        stdout: streamOf(stdout),
        stderr: streamOf(stderr),
        done: Promise.resolve({ exitCode, signal: null }),
        terminate () {},
      }
    },
  }
}

/**
 * A one-chunk readable stream, shaped like a child pipe.
 *
 * @param {string} text - the text the stream delivers, empty for none.
 * @returns {any} the readable.
 */
function streamOf (text) {
  return Readable.from(text === '' ? [] : [text])
}

check('spawnedCommand reads the sub-command on every platform shape', () => {
  // `resolveCli` produces a different argv per platform: Windows prepends a
  // bundled node.exe and two V8 flags to the entry script, Linux gets a bare
  // `codegraph` with no script path at all. A fixed index into argv is what made
  // a build-command check pass on Windows and fail on Linux in CI.
  assert.equal(spawnedCommand(['C:/b/node.exe', '--liftoff-only', '--disable-warning=ExperimentalWarning', 'C:/b/lib/dist/bin/codegraph.js', 'init', 'C:/proj']), 'init', 'the Windows bundle form')
  assert.equal(spawnedCommand(['C:/Program Files/nodejs/node.exe', 'C:/npm/codegraph/npm-shim.js', 'sync', '/p']), 'sync', 'the npm shim through Node')
  assert.equal(spawnedCommand(['codegraph', 'init', '/home/runner/work/p']), 'init', 'the Linux bare name with init')
  assert.equal(spawnedCommand(['codegraph', 'status', '/p', '--json']), 'status', 'the Linux bare name with a flag')
  assert.equal(spawnedCommand(['codegraph']), '', 'a bare name with no sub-command is empty, not the executable')
})

/**
 * A subprocess service whose spawn throws, like a failed launch does.
 *
 * @param {string} message - the error the launch fails with.
 * @returns {any} the fake service.
 */
function throwingService (message) {
  return { spawn () { throw new Error(message) } }
}

/**
 * The CodeGraph sub-command one spawn spec runs.
 *
 * The argument vector has a **different shape on each platform**: Windows gets a
 * bundled `node.exe` plus two V8 flags in front of the entry script
 * (`…/lib/dist/bin/codegraph.js init <root>`), while Linux gets a bare
 * `codegraph` with no script path at all (`codegraph init <root>`). Asserting on
 * a fixed index is what made a check pass on one platform and fail on the other,
 * so the name is read past whichever form is present.
 *
 * @param {string[]} argv - the spawned argument vector.
 * @returns {string} the sub-command name, or '' when there is none.
 */
function spawnedCommand (argv) {
  const values = argv.map((value) => String(value))
  // A bare `codegraph` on PATH is the executable, not part of the answer.
  const withoutExecutable = values.length > 0 && values[0].endsWith('codegraph') && !values[0].endsWith('.js')
    ? values.slice(1)
    : values
  const lastScript = withoutExecutable.reduce((found, value, index) => (/\.m?js$/i.test(value) ? index : found), -1)
  return withoutExecutable.slice(lastScript + 1).find((value) => !value.startsWith('-')) ?? ''
}

/**
 * A subprocess service whose spawn records the CodeGraph sub-command name.
 *
 * @param {{ calls: string[] }} box - where the command names are recorded.
 * @returns {any} the fake service.
 */
function recordingService (box) {
  return {
    spawn (spec) {
      box.calls.push(spawnedCommand(spec.argv))
      return {
        stdout: streamOf(''),
        stderr: streamOf(''),
        done: Promise.resolve({ exitCode: 0, signal: null }),
        terminate () {},
      }
    },
  }
}

/**
 * Classify one scripted child run through the shipped classifier.
 *
 * @param {{ stdout: string, stderr: string, exitCode: number|null }} run - the run to classify.
 * @returns {Record<string, any>} the classifier's value or failure value.
 */
function classify (run) {
  const runtime = new CodeGraphRuntime({ ctx: fakeCtx(), config: resolveConfig({}), log: () => {} })
  return runtime.classifyRun(run, undefined, ROOT)
}

/**
 * Build a context whose service is already mounted, for the entry-module checks.
 *
 * @returns {any} the fake context.
 */
function fakeCtxWithService () {
  const ctx = fakeCtx()
  plugin.apply(ctx, {})
  return ctx
}

process.stdout.write('\ndsh-codegraph plugin contract: all checks passed\n')
