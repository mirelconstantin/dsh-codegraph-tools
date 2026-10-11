<p align="center">
  <img src="https://raw.githubusercontent.com/pazalo/.github/main/assets/pazalo-logo.png" width="112" alt="Pazalo">
</p>

<h1 align="center">dsh-codegraph-tools</h1>

<p align="center">
  CodeGraph as nine native DeepSeek Harness tools. One call returns a codebase's symbols,
  call paths and blast radius, instead of a crawl through grep, glob and file reads.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Tools-9-FFC24D?style=flat-square" alt="Tools">
  <img src="https://img.shields.io/badge/Node-%3E%3D22.19-FFC24D?style=flat-square&logo=node&logoColor=black" alt="Node">
  <img src="https://img.shields.io/badge/Licence-MIT-F0522C?style=flat-square" alt="Licence">
  <img src="https://img.shields.io/badge/CodeGraph-MIT-F0522C?style=flat-square" alt="CodeGraph">
</p>

## Install

**1. Install the CodeGraph CLI.** It is a separate project, and this plugin drives it rather than
bundling it:

```bash
npm i -g @colbymchenry/codegraph
```

**2. Add the plugin.** From the GUI's **Add plugin** box:

```
dsh-codegraph-tools
```

or from a terminal, where the profile name is required:

```bash
dsh plugin add dsh-codegraph-tools --profile desktop
```

<details>
<summary>Other routes</summary>

| Route | Command |
|---|---|
| Pinned to a version | `dsh plugin add dsh-codegraph-tools@1.0.0 --profile desktop` |
| Pinned to a commit | `dsh plugin add github:mirelconstantin/dsh-codegraph-tools#<sha>` |
| Tarball | `dsh plugin add ./dsh-codegraph-tools-1.0.0.tgz` |
| Local checkout | `dsh plugin add /absolute/path/to/dsh-codegraph-tools` |

</details>

That is all. On first use the tools build the project's index themselves — the first build of a
large repository takes minutes, and every call after it is fast. To start without that cost, set
`autoInit: false`; the tools then report `not-initialized` and name the command that builds it.

## The tools

| Tool | Use it for |
|---|---|
| `codegraph_explore` | Answer a question about this codebase in one call: the relevant symbols' source, the call paths between them, and a blast-radius summary. **Start here** for "how does X work" |
| `codegraph_search` | Find a symbol by name and get its kind, file and line. Use it to find the exact name before reading source |
| `codegraph_node` | Read one symbol's source with line numbers, plus what calls it and what it calls. A file path reads that file instead |
| `codegraph_callers` | Who calls a symbol, before you change it |
| `codegraph_callees` | What a symbol calls, to follow one call path outward |
| `codegraph_impact` | Everything that depends on a symbol, transitively. Call it **before** an edit |
| `codegraph_affected` | Which test files depend on the files you just changed. **After** an edit, so you run four tests instead of the whole suite |
| `codegraph_files` | What this project's index actually contains |
| `codegraph_status` | Whether the project is indexed, how big it is, and when. Build it with `init: true` |

Every tool takes an optional `path`. It defaults to the session's working directory, then to
`defaultRoot`.

## Why it is shaped this way

**A managed child process, not an MCP server.** The `codegraph serve --mcp` server holds a
per-project writer lock, so a second client either proxies through the shared daemon or refuses to
start — a harness that reloads plugins would fight that lock for the life of every session. The
CLI is run as one managed child per command instead, over the harness's own `subprocess` seam:
argv plus JSON, nothing else. The library was rejected too, because its `node:sqlite` path
requires Node >= 22.5 *in the host*.

**A refused query is never answered from another project.** `status` walks **up** the directory
tree to find an index, so a project with none of its own resolves an ancestor's graph and reports
it as its own — a wrong answer that looks right. The index directory is checked against the one
the project owns, and a foreign one is reported instead of adopted.

**A stale index is refreshed with the command that refreshes it.** `init` builds a missing index
and does nothing else. `sync` applies the changes an index has not seen yet. Using the wrong one
is a silent no-op, so the command is chosen from what the project already has.

**Failure is a value, not an exception.** A thrown error reaches a model as a string it cannot
branch on. Every failure here carries a frozen `outcome` — `not-initialized`, `writer-locked`,
`cli-missing`, `timed-out`, `no-results`, `bad-request`, `unknown` — with the action that resolves
it, and the system-prompt section teaches the model what each means.

**Eight upstream behaviours, all measured on CodeGraph 1.6.2:**

| Behaviour | What happens if it is ignored |
|---|---|
| `status --json` on an uninitialized project exits **0** | Every uninitialized project looks like a success |
| `status` walks up the tree for an index | A query answers from an ancestor's graph |
| `init` on an indexed project says "Already initialized" and exits 0 | A stale index is never refreshed |
| `sync` on a project with no index does nothing | `init: true` loops forever on `not-initialized` |
| A zero match is answered in prose on exit code 0 | An empty answer is read as a broken CLI |
| `callers`/`callees` put the queried symbol under `targets` | The tool returns the symbol you asked about |
| A Windows npm shim is a `.cmd`, which `spawn` refuses | Every call fails with `ENOENT` while it "works in my terminal" |
| Windows resolves a child's cwd before its executable | An `app.asar` path fails as `spawn <valid exe> ENOENT` |

## Configuration

