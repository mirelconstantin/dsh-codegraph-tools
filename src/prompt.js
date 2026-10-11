/**
 * System-prompt guidance for the CodeGraph tools.
 *
 * Tool schemas alone do not teach intent: a model sees seven names and has to
 * guess when the graph beats grep, how to phrase a question, and when a
 * `not-initialized` answer means "build it" rather than "give up". The text is
 * deliberately stable and short, because it is repeated on every request and any
 * change costs a prompt rebuild for the whole session.
 *
 * @module dsh-codegraph-tools/prompt
 */

/**
 * The tools this guidance is written about, in registration order.
 *
 * Declared here rather than imported from `./tools.js` so this module keeps no
 * dependency on the tool registry: the section provider needs the names in a
 * scope where the tools themselves may have been filtered away.
 *
 * @type {readonly string[]}
 */
export const CODEGRAPH_TOOL_NAMES = Object.freeze([
  'codegraph_explore',
  'codegraph_search',
  'codegraph_node',
  'codegraph_callers',
  'codegraph_callees',
  'codegraph_impact',
  'codegraph_status',
  'codegraph_affected',
  'codegraph_files',
])

/**
 * Whether any CodeGraph tool is visible in the scope being assembled.
 *
 * A static section is injected into EVERY assembly, including scopes where a
 * preset's `tools.restrict({ allow: [...] })`, a `subagent` call's `toolFilter`,
 * or a disabled `codegraph-tools` row has taken the tools away. The model would
 * then be told to use tools it cannot see and cannot call — and because a
 * filtered-away tool is indistinguishable from one that never existed, nothing in
 * that failure corrects the impression.
 *
 * `ctx.get('tools')?.get(name, scope)` is the documented visibility resolver for
 * exactly this question, and `AssembleContext` carries the `scope` its section
 * providers are evaluated with.
 *
 * The registry is read through `ctx.get('tools')`, never the `ctx.tools`
 * property. This closure runs when the harness assembles a prompt, which is on a
 * different fiber than this plugin's, so a direct property read runs the context
 * proxy's ancestor-only fiber walk and can throw `cannot get property "tools"
 * without inject` through a traceable shadow — the exact failure recorded in
 * `docs/postmortem/0001-acp-default-export-drops-inject.md`. `ctx.get` is the
 * topology-independent lookup and returns `undefined` instead of throwing when
 * `tools` is absent or mid-teardown, which is the correct answer for a visibility
 * check.
 *
 * One surviving tool is enough: the guidance is worth having whenever the model
 * has any way in, and demanding all nine would let an incidental narrow filter
 * read as a total loss.
 *
 * @param {any} ctx - Cordis context; `tools` is looked up with `ctx.get`.
 * @param {any} [scope] - the scope key this assembly is resolving.
 * @returns {boolean} true when at least one CodeGraph tool is visible.
 */
export function codeGraphToolsVisible (ctx, scope) {
  let tools
  try {
    tools = typeof ctx?.get === 'function' ? ctx.get('tools') : undefined
  } catch {
    return false
  }
  if (!tools || typeof tools.get !== 'function') return false
  try {
    return CODEGRAPH_TOOL_NAMES.some((name) => tools.get(name, scope) !== undefined)
  } catch {
    // A registry that cannot answer is no reason to inject guidance about tools
    // that may not be there; the section simply stays out of this assembly.
    return false
  }
}

/**
 * Build the system-prompt section that teaches a model to use the code graph.
 *
 * @returns {string} the section text.
 */
export function codeGraphGuidance () {
  return `**This codebase has a pre-built code graph on this machine.** It knows every symbol, call edge and dependency across the indexed files, so a question about how something works is one call instead of a crawl through grep, glob and file reads.

**Reach for \`codegraph_explore\` first when the question is about how this code works.** Ask it the question directly — "how does the tool registry dispatch a call", "how does session persistence survive a restart" — and it returns the relevant symbols' verbatim source grouped by file, the call paths between them, and a blast-radius summary. Name a file or symbol in the query to get its current line-numbered source, which is the same shape a file read gives you.

**The rest of the surface, each one job:**
- \`codegraph_search\` finds a symbol by name and reports kind, file and line. Start here when you know roughly what something is called but not exactly.
- \`codegraph_node\` reads one symbol's source plus its callers. Name a file instead of a symbol to read that file.
- \`codegraph_callers\` and \`codegraph_callees\` trace one relationship. They follow dynamic-dispatch hops — callbacks, interface to implementation, framework event bindings — that grep cannot follow, which is the whole reason to prefer them over a text search.
- \`codegraph_impact\` is what you call **before** an edit that changes behaviour: it returns everything that depends on the symbol, transitively, so you know what to verify.
- \`codegraph_affected\` is what you call **after** an edit, with the files you changed: it returns the test files that depend on them, so you run four tests instead of the whole suite. An empty result is a real answer, not a failure — it means nothing in the graph covers those files, so verify by hand rather than assuming you are done.
- \`codegraph_files\` lists what the index actually contains. Dependency and build directories are skipped, so this is the honest list of what the graph knows about this project.
- \`codegraph_status\` says whether a project is indexed, how big the graph is, which languages it covers and when it was last built.

**Habits that matter:**
- Grep and glob still win for text that is not code — a config key, an error string, a file name pattern — and for anything outside the indexed tree. The graph skips \`node_modules\`, build output and anything \`.gitignore\` excludes.
- One strong call beats a chain of narrow ones. If a \`codegraph_explore\` result does not quite answer the question, ask it a second, more specific question rather than assembling the answer from six separate lookups.
- Do not delegate exploration to a subagent that reads files. A subagent that crawls pays the discovery cost anyway; the graph only helps whoever asks it directly.
- The graph describes **this project's indexed code**. For an external library's API, \`context_docs\` answers from that library's own version-exact documentation; for news or anything else, \`web_search\`.

**The failures you will see, and what they mean:**
- \`not-initialized\` — the project has no index yet. Call \`codegraph_status\` with \`init: true\` to build it; a first index of a large repository takes minutes, and every call after it is fast. Until then, fall back to reading files.
- \`writer-locked\` — another CodeGraph process owns this project's index. Run \`codegraph daemon\` and stop the background daemon; nothing is wrong with your query.
- \`no-results\` — no indexed symbol matched, or the index has no such symbol. Try a shorter or different term, drop the kind filter, or use \`codegraph_status\` to see what the index actually contains. If the index is old, an edit you just made is not in it yet: run \`codegraph_status\` with \`init: true\` to sync, then ask again.
- \`timed-out\` — the graph is too large to answer this in its budget. Narrow the question, or raise \`queryTimeoutMs\`.
- \`cli-missing\` — the CodeGraph CLI is not installed on this machine. Install it with \`npm i -g @colbymchenry/codegraph\`.

**Do not run \`codegraph\` from the shell for these questions.** The tools above are the same engine, already wired, and they share one index that stays fresh. A shell call bypasses the index the session is using.`
}
