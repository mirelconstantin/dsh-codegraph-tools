/**
 * The model-facing CodeGraph tools.
 *
 * Seven tools, one job each: explore an area, find a symbol, read its source,
 * see what calls it, see what it calls, measure the blast radius, and report or
 * build the index.
 *
 * ### Two truncation layers, and they must agree
 *
 * `render*` applies **no budget**: a budget applied to serialised JSON cuts the
 * trailing keys — which are exactly the paging and count fields — and hands the
 * model invalid JSON with no way to continue. The bound belongs in
 * {@link boundedContent}, the content-only last-mile hook, and it must equal
 * what was actually rendered.
 *
 * ### A spilled result is sacred
 *
 * `dsh-spill-policy` runs at `tools/post-execute`, before this finisher, and
 * replaces an over-budget result with a head, a tail, and a **retrieval locator**.
 * Cutting the tail off leaves the model a preview it cannot go and get, so a
 * spilled result passes through untouched.
 *
 * @module dsh-codegraph-tools/tools
 */

import { clampInt, truncate } from './util.js'

/**
 * Name of the Cordis service these tools call.
 *
 * @type {string}
 */
const SERVICE = 'codeGraph'

/**
 * Marker substrings that identify a spill locator.
 *
 * @type {readonly string[]}
 */
const SPILL_MARKERS = Object.freeze([
  'Full formatted result stored at:',
  'result stored at:',
])

/**
 * Whether one text block is a retained spill preview.
 *
 * Deliberately conservative: a false positive costs one oversized result, a
 * false negative costs the model the only copy of the answer it can retrieve.
 *
 * @param {string} text - the block's text.
 * @returns {boolean} whether it carries a spill locator.
 */
export function isSpilled (text) {
  if (typeof text !== 'string' || text.length < 32) return false
  for (const marker of SPILL_MARKERS) {
    if (text.includes(marker)) return true
  }
  if (/\[truncated [^\]]*\bsaved to\b/i.test(text)) return true
  return /(?:\n\n|\A)\((?:Omitted \d+ bytes\.|More bytes were omitted\.)[^)]*\)\s*\z/.test(text)
}

/**
 * Build a `finalizeContent` hook that bounds text blocks and nothing else.
 *
 * The budget may be a function of the execution or a constant. Accepting both is
 * deliberate: a caller passing `budget(0.5, 4000)` instead of `() => budget(0.5,
 * 4000)` is the natural mistake, and it produced a hook that threw
 * `budgetOf is not a function` at `tools/post-execute` — inside every call to the
 * affected tools, while the ones written correctly kept working. A number here is
 * therefore read as a fixed budget rather than invoked.
 *
 * @param {(exec: any) => number} budgetOf - the character budget for one call.
 * @returns {(exec: any, result: any) => Array<any>|undefined} the hook.
 */
export function boundedContent (budgetOf) {
  const budgetFor = typeof budgetOf === 'function' ? budgetOf : () => budgetOf
  return (exec, result) => {
    const blocks = Array.isArray(result?.content) ? result.content : []
    if (blocks.length === 0) return undefined

    // The spilled shape is decided on the whole array before a single block is
    // touched: a locator can be the last block on its own, so deciding per block
    // would bound the blocks before it and still lose the pointer.
    if (blocks.some((block) => block?.type === 'text' && isSpilled(block.text))) return undefined

    const budget = budgetFor(exec)
    if (!Number.isFinite(budget) || budget <= 0) return undefined

    let left = budget
    let changed = false
    const next = []
    for (const block of blocks) {
      // Non-text blocks pass through by identity: a finisher that rebuilt the
      // array from text blocks alone would delete every attachment.
      if (block?.type !== 'text' || typeof block.text !== 'string') {
        next.push(block)
        continue
      }
      if (left <= 0) {
        next.push({ type: 'text', text: '' })
        changed = true
        continue
      }
      if (block.text.length > left) {
        next.push({ type: 'text', text: truncate(block.text, left, 'code graph result') })
        left = 0
        changed = true
        continue
      }
      left -= block.text.length
      next.push(block)
    }
    return changed ? next : undefined
  }
}

/**
 * Format a canonical tool value for the model.
 *
 * There is deliberately no character budget here; see the module note.
 *
 * @param {any} value - the canonical value.
 * @returns {string} the rendered text.
 */
export function renderValue (value) {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && value.markdown !== undefined) return String(value.markdown)
  return JSON.stringify(value, null, 2) ?? ''
}