Every default lives in `src/config.js`. `cordis.patch.yml` declares only what an installation
overrides, and a key a running host has not heard of is a **load failure**, not a forward
compatible change — so add a line there only together with its `CONFIG_DEFAULTS` entry.

| Key | Default | Meaning |
|---|---|---|
| `cliPath` | `''` | Absolute path to the executable. Empty uses the one on `PATH` |
| `defaultRoot` | `''` | Project used when neither the call nor the session names one |
| `autoInit` | `true` | Build or refresh an index instead of only reading one |
| `staleAfterHours` | `24` | Re-sync an index older than this before the first query |
| `queryTimeoutMs` | `90000` | Budget for one query |
| `initTimeoutMs` | `600000` | Budget for one index build |
| `versionTimeoutMs` | `90000` | Budget for the probe and for `status`, slow on a large index |
| `shutdownTimeoutMs` | `2000` | Grace before an in-flight child is killed |
| `defaultMaxChars` | `20000` | Result budget unless the call asks for its own |
| `defaultMaxResults` | `20` | Search size unless the call asks for its own |
| `defaultDepth` | `2` | Hops `codegraph_impact` walks by default |
| `statusTtlMs` | `1800000` | How long one successful `status` answer is reused |

The timeouts are measured, not guessed. On a 509-file root that is not a git repository,
`status --json` costs ~14.8s cold and ~1.1s warm, while `query --json` costs ~0.6s. `status` is
the command every other tool waits on first, which is why its budget is the generous one.

## Enabling it in a profile

`dsh plugin add` edits both `dependencies` and `dsh.profile.bundles` for you. To link a local
checkout by hand:

```jsonc
// profiles/<name>/package.json
"dependencies": { "dsh-codegraph-tools": "link:/absolute/path/to/dsh-codegraph-tools" },
"dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-codegraph-tools"] } }
```

Then **restart DSH once**. A running host holds the profile manifest it read at launch, so
editing `package.json` while DSH runs does not make the bundle resolvable.

On Windows the profile's `node_modules/dsh-codegraph-tools` must be a **junction** to the plugin
directory, or edits will not reach the profile. Git Bash's `ln -s` creates a copy; use
PowerShell's `New-Item -ItemType Junction`.

The system-prompt section is a provider, not a static string. It is evaluated per assembly and
contributes nothing where a preset or a subagent's `toolFilter` has removed the tools, so a model
is never told to reach for tools it cannot see.

## Files

```
package.json             the package and its dsh bundle declaration
cordis.patch.yml         the three loader rows and their configuration
src/index.js             the service entry (provides `codeGraph`)
src/config.js            every default, its type, and the resolution step
src/engine.js            the CLI seam: one managed child per command
src/runtime.js           which project, whether it has an index, and the answers
src/tools.js             the tool definitions and their renderers
src/prompt.js            the system-prompt section text and its visibility gate
src/util.js              the config validator, text bounding, small formatters
src/entry-tools.js       the tools row
src/entry-prompt.js      the prompt row
scripts/check-plugin.mjs  the plugin contract, against a fake context
scripts/check-patch.mjs   the bundle: every row, export, files entry and the icon
scripts/live.mjs         the same engine against the real CLI
```

## Verifying it

```sh
npm test                        # both gates: the plugin contract, then the bundle
node scripts/check-plugin.mjs   # the plugin contract, against a fake context
node scripts/check-patch.mjs    # every patch row, export, files entry and the icon
node scripts/live.mjs <project> # the real CLI, through the shipped engine
```

`check-plugin.mjs` asserts what a harness does at load time that a hand-mounted test cannot: that
there is **no default export** (the loader unwraps `.default` and silently drops `inject`, `name`
and `Config`, leaving every dependent row PENDING forever), that registrations are effects, that
the prompt section reads the registry through `ctx.get` and never the `ctx.tools` property, that
a spill locator is never cut, and that an ancestor index is refused.

It also pins the six regressions that were live at some point: a relationship tool reading
`targets` returned the queried symbol as its own result; `explore` reported every answered query
as unindexed because its own source quoted the unindexed wording; a stale refresh ran `init` and
did nothing; a missing index ran `sync` and never got built; `files` sent a directory to
`--pattern` and returned nothing; and a timeout was classified as `cli-missing`, whose guidance
tells a model to reinstall a working CLI.

`live.mjs` drives the real CLI end to end and fails if an index built seconds ago cannot answer a
symbol in its own project.

CI runs both gates on **Linux and Windows** on every push and pull request.

## Notes

- **The index is a cache, and a stale one lies.** Two guards cover that: `staleAfterHours`
  re-syncs an index older than the window, and `pendingChanges` catches one that is newer than
  the window but already out of date.
- **Only one writer per project.** A `codegraph daemon` holds the lock. The tools report
  `writer-locked` and point at `codegraph daemon` or `codegraph unlock` rather than retrying.
- **Telemetry is upstream's, and off is a user decision.** Nothing is sent from here, and
  upstream's setting is not read.
- **Keep the graph root a source tree.** The index cost is paid twice, at build time and again
  whenever a command re-walks to report pending changes. Exclude data directories with a
  `codegraph.json` `exclude` list, and let each project keep its own index.

## License

This bundle is MIT — see [LICENSE](LICENSE). CodeGraph is MIT, © Colby Chenry, and is driven as
an installed CLI rather than vendored or redistributed here; [NOTICE](NOTICE) carries that
attribution.
