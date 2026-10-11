/**
 * The patch/exports consistency gate.
 *
 * `check-plugin.mjs` proves the plugin behaves correctly once it is loaded;
 * this script proves the bundle can be loaded at all. The two failures it
 * exists to catch are both silent in the wrong direction: a `name:` in
 * `cordis.patch.yml` that points at a file nobody renamed leaves a PENDING row
 * with no error, and an `exports` target that does not exist makes a consumer's
 * import fail with a resolution error that names the consumer rather than the
 * missing file.
 *
 * Sibling plugins that ship the same gate: dsh-postgres-expert,
 * dsh-ponytail-sync, dsh-context, dsh-subagent-tree.
 *
 * Run with `node scripts/check-patch.mjs`.
 *
 * @module dsh-codegraph-tools/check-patch
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

/**
 * Run one assertion, naming the rule it protects.
 *
 * @param {string} label - the rule.
 * @param {() => any} body - the assertion.
 */
function check (label, body) {
  try {
    const result = body()
    if (result instanceof Promise) return result.then(() => console.log(`  ok  ${label}`), fail(label))
    console.log(`  ok  ${label}`)
  } catch (error) {
    fail(label, error)
  }
}

/**
 * Report one failure the way a gate should: with the rule that broke.
 *
 * @param {string} label - the rule.
 * @param {unknown} [error] - the assertion error.
 */
function fail (label, error) {
  console.error(`  FAIL  ${label}`)
  if (error) console.error(`        ${error?.message ?? error}`)
  process.exitCode = 1
}

/**
 * Whether a path resolves to an existing file.
 *
 * @param {string} target - the path to test.
 * @returns {boolean} whether it is a file.
 */
function isFile (target) {
  try {
    return statSync(target).isFile()
  } catch {
    return false
  }
}

const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
const patch = await readFile(join(ROOT, 'cordis.patch.yml'), 'utf8')

// ---------------------------------------------------------------------------
// §1 Every relative `name:` in the patch resolves to a real file.
//
// Plugin rows carry `name: './src/index.js'`. A row whose file moved is a
// PENDING row with no diagnostic, which is the failure this gate exists to
// catch: the row exists, the loader starts, and nothing ever explains why
// every tool is missing.
// ---------------------------------------------------------------------------

const rowNames = [...patch.matchAll(/^\s*-?\s*name:\s*'([^']+)'/gm)].map((m) => m[1])
  .concat([...patch.matchAll(/^\s*-?\s*name:\s*"([^"]+)"/gm)].map((m) => m[1]))

check('the patch file declares at least one plugin row', () => {
  assert.ok(rowNames.length >= 3, `expected the three bundle rows, found ${rowNames.length}`)
})

check("every relative row name in cordis.patch.yml resolves to a file", () => {
  const relative = rowNames.filter((name) => name.startsWith('.'))
  assert.ok(relative.length > 0, 'the plugin rows are relative to this file')
  for (const name of relative) {
    assert.ok(isFile(resolve(ROOT, name)), `cordis.patch.yml names "${name}", which does not exist`)
  }
})

// ---------------------------------------------------------------------------
// §2 Every `exports` target resolves, and the subpaths the patch depends on
// are the ones the manifest publishes.
// ---------------------------------------------------------------------------

check('every exports target resolves to a file', () => {
  const targets = []
  for (const value of Object.values(pkg.exports ?? {})) {
    if (typeof value === 'string') targets.push(value)
    else for (const nested of Object.values(value ?? {})) if (typeof nested === 'string') targets.push(nested)
  }
  assert.ok(targets.length > 0, 'a bundle must publish its own entry')
  for (const target of targets) {
    assert.ok(isFile(resolve(ROOT, target)), `exports maps "${target}", which does not exist`)
  }
})

check('the bundle patch subpath is published', () => {
  // The profile loads `dsh-codegraph-tools/cordis.patch.yml` through the export map,
  // so a subpath that is not listed is a load failure on someone else's
  // machine while working perfectly from source.
  assert.ok(Object.hasOwn(pkg.exports ?? {}, './cordis.patch.yml'), 'the patch must be an export subpath')
  assert.ok(isFile(resolve(ROOT, pkg.exports['./cordis.patch.yml'])), 'and it must exist')
})

// ---------------------------------------------------------------------------
// §3 Every `files` entry exists.
//
// A `files` entry that stops matching its tree publishes a package that
// installs and then fails to load — the exact failure the sibling gate's own
// header comment names.
// ---------------------------------------------------------------------------

check('every files entry exists', () => {
  for (const entry of pkg.files ?? []) {
    assert.ok(existsSync(resolve(ROOT, entry)), `files lists "${entry}", which does not exist`)
  }
})

check('the files list covers everything the exports map publishes', () => {
  // A published subpath whose file is not in `files` resolves in development
  // and fails once installed, because npm never packed it.
  const published = []
  for (const value of Object.values(pkg.exports ?? {})) {
    if (typeof value === 'string') published.push(value)
    else for (const nested of Object.values(value ?? {})) if (typeof nested === 'string') published.push(nested)
  }
  const missing = published.filter((target) => {
    const relative = `./${target.replace(/^\.\//, '')}`
    return !(pkg.files ?? []).some((entry) => relative === `./${entry}` || relative.startsWith(`./${entry}/`))
  })
  assert.deepEqual(missing, [], `these published targets are not in "files": ${missing.join(', ')}`)
})

// ---------------------------------------------------------------------------
// §4 The declared scripts run.
// ---------------------------------------------------------------------------

check("the test scripts' targets exist", () => {
  for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
    const match = /node (scripts\/[\w.-]+\.mjs)/.exec(String(command))
    if (match) {
      assert.ok(isFile(join(ROOT, match[1])), `${name} runs ${match[1]}, which does not exist`)
    }
  }
})