/**
 * Render a relationship result as a compact table.
 *
 * A symbol list is overwhelmingly `name — kind — file:line`, and a table carries
 * that in a third of the characters the same rows take as JSON.
 *
 * @param {Record<string, any>} value - a successful relationship value.
 * @returns {string} the rendered text.
 */
function renderRelation (value) {
  const rows = Array.isArray(value.entries) ? value.entries : []
  if (rows.length === 0) {
    return value.command === 'impact'
      ? `Nothing in the index would be affected by changing \`${value.symbol}\` within depth ${value.depth ?? '?'}.`
      : `No indexed relationship for "${value.symbol}".`
  }

  const lines = []
  if (value.command === 'impact') {
    lines.push(`**Blast radius of \`${value.symbol}\`** (depth ${value.depth ?? '?'}): ${value.total} symbol(s) would be affected.`, '')
  }
  const kindWidth = Math.max(...rows.map((row) => String(row.kind ?? '').length), 4)
  const nameWidth = Math.max(...rows.map((row) => String(row.qualifiedName ?? row.name ?? '').length), 8)
  for (const row of rows) {
    const name = String(row.qualifiedName ?? row.name ?? '(anonymous)')
    const kind = String(row.kind ?? '').padEnd(kindWidth)
    const where = row.filePath === null ? '(unknown)' : `${row.filePath}:${row.startLine ?? '?'}`
    lines.push(`${kind}  ${name.padEnd(nameWidth)}  ${where}`)
  }
  if (value.truncated === true) {
    lines.push('', `Upstream capped this list; narrow the symbol or raise the limit to see the rest.`)
  }
  return lines.join('\n')
}

/**
 * Render a failure the model can act on.
 *
 * The outcome is the first thing it reads, because that is the part it can
 * dispatch on.
 *
 * @param {Record<string, any>} value - a failure value.
 * @returns {string} the rendered text.
 */
export function renderFailure (value) {
  const lines = [`**${value.outcome}**`, value.message]
  if (value.guidance) lines.push('', value.guidance)
  return lines.filter((line) => line !== '').join('\n\n')
}

/**
 * Render a plain string list the way a model reads one: a bulleted run, with a
 * count and a coverage note where one applies.
 *
 * @param {Record<string, any>} value - a successful list result.
 * @returns {string} the rendered text.
 */
function renderList (value) {
  const rows = Array.isArray(value.affectedTests)
    ? value.affectedTests
    : Array.isArray(value.files)
      ? value.files
      : null
  if (rows === null) return renderValue(value)
  if (rows.length === 0) {
    const note = value.coverage ?? 'Nothing matched.'
    return `**0 result(s).** ${note}`
  }
  const entries = rows.map((row) => (typeof row === 'string' ? row : row?.filePath ?? row?.path ?? JSON.stringify(row)))
  const header = `**${rows.length} of ${value.total ?? rows.length}:**`
  const footer = value.coverage ? `\n\n${value.coverage}` : ''
  return [header, ...entries.map((entry) => `- \`${entry}\``), footer.trim()].filter((line) => line !== '').join('\n')
}

/**
 * Render any tool value: markdown when upstream produced it, a table for a
 * relationship, a list for a file or test listing, and a readable failure
 * otherwise.
 *
 * @param {any} value - the canonical value.
 * @returns {string} the rendered text.
 */
export function renderResult (value) {
  if (!value || value.ok !== true) return renderFailure(value ?? { outcome: 'unknown', message: 'no result' })
  if (typeof value.markdown === 'string') return value.markdown
  // An index status is recognised by its own fields, not by `command`: an index
  // result also carries `command` (the upstream command that built it), and
  // routing it through the relationship renderer produced
  // "No indexed relationship for undefined" where a status report belonged.
  if (value.fileCount !== undefined && value.nodeCount !== undefined) return renderStatus(value)
  if (typeof value.command === 'string') return renderRelation(value)
  if (Array.isArray(value.affectedTests) || Array.isArray(value.files)) return renderList(value)
  return renderValue(value)
}

/**
 * Render an index status report.
 *
 * The freshness line is the part a model acts on: it is what separates "the
 * graph is current" from "your last edit is not in the index yet".
 *
 * @param {Record<string, any>} value - a successful status value.
 * @returns {string} the rendered text.
 */
