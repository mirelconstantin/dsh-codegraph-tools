/**
 * Shared helpers: the strict configuration validator, text bounding, and small
 * formatting routines the tool layer depends on.
 *
 * Copied in shape from the harness's own conventions rather than imported from
 * `dsh-context`: an installed plugin must not reach into a sibling plugin's
 * internals, and these are small enough that sharing them would only couple two
 * bundles that are meant to be removable one at a time.
 *
 * @module dsh-codegraph-tools/util
 */

/**
 * Whether a value is a plain object.
 *
 * @param {unknown} value - the value to test.
 * @returns {boolean} whether it is a non-null non-array object.
 */
export function isRecord (value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Clamp a value to an integer range, falling back when it is not a number.
 *
 * @param {unknown} value - the candidate.
 * @param {number} fallback - used when `value` is not finite.
 * @param {number} [min] - lower bound.
 * @param {number} [max] - upper bound.
 * @returns {number} the clamped integer.
 */
export function clampInt (value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  const lower = min ?? Number.NEGATIVE_INFINITY
  const upper = max ?? Number.POSITIVE_INFINITY
  return Math.min(upper, Math.max(lower, Math.round(parsed)))
}

/**
 * Cut text to a character budget and say so, keeping the notice inside it.
 *
 * @param {string} text - the text to bound.
 * @param {number} maxChars - budget in characters, including the notice.
 * @param {string} [label] - label used in the truncation notice.
 * @returns {string} the possibly truncated text.
 */
export function truncate (text, maxChars, label = 'content') {
  const value = typeof text === 'string' ? text : String(text ?? '')
  if (!Number.isFinite(maxChars) || maxChars <= 0 || value.length <= maxChars) return value
  const notice = `\n\n[truncated ${label}: showing ${maxChars} of ${value.length} characters — narrow the request]`
  // A budget too small to carry the notice gets a bare slice, so the ceiling
  // holds for every budget rather than only for large ones.
  if (notice.length >= maxChars) return value.slice(0, maxChars)
  return value.slice(0, maxChars - notice.length) + notice
}

/**
 * Build a Standard Schema object without importing a validation library.
 *
 * The harness resolves plugin configuration through the Standard Schema
 * `~standard` interface; this is the whole contract it needs.
 *
 * @param {(value: unknown) => { value: any } | { issues: Array<{ message: string, path?: string[] }> }} validate - validator returning either a value or issues.
 * @returns {{ '~standard': { version: number, vendor: string, validate: Function } }} a schema.
 */
export function standardSchema (validate) {
  return { '~standard': { version: 1, vendor: 'dsh-codegraph-tools', validate } }
}

/**
 * Validate a plain object config against a shape description.
 *
 * Unknown keys are rejected: a typo in `cordis.patch.yml` fails the plugin load
 * rather than silently disabling a feature the user believes is on.
 *
 * @param {Record<string, any>} defaults - default value per known key.
 * @param {Record<string, string>} types - expected type per key.
 * @returns {(value: unknown) => any} a Standard Schema validate function.
 */
export function configValidator (defaults, types) {
  return (input) => {
    if (input == null) return { value: { ...defaults } }
    if (!isRecord(input)) return { issues: [{ message: 'config must be an object' }] }
    const issues = []
    const value = { ...defaults }
    for (const [key, raw] of Object.entries(input)) {
      if (!(key in defaults)) {
        issues.push({ message: `unknown config key "${key}"`, path: [key] })
        continue
      }
      if (raw === undefined) continue
      const expected = types[key]
      const actual = Array.isArray(raw) ? 'string[]' : typeof raw
      if (expected === 'number') {
        const parsed = typeof raw === 'number' ? raw : Number(raw)
        if (!Number.isFinite(parsed)) {
          issues.push({ message: `"${key}" must be a finite number`, path: [key] })
        } else {
          value[key] = parsed
        }
        continue
      }
      if (expected === 'string[]') {
        if (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string')) {
          issues.push({ message: `"${key}" must be an array of strings`, path: [key] })
          continue
        }
      } else if (actual !== expected) {
        issues.push({ message: `"${key}" must be a ${expected}, received ${actual}`, path: [key] })
        continue
      }
      value[key] = raw
    }
    return issues.length > 0 ? { issues } : { value }
  }
}

/**
 * Describe a thrown value compactly for a log line or a tool result.
 *
 * @param {unknown} error - the thrown value.
 * @returns {string} a short JSON-safe description.
 */
export function describeError (error) {
  if (error == null) return 'unknown error'
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message || error.name
  try {
    return JSON.stringify(error).slice(0, 500)
  } catch {
    return String(error)
  }
}

/**
 * Render a byte count for a human-readable listing.
 *
 * @param {number} bytes - the byte count.
 * @returns {string} a short size label.
 */
export function formatBytes (bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value < 0) return 'unknown size'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Return a non-empty trimmed string, or `null` for anything else.
 *
 * @param {unknown} value - the candidate.
 * @returns {string|null} the trimmed string or null.
 */
export function trimmed (value) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text === '' ? null : text
}