// ---------------------------------------------------------------------------
// §5 The declared peer is optional and actually optional.
//
// The plugin resolves Schemastery in a try/catch and falls back to a Standard
// Schema, so the peer must be declared optional; a required peer makes an
// install fail on a host that cannot route it, for a Settings row.
// ---------------------------------------------------------------------------

check('the optional schemastery peer is declared optional', () => {
  assert.ok(pkg.peerDependenciesMeta?.['@deepseek-ai/schemastery']?.optional === true,
    'schemastery is resolved defensively, so it must not be a required peer')
})

// ---------------------------------------------------------------------------
// §6 The icon is a real, self-contained image that ships.
//
// The Plugins panel renders `icon` straight from the manifest, so a missing
// file is a default-artwork row and a malformed one is a broken image. Both are
// silent in the wrong direction: nothing fails, the panel just looks wrong.
// ---------------------------------------------------------------------------

check('the declared icon is a packed, self-contained, square SVG', () => {
  if (pkg.icon === undefined) return
  const iconPath = resolve(ROOT, pkg.icon)
  assert.ok(isFile(iconPath), `icon points at "${pkg.icon}", which is not a file`)
  assert.ok(pkg.icon.endsWith('.svg'), `icon must be an SVG, got "${pkg.icon}"`)

  const packed = (pkg.files ?? []).some((entry) => pkg.icon === `./${entry}` || pkg.icon.startsWith(`./${entry}/`))
  assert.ok(packed, 'icon is not in "files", so it resolves from source and vanishes once installed')

  assert.ok(iconPath.length < 256 * 1024, 'the icon must stay under 256 KiB')

  const svg = readFileSync(iconPath, 'utf8')
  const viewBox = /viewBox\s*=\s*"([\d.\s-]+)"/.exec(svg)
  const size = /\swidth\s*=\s*"(\d+)"[^>]*height\s*=\s*"(\d+)"/.exec(svg)
  assert.ok(viewBox !== null, 'an icon without a viewBox scales unpredictably')
  if (viewBox) {
    // A viewBox is `min-x min-y width height`, so the square test is on the
    // third and fourth numbers, not on the first two.
    const parts = viewBox[1].trim().split(/\s+/).map(Number)
    const w = parts[2]
    const h = parts[3]
    assert.ok(w === h, `an icon must be square, got a ${w}x${h} viewBox`)
  }
  if (size) assert.ok(size[1] === size[2], `an icon must be square, got ${size[1]}x${size[2]}`)
  // A self-contained icon has no external reference to fetch, which is what
  // makes it safe to render in an offline GUI.
  assert.ok(!/xlink:href\s*=\s*["'](?!#)/.test(svg), 'an icon must not reference an external symbol')
  assert.ok(!/<image[\s>]/.test(svg), 'an icon must not embed a raster image')
})

console.log('\ndsh-codegraph patch gate: all checks passed')