function renderStatus (value) {
  const lines = [`**Index for ${value.projectPath ?? 'this project'}**`, '']
  if (value.ancestorIndex === true) {
    // A foreign index is reported, never adopted: the model has to know the
    // facts it is being shown describe a different project.
    lines.push(`This project has no index of its own. The graph found belongs to \`${value.projectPath}\`.`)
  } else {
    if (value.built === true) lines.push(`Built just now with \`codegraph ${value.builtWith ?? 'init'}\`.`)
    else if (value.synced === true) lines.push(`Synced with \`codegraph ${value.builtWith ?? 'sync'}\`.`)
  }
  lines.push(
    `${value.fileCount} file(s), ${value.nodeCount} node(s), ${value.edgeCount} edge(s) — ${value.dbSize}`,
    `last indexed: ${value.lastIndexed ?? 'unknown'}`,
  )
  if (Array.isArray(value.languages) && value.languages.length > 0) {
    lines.push(`languages: ${value.languages.join(', ')}`)
  }
  if (value.reindexRecommended === true) {
    lines.push('', 'The index reports that a rebuild is recommended — upstream changed its extraction format or the index is inconsistent.')
  }
  if (value.hasPendingChanges === true) {
    lines.push('', `This index is out of date (${JSON.stringify(value.pendingChanges)}) — code edited since it was built is not in the graph yet.`)
  }
  return lines.filter((line) => line !== '').join('\n')
}

/**
 * Register every CodeGraph tool.
 *
 * @param {any} ctx - Cordis context providing the tool registry.
 * @param {any} runtime - the CodeGraph runtime.
 * @returns {string[]} the registered tool names, in registration order.
 */
