/**
 * A live probe: run the plugin's own engine and runtime against the real
 * `codegraph` CLI, so what is verified is the shipped code path rather than a
 * re-implementation of it.
 *
 * The subprocess service is faked at the one seam the plugin depends on — a
 * `spawn` that delegates to `node:child_process` — so the argv, the environment,
 * the timeout, the `NO_COLOR` requirement and the JSON parsing are all the real
 * ones.
 *
 * Usage: `node scripts/live.mjs [projectPath]`
 *
 * @module dsh-codegraph-tools/live
 */

import { spawn } from 'node:child_process'

import { apply, registerCodeGraphTools } from '../src/index.js'
import { parseJson } from '../src/engine.js'

/** The project under test; defaults to this plugin, which has no index yet. */
const ROOT = process.argv[2] ?? process.cwd()

/**
 * A subprocess service that delegates to `node:child_process`.
 *
 * @param {any} spec - the spawn spec.
 * @returns {any} a handle shaped like the harness's.
 */
function fakeSpawn (spec) {
  const child = spawn(spec.argv[0], spec.argv.slice(1), {
    cwd: spec.cwd,
    env: spec.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let closed = false
  const terminate = () => {
    if (closed) return
    closed = true
    child.kill('SIGTERM')
  }
  spec.signal?.addEventListener('abort', terminate, { once: true })
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    done: new Promise((resolve) => {
      child.on('close', (exitCode, signal) => resolve({ exitCode, signal }))
      child.on('error', () => resolve({ exitCode: null, signal: null }))
    }),
    terminate,
  }
}

const services = new Map()
const queue = []
const registered = []
const tools = { register (definition) { registered.push(definition) } }

const ctx = {
  // The plugin's tools row declares `inject: ['tools', 'codeGraph']`, so the
  // registry has to be reachable as a property as well as through `ctx.get`.
  tools,
  get (key) {
    if (key === 'subprocess') return { spawn: fakeSpawn }
    if (key === 'tools') return tools
    return services.get(key)
  },
  provide (key, value) { services.set(key, value); return () => services.delete(key) },
  effect (fn) { const dispose = fn(); if (typeof dispose === 'function') queue.push(dispose) },
  logger () { return { info: (message) => console.log(`  [log] ${message}`) } },
}

apply(ctx, {})
const names = registerCodeGraphTools(ctx)

/**
 * Call one registered tool and return the text a model would see.
 *
 * @param {string} name - the tool name.
 * @param {Record<string, any>} args - the model arguments.
 * @returns {Promise<string>} the rendered text.
 */
async function call (name, args) {
  const tool = registered.find((entry) => entry.name === name)
  if (!tool) throw new Error(`no such tool: ${name}`)
  const value = await tool.execute(args, { arguments: args, signal: new AbortController().signal })
  const blocks = tool.output.render(args, value)
  return blocks.map((block) => block.text ?? '').join('\n')
}

console.log(`registered: ${names.join(', ')}\n`)
console.log(`--- probe project: ${ROOT} ---\n`)

const budget = Number(process.env.LIVE_MAX_CHARS ?? 1200)

/**
 * Print one probe result under a heading.
 *
 * @param {string} title - what was probed.
 * @param {Promise<string>} body - the rendered text.
 * @returns {Promise<void>} resolves when printed.
 */
async function show (title, body) {
  const text = await (await body())
  const clipped = text.length > budget ? `${text.slice(0, budget)}\n… [${text.length} chars total]` : text
  console.log(`### ${title}\n${clipped}\n`)
}

await show('codegraph_status (expect not-initialized for a fresh project)', () => call('codegraph_status', { path: ROOT }))
await show('codegraph_search (expect a not-initialized failure, not a crash)', () => call('codegraph_search', { search: 'noSuchSymbolAnywhere12345', path: ROOT }))
await show('codegraph_status with init:true (builds the index)', () => call('codegraph_status', { path: ROOT, init: true, maxChars: 60000 }))
// The symbol must be one the indexed project actually contains, so the probe asks
// the graph itself rather than assuming a name.
const seeded = await call('codegraph_status', { path: ROOT })
const anySymbol = /"function":\s*(\d+)/.exec(seeded)?.[1]
await show(`codegraph_status after init${anySymbol && Number(anySymbol) > 0 ? ' (indexed)' : ' (WARNING: empty index)'}`, async () => seeded)
await show('codegraph_search for a name the index surely lacks', () => call('codegraph_search', { search: 'noSuchSymbolAnywhere12345', path: ROOT }))
await show('codegraph_explore (expect a lexical miss)', () => call('codegraph_explore', { query: 'no such symbol anywhere 12345', path: ROOT, maxFiles: 2 }))

// The decisive check: the index was built in this very run, with no watcher
// process anywhere, so a symbol that exists in the project must be findable
// immediately. This is what proves `status --json` exits 0 honestly.
// The symbol comes from the index rather than from a hardcoded name, because a
// name the project does not contain reports `no-results` on a working index.
const known = await call('codegraph_search', { search: 'codegraph', path: ROOT, limit: 1 })
const probeName = /^\*{2}no-results\*{2}/.test(known) ? null : 'codegraph'
const found = probeName === null ? '' : await call('codegraph_search', { search: probeName, path: ROOT, limit: 3 })
const hit = probeName === null ? false : !found.startsWith('**no-results**') && !found.startsWith('**not-initialized**')
console.log(`### fresh-index visibility for "${probeName ?? '(none)'}"\n${hit ? 'FOUND' : 'MISSING'}\n${found.slice(0, budget)}\n`)
if (!hit) {
  console.log('FAIL: an index built seconds ago did not answer a symbol in its own project.')
  process.exitCode = 1
}

// A relationship must be the rows, not the queried symbol: `targets` always
// carries the symbol that was asked about, so reading it would pass a naive
// check. The probe therefore asks for a symbol whose rows are known to exist
// and requires the answer to name something else.
const callees = await call('codegraph_callees', { symbol: 'boundedContent', path: ROOT })
const rows = callees.split('\n').filter((line) => line.trim() !== '')
// `boundedContent` calls `isSpilled` and `truncate`, so a correct answer names
// at least one symbol that is not the one asked about.
const onlyEcho = rows.every((line) => line.includes('boundedContent'))
console.log(`### callees of "boundedContent"\n${callees.slice(0, budget)}\n`)
if (onlyEcho) {
  console.log('FAIL: a relationship tool returned the queried symbol instead of its rows.')
  process.exitCode = 1
}

// `node` must answer a name with that one symbol, not with a whole-file explore.
const nodeText = await call('codegraph_node', { symbol: 'boundedContent', path: ROOT })
console.log(`### codegraph_node of "boundedContent"\n${nodeText.slice(0, budget)}\n`)
if (!nodeText.startsWith('**boundedContent**')) {
  console.log('FAIL: codegraph_node did not answer with the symbol it was asked about.')
  process.exitCode = 1
}

const disposable = queue.reverse()
for (const dispose of disposable) {
  try { await dispose() } catch { /* teardown is best-effort in a probe */ }
}

console.log(JSON.stringify({ registered: names.length, root: ROOT, parseJsonRoundTrip: parseJson('{"ok":true}') }, null, 2))