export function registerTools (ctx, runtime) {
  if (!runtime) throw new Error(`dsh-codegraph-tools: the ${SERVICE} service is not mounted`)
  const names = []
  const config = runtime.config

  /**
   * Register one tool definition and record its name.
   *
   * @param {any} definition - the tool definition.
   * @returns {void} nothing.
   */
  const add = (definition) => {
    ctx.tools.register(definition)
    names.push(definition.name)
  }

  // Budgets scale from the configured default so lowering `defaultMaxChars`
  // reaches every tool.
  const budget = (fraction, floor) => Math.max(floor, Math.round(config.defaultMaxChars * fraction))

  /**
   * The budget one call was actually rendered to, read from its own arguments so
   * a caller who asked for less gets a bound near what they asked for.
   *
   * @param {any} exec - the tool execution.
   * @returns {number} the budget across the content blocks.
   */
  const askedBudget = (exec) => {
    const asked = Number(exec?.arguments?.maxChars)
    return Number.isFinite(asked) && asked >= 1000 ? Math.round(asked) : config.defaultMaxChars
  }

  const rootArg = {
    type: 'string',
    description: 'Absolute project directory. Defaults to the session working directory. A project with no index reports one rather than answering from an unrelated parent.',
  }

  add({
    name: 'codegraph_explore',
    timeoutMs: config.queryTimeoutMs + 5000,
    description:
      'Answer a question about this codebase in one call. Returns the relevant symbols\' verbatim source grouped by file, the call paths between them, and a blast-radius summary. Name a file or symbol in the query to read its current line-numbered source. This is the primary tool for "how does X work" and "how does X reach Y" questions, and it answers without a file-by-file crawl.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'A question or area: "how does the tool registry dispatch a call", "registerTools", "packages/fs/src/read.ts".',
        },
        path: rootArg,
        maxFiles: { type: 'number', description: 'How many files to include source from. Raise it for a wide question.' },
        maxChars: { type: 'number', description: 'Character budget for the returned text.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
    },
    finalizeContent: boundedContent(askedBudget),
    isConcurrencySafe: () => true,
    async execute (args, exec) {
      const root = runtime.resolveRoot(exec, args.path)
      const ready = await runtime.ensureIndexed({ root, signal: exec?.signal })
      if (!ready.ok) return ready
      return await runtime.explore({
        root,
        query: args.query,
        maxFiles: clampInt(args.maxFiles, undefined, 1, 50),
        signal: exec?.signal,
      })
    },
  })

  add({
    name: 'codegraph_search',
    timeoutMs: config.queryTimeoutMs + 5000,
    description:
      'Find symbols in this codebase by name, ranked by relevance. Use it to find the exact name of a function, class, method or type before reading its source or tracing its callers. Do not use it to read a body — that is codegraph_node.',
    parameters: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Symbol name or fragment, e.g. "registerTools". A shorter term matches more.' },
        kind: { type: 'string', description: 'Filter by node kind, such as function, class, method, interface, type_alias.' },
        limit: { type: 'number', description: 'How many matches to return.' },
        path: rootArg,
        maxChars: { type: 'number', description: 'Character budget for the returned matches.' },
      },
      required: ['search'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
    },
    finalizeContent: boundedContent(budget(0.5, 4000)),
    isConcurrencySafe: () => true,
    async execute (args, exec) {
      const root = runtime.resolveRoot(exec, args.path)
      const ready = await runtime.ensureIndexed({ root, signal: exec?.signal })
      if (!ready.ok) return ready
      return await runtime.query({
        root,
        search: args.search,
        limit: clampInt(args.limit, config.defaultMaxResults, 1, 200),
        kind: args.kind,
        signal: exec?.signal,
      })
    },
  })

  add({
    name: 'codegraph_node',
    timeoutMs: config.queryTimeoutMs + 5000,
    description:
      'Read one symbol\'s current source with line numbers, together with its caller and callee trail. Name a file instead of a symbol to read that file with line numbers. Use it after codegraph_search found the exact name. Do not use it to survey an area — that is codegraph_explore.',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'The symbol or file path to read, exactly as codegraph_search reported it.' },
        offset: { type: 'number', description: 'File mode: 1-based start line to read from.' },
        limit: { type: 'number', description: 'File mode: maximum lines to return.' },
        path: rootArg,
        maxChars: { type: 'number', description: 'Character budget for the returned source.' },
      },
      required: ['symbol'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
    },
    finalizeContent: boundedContent(askedBudget),
    isConcurrencySafe: () => true,
    async execute (args, exec) {
      const root = runtime.resolveRoot(exec, args.path)
      const ready = await runtime.ensureIndexed({ root, signal: exec?.signal })
      if (!ready.ok) return ready
      return await runtime.node({
        root,
        symbol: args.symbol,
        offset: clampInt(args.offset, undefined, 1, 100000),
        limit: clampInt(args.limit, undefined, 1, 5000),
        signal: exec?.signal,
      })
    },
  })

  add({
    name: 'codegraph_callers',
    timeoutMs: config.queryTimeoutMs + 5000,
    description:
      'List what calls a symbol, so you know who depends on it before changing it. This follows dynamic-dispatch hops — callbacks, interface to implementation — that grep cannot. Do not use it to read a body; that is codegraph_node.',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'The symbol name to trace callers for.' },
        limit: { type: 'number', description: 'How many callers to return.' },
        path: rootArg,
        maxChars: { type: 'number', description: 'Character budget for the returned list.' },
      },
      required: ['symbol'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
    },
    finalizeContent: boundedContent(budget(0.35, 3000)),
    isConcurrencySafe: () => true,
    async execute (args, exec) {
      const root = runtime.resolveRoot(exec, args.path)
      const ready = await runtime.ensureIndexed({ root, signal: exec?.signal })
      if (!ready.ok) return ready
      return await runtime.relation('callers', {
        root,
        symbol: args.symbol,
        limit: clampInt(args.limit, config.defaultMaxResults, 1, 200),
        signal: exec?.signal,
      })
    },
  })

  add({
    name: 'codegraph_callees',
    timeoutMs: config.queryTimeoutMs + 5000,
    description:
      'List what a symbol calls, which is how you follow one call path outward step by step. Do not use it to read a body; that is codegraph_node.',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'The symbol name to trace callees for.' },
        limit: { type: 'number', description: 'How many callees to return.' },
        path: rootArg,
        maxChars: { type: 'number', description: 'Character budget for the returned list.' },
      },
      required: ['symbol'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
    },
    finalizeContent: boundedContent(budget(0.35, 3000)),
    isConcurrencySafe: () => true,
    async execute (args, exec) {
      const root = runtime.resolveRoot(exec, args.path)
      const ready = await runtime.ensureIndexed({ root, signal: exec?.signal })
      if (!ready.ok) return ready
      return await runtime.relation('callees', {
        root,
        symbol: args.symbol,
        limit: clampInt(args.limit, config.defaultMaxResults, 1, 200),
        signal: exec?.signal,
      })
    },
  })

  add({
    name: 'codegraph_impact',
    timeoutMs: config.queryTimeoutMs + 5000,
    description:
      'Measure the blast radius of changing a symbol: every symbol that depends on it, transitively, up to a depth. Call this BEFORE an edit that changes behaviour, so you know what to verify and which tests cover it.',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'The symbol whose impact radius you want.' },
        depth: { type: 'number', description: 'How many dependency hops to walk. Deeper is slower and broader.' },
        path: rootArg,
        maxChars: { type: 'number', description: 'Character budget for the returned list.' },
      },
      required: ['symbol'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
    },
    finalizeContent: boundedContent(budget(0.6, 4000)),
    isConcurrencySafe: () => true,
    async execute (args, exec) {
      const root = runtime.resolveRoot(exec, args.path)
      const ready = await runtime.ensureIndexed({ root, signal: exec?.signal })
      if (!ready.ok) return ready
      return await runtime.relation('impact', {
        root,
        symbol: args.symbol,
        depth: clampInt(args.depth, config.defaultDepth, 1, 10),
        signal: exec?.signal,
      })
    },
  })

  add({
    name: 'codegraph_status',
    timeoutMs: config.versionTimeoutMs + 5000,
    description:
      'Report whether this project has a code graph, how large it is, which languages it covers, and when it was last indexed. Call it when a graph tool says not-initialized, when you need to know what the index actually contains, or before building one. Never reads code.',
    parameters: {
      type: 'object',
      properties: {
        path: rootArg,
        init: {
          type: 'boolean',
          description: 'Build the index when the project has none, instead of only reporting. A first index of a large repository takes minutes.',
        },
        maxChars: { type: 'number', description: 'Character budget for the returned report.' },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
    },
    finalizeContent: boundedContent(budget(0.25, 1500)),
    // Building an index writes to the project's `.codegraph/` directory and
    // takes a writer lock, so a status call that only reads is safe beside itself
    // and one that may build is not.
    isConcurrencySafe: (exec) => exec?.arguments?.init !== true,
    async execute (args, exec) {
      const root = runtime.resolveRoot(exec, args.path)
      if (args.init === true) return await runtime.init({ root, force: false, signal: exec?.signal })
      return await runtime.status(root, exec?.signal)
    },
  })

  add({
    name: 'codegraph_affected',
    timeoutMs: config.queryTimeoutMs + 5000,
    description:
      'Given files you just changed, return the test files that depend on them. Use it after an edit to decide which tests to run instead of running the whole suite. An empty list is a real answer: it means the graph found no test covering those files, so do not assume the change is covered.',
    parameters: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'The changed files, repo-relative, exactly as git writes them: ["src/tools.js", "src/runtime.js"].',
        },
        filter: { type: 'string', description: 'Custom glob identifying test files, e.g. "e2e/*". Omit to use the detected patterns.' },
        depth: { type: 'number', description: 'How deep to traverse import dependencies. Deeper finds tests further away, and costs more.' },
        path: rootArg,
        maxChars: { type: 'number', description: 'Character budget for the returned list.' },
      },
      required: ['files'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
    },
    finalizeContent: boundedContent(budget(0.5, 3000)),
    isConcurrencySafe: () => true,
    async execute (args, exec) {
      const root = runtime.resolveRoot(exec, args.path)
      const ready = await runtime.ensureIndexed({ root, signal: exec?.signal })
      if (!ready.ok) return ready
      return await runtime.affected({
        root,
        files: Array.isArray(args.files) ? args.files : [],
        filter: args.filter,
        depth: clampInt(args.depth, undefined, 1, 10),
        signal: exec?.signal,
      })
    },
  })

  add({
    name: 'codegraph_files',
    timeoutMs: config.queryTimeoutMs + 5000,
    description:
      'List the files this project\'s index actually contains, optionally under one directory. Use it when a graph tool returns nothing and you need to know what is indexed — dependency and build directories are skipped, so this is the honest list of what the graph knows. It never reads file contents.',
    parameters: {
      type: 'object',
      properties: {
        path: rootArg,
        dir: { type: 'string', description: 'List only files under this directory, e.g. "src/runtime".' },
        maxDepth: { type: 'number', description: 'How deep to descend when rendering the tree.' },
        maxChars: { type: 'number', description: 'Character budget for the returned listing.' },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
    },
    finalizeContent: boundedContent(budget(0.5, 3000)),
    isConcurrencySafe: () => true,
    async execute (args, exec) {
      const root = runtime.resolveRoot(exec, args.path)
      const ready = await runtime.ensureIndexed({ root, signal: exec?.signal })
      if (!ready.ok) return ready
      return await runtime.files({
        root,
        path: args.dir,
        maxDepth: clampInt(args.maxDepth, undefined, 1, 20),
        signal: exec?.signal,
      })
    },
  })

  return names
}
