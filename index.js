/**
 * Host half of the `usage-overlay` bundle.
 *
 * One session projection unit folds the durable log into per-model provider
 * usage, generation latency and time-to-first-token, and publishes the totals
 * to the Client through `wire.view`. The Client half owns every pixel.
 *
 * The replacement rule mirrors `@deepseek-ai/dsh-token-meter`: an
 * `assistant/attempt` and the `assistant/message` that settles it describe the
 * same (turn, step), so the later sample REPLACES the earlier contribution
 * instead of adding to it, and `llm/retry-started` closes the slot so a retried
 * attempt is metered on its own.
 *
 * Two figures are computed in the view rather than folded into state, because
 * neither is a fact about the log:
 * - the *estimated cost*, which is a user-supplied rate applied to metered
 *   tokens, and is therefore only ever an estimate;
 * - the per-model *series*, which is a regrouping of the single settlement
 *   series by model rather than a second accumulation.
 *
 * The schemas are written by hand on purpose. The projection drive only ever
 * calls `parse(value)` on `stateSchema` and `viewSchema` (the registry types
 * them as `{ parse(value: unknown): unknown }`), so a validator that throws on
 * malformed input is a complete implementation and the bundle needs no schema
 * library. Each `parse` also normalizes: it returns a fresh plain-JSON value,
 * never the caller's object.
 */

/** Required Host service: the projection registry that owns this unit. */
export const inject = ['sessionProjections']

/** The Client-visible wire key the Client half reads. */
const KEY = 'modelUsageByRoute'

/** Bump when the state fields or their fold semantics change. */
const STATE_VERSION = 3

/** Max chart points retained per session; oldest are dropped first. */
const SERIES_LIMIT = 240

/** Route used before any `request/header` names one. */
const UNKNOWN = 'unknown'

/** The four disjoint provider usage buckets, in a stable display order. */
const BUCKETS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']

/**
 * Divisor that turns a per-million-token USD rate into a per-token multiplier.
 * The rate unit is part of the wire contract, not a display choice.
 */
const PER_TOKENS = 1000000

/**
 * Built-in list-price estimates in USD per million tokens, taken from the
 * model catalog the harness vendors (`@earendil-works/pi-ai`'s provider data
 * in its installed version) rather than from memory, and limited to models
 * that list on their own first-party API. These are published list prices that
 * change: treat every figure this bundle reports as an estimate, and override
 * it through this plugin's `prices` config whenever accuracy matters.
 */
const DEFAULT_PRICES = Object.freeze({
  // DeepSeek first-party (api.deepseek.com).
  'deepseek-flash': { provider: 'deepseek', input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
  'deepseek-v4-pro': { provider: 'deepseek', input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 },
  'deepseek-v4-pro-0813': { provider: 'deepseek', input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 },
  // Moonshot / Kimi first-party.
  'kimi-k2.5': { provider: 'moonshot', input: 0.6, output: 3, cacheRead: 0.08, cacheWrite: 0 },
  'kimi-k2.6': { provider: 'moonshot', input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 },
  'kimi-k2.7-code': { provider: 'moonshot', input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0 },
  'kimi-k3': { provider: 'moonshot', input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
  'kimi-for-coding': { provider: 'kimi-coding', input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0 },
  // Anthropic first-party.
  'claude-sonnet-4-5': { provider: 'anthropic', input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-sonnet-4': { provider: 'anthropic', input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-opus-4-5': { provider: 'anthropic', input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-haiku-4-5': { provider: 'anthropic', input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  // OpenAI first-party.
  'gpt-5': { provider: 'openai', input: 1.07, output: 8.5, cacheRead: 0.107, cacheWrite: 0 },
  'gpt-5-mini': { provider: 'openai', input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0 },
  'gpt-5-nano': { provider: 'openai', input: 0.05, output: 0.4, cacheRead: 0.005, cacheWrite: 0 },
  o3: { provider: 'openai', input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 },
  'o4-mini': { provider: 'openai', input: 1.1, output: 4.4, cacheRead: 0.275, cacheWrite: 0 },
  // Google first-party.
  'gemini-2.5-pro': { provider: 'google', input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  'gemini-2.5-flash': { provider: 'google', input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0 },
  // Zhipu / Z.ai first-party.
  'glm-5.2': { provider: 'zai', input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
  'glm-5.3': { provider: 'zai', input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
  // MiniMax, Qwen and xAI first-party.
  'minimax-m2.7': { provider: 'minimax', input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
  'minimax-m3': { provider: 'minimax', input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
  'qwen3-max': { provider: 'alibaba', input: 1.2, output: 6, cacheRead: 0.24, cacheWrite: 0 },
  'qwen3.8-27b': { provider: 'alibaba', input: 0.5, output: 3, cacheRead: 0.1, cacheWrite: 0.625 },
  'grok-4': { provider: 'xai', input: 3, output: 15, cacheRead: 0.75, cacheWrite: 0 },
})

/**
 * Family fallbacks for ids a provider has versioned past the table above. They
 * run only when neither the exact id nor its normalized form resolves, so an
 * exact entry always wins, and a family match is reported as `family` rather
 * than `exact` so the Client can mark it as an estimate of an estimate.
 */
const PRICE_FAMILIES = Object.freeze([
  { provider: 'anthropic', match: /(^|[/._-])claude-opus([/._-]|$)/, input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  { provider: 'anthropic', match: /(^|[/._-])claude-sonnet([/._-]|$)/, input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  { provider: 'anthropic', match: /(^|[/._-])claude-haiku([/._-]|$)/, input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  { provider: 'deepseek', match: /(^|[/._-])deepseek-.*pro([/._-]|$)/, input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 },
  { provider: 'deepseek', match: /(^|[/._-])deepseek/, input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
  { provider: 'moonshot', match: /(^|[/._-])(kimi|moonshot)/, input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 },
  { provider: 'google', match: /(^|[/._-])gemini-.*pro([/._-]|$)/, input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  { provider: 'google', match: /(^|[/._-])gemini/, input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0 },
  { provider: 'openai', match: /(^|[/._-])gpt-5/, input: 1.07, output: 8.5, cacheRead: 0.107, cacheWrite: 0 },
  { provider: 'openai', match: /(^|[/._-])gpt-4o([/._-]|$)/, input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 0 },
  { provider: 'zai', match: /(^|[/._-])glm/, input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
  { provider: 'alibaba', match: /(^|[/._-])qwen/, input: 1.2, output: 6, cacheRead: 0.24, cacheWrite: 0 },
  { provider: 'xai', match: /(^|[/._-])grok/, input: 3, output: 15, cacheRead: 0.75, cacheWrite: 0 },
  { provider: 'minimax', match: /(^|[/._-])minimax/, input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
])

const ZERO = Object.freeze({ calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, genMs: 0, ttftMs: 0 })

/** @param {unknown} value - candidate. @returns {boolean} whether it is a non-negative safe integer. */
function isCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** @param {unknown} value - candidate. @returns {boolean} whether it is a non-negative finite number. */
function isDuration(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** @param {unknown} value - candidate. @returns {boolean} whether it is a non-negative finite rate. */
function isRate(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** @param {unknown} value - candidate. @returns {boolean} whether it is a plain object. */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** @param {string} what - the malformed field. @throws {Error} always. */
function invalid(what) {
  throw new Error(`usage-overlay: invalid ${what}`)
}

/** Coerce one provider-reported bucket to a count. */
function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}

/** One per-route contribution: the exact shape the wire carries. */
function isBucket(value) {
  if (!isRecord(value)) return false
  if (typeof value.provider !== 'string' || typeof value.model !== 'string') return false
  if (!isCount(value.calls)) return false
  if (!BUCKETS.every(bucket => isCount(value[bucket]))) return false
  return isDuration(value.genMs) && isDuration(value.ttftMs)
}

/** One price row, as the Client displays it (USD per million tokens). */
function isPrice(value) {
  return isRecord(value)
    && isRate(value.input) && isRate(value.output) && isRate(value.cacheRead) && isRate(value.cacheWrite)
}

/** One estimated cost: four components plus their exact sum, in USD. */
function isCost(value) {
  if (!isRecord(value)) return false
  if (!isRate(value.input) || !isRate(value.output) || !isRate(value.cacheRead) || !isRate(value.cacheWrite)) return false
  return isRate(value.total)
}

/** The full per-route wire row: a bucket plus its view-computed estimate. */
function isModelRow(value) {
  if (!isBucket(value)) return false
  if (value.key !== `${value.provider}\u0000${value.model}`) return false
  if (!isCost(value.cost)) return false
  if (value.priceSource !== 'exact' && value.priceSource !== 'family' && value.priceSource !== 'none') return false
  if (value.priceSource === 'none') return value.price === null
  return isPrice(value.price)
}

/** One chart point: a settled message's contribution at its settlement time. */
function isSeriesPoint(value) {
  if (!isRecord(value)) return false
  if (!isCount(value.turn) || !isCount(value.step) || !isCount(value.index)) return false
  if (!isDuration(value.t) || typeof value.key !== 'string') return false
  if (typeof value.provider !== 'string' || typeof value.model !== 'string') return false
  if (!isCount(value.inputTokens) || !isCount(value.outputTokens)) return false
  if (!isCount(value.cacheReadTokens) || !isCount(value.cacheWriteTokens)) return false
  return isDuration(value.latencyMs)
}

/** @returns {object} a zeroed bucket for one route. */
function emptyBucket(provider, model) {
  return { provider, model, calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, genMs: 0, ttftMs: 0 }
}

/** Add one contribution to its route's running total, in place. */
function addBucket(totals, provider, model, contribution) {
  const key = `${provider}\u0000${model}`
  const current = totals[key] ?? emptyBucket(provider, model)
  const next = { ...current }
  for (const field of ['calls', ...BUCKETS, 'genMs', 'ttftMs']) next[field] = current[field] + contribution[field]
  totals[key] = next
}

/** Remove one contribution from its route's running total, deleting an exhausted route. */
function subtractBucket(totals, key, contribution) {
  const current = totals[key]
  if (current === undefined) return
  const next = { ...current }
  for (const field of ['calls', ...BUCKETS, 'genMs', 'ttftMs']) next[field] = Math.max(0, current[field] - contribution[field])
  if (next.calls === 0) delete totals[key]
  else totals[key] = next
}

/**
 * Fresh tokens of one bucket — uncached input plus output. This is the display's
 * ordering and share basis on purpose: on a long session a cache-read total
 * dwarfs everything else and is not a comparable measure of work. Cache traffic
 * is reported as its own figure.
 */
function weightOf(bucket) {
  return bucket.inputTokens + bucket.outputTokens
}

/**
 * The durable provider usage one Assistant settlement reports, if any.
 * A settled `assistant/message` carries it directly; an attempt only inside its
 * stream, as the last `usage` chunk.
 */
function usageOf(event) {
  const data = event.data ?? {}
  if (event.type === 'assistant/message' && isRecord(data.usage)) return data.usage
  const stream = Array.isArray(data.stream) ? data.stream : []
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index]
    const chunk = isRecord(record) && record.type === 'chunk' ? record.chunk : undefined
    if (isRecord(chunk) && chunk.type === 'usage' && isRecord(chunk.usage)) return chunk.usage
  }
  return undefined
}

/**
 * The model the sample belongs to: the message's own recorded route when it has
 * one, otherwise the route the newest `request/header` named.
 */
function routeOf(event, route) {
  const message = event.data?.message
  const source = isRecord(message) ? message.source : undefined
  if (isRecord(source) && typeof source.provider === 'string' && typeof source.model === 'string') {
    return { provider: source.provider, model: source.model }
  }
  return route ?? { provider: UNKNOWN, model: UNKNOWN }
}

/**
 * The generation span of one stream record list: earliest recorded chunk time to
 * the latest end. Chunk groups carry `time0` plus inter-chunk deltas; scalar
 * chunks carry an absolute `time`. Falls back to the settlement time with a zero
 * span when the stream recorded no timing at all.
 */
function spanOf(stream, settledAt) {
  let first = Number.POSITIVE_INFINITY
  let last = Number.NEGATIVE_INFINITY
  for (const record of stream) {
    if (!isRecord(record)) continue
    if (record.type === 'chunk') {
      if (typeof record.time !== 'number' || !Number.isFinite(record.time)) continue
      if (record.time < first) first = record.time
      if (record.time > last) last = record.time
      continue
    }
    if (typeof record.time0 !== 'number' || !Number.isFinite(record.time0)) continue
    let end = record.time0
    if (Array.isArray(record.dt)) for (const delta of record.dt) if (typeof delta === 'number' && Number.isFinite(delta)) end += delta
    if (record.time0 < first) first = record.time0
    if (end > last) last = end
  }
  if (!Number.isFinite(first) || !Number.isFinite(last)) return { first: settledAt, genMs: 0 }
  return { first, genMs: Math.max(0, Math.round(last - first)) }
}

/**
 * The pure fold. Returns the SAME state reference for every event it ignores, so
 * an unchanged projection costs nothing downstream.
 */
function applyEvent(state, event) {
  if (event.type === 'request/header') {
    const config = event.data?.header?.config
    if (!isRecord(config) || typeof config.provider !== 'string' || typeof config.model !== 'string') return state
    const route = state.route
    if (route !== null && route.provider === config.provider && route.model === config.model) return state
    return { ...state, route: { provider: config.provider, model: config.model } }
  }

  if (event.type === 'step/start') {
    const { turn, step } = event.data ?? {}
    if (!isCount(turn) || !isCount(step)) return state
    return { ...state, step: { turn, step, time: event.time } }
  }

  if (event.type === 'llm/retry-started') {
    const last = state.last
    if (last === null) return state
    const { turn, step } = event.data ?? {}
    return last.turn === turn && last.step === step ? { ...state, last: null } : state
  }

  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return state
  const { turn, step } = event.data ?? {}
  if (!isCount(turn) || !isCount(step)) return state
  const usage = usageOf(event)
  if (usage === undefined) return state

  const stream = Array.isArray(event.data?.stream) ? event.data.stream : []
  const span = spanOf(stream, event.time)
  const stepStart = state.step !== null && state.step.turn === turn && state.step.step === step ? state.step.time : undefined
  const ttftMs = stepStart !== undefined && span.first >= stepStart ? Math.round(span.first - stepStart) : span.genMs
  const route = routeOf(event, state.route)
  const contribution = {
    provider: route.provider,
    model: route.model,
    calls: 1,
    inputTokens: count(usage.inputTokens),
    outputTokens: count(usage.outputTokens),
    cacheReadTokens: count(usage.cacheReadTokens),
    cacheWriteTokens: count(usage.cacheWriteTokens),
    genMs: span.genMs,
    ttftMs,
  }

  const totals = { ...state.totals }
  const last = state.last
  if (last !== null && last.turn === turn && last.step === step) subtractBucket(totals, last.key, last.contribution)
  const key = `${route.provider}\u0000${route.model}`
  addBucket(totals, route.provider, route.model, contribution)

  // The chart only records durable settlements: one point per settled message,
  // the final one of a retried step replacing the same (turn, step). `index` is
  // the settlement's position in the series, so the Client can space points
  // evenly instead of letting one long gap flatten the rest of the plot.
  if (event.type === 'assistant/message') {
    const point = {
      turn,
      step,
      index: state.settled,
      t: event.time,
      key,
      provider: route.provider,
      model: route.model,
      inputTokens: contribution.inputTokens,
      outputTokens: contribution.outputTokens,
      cacheReadTokens: contribution.cacheReadTokens,
      cacheWriteTokens: contribution.cacheWriteTokens,
      latencyMs: contribution.genMs,
    }
    const series = state.series
    const tail = series[series.length - 1]
    if (tail !== undefined && tail.turn === turn && tail.step === step) {
      // A retried step's settlement replaces the earlier point in place, so the
      // replacement keeps the original index and no gap opens in the series.
      return {
        ...state, totals,
        last: { turn, step, key, contribution },
        series: [...series.slice(0, -1), { ...point, index: tail.index }],
      }
    }
    return {
      ...state, totals,
      last: { turn, step, key, contribution },
      settled: state.settled + 1,
      series: series.length >= SERIES_LIMIT
        ? [...series.slice(series.length - SERIES_LIMIT + 1), point]
        : [...series, point],
    }
  }

  return { ...state, totals, last: { turn, step, key, contribution } }
}

/** Validate one whole unit state. @throws {Error} on a malformed state. */
function parseState(value) {
  if (!isRecord(value)) invalid('projection state')
  if (value.route !== null && !(isRecord(value.route) && typeof value.route.provider === 'string' && typeof value.route.model === 'string')) invalid('projection route')
  if (value.step !== null && !(isRecord(value.step) && isCount(value.step.turn) && isCount(value.step.step) && isDuration(value.step.time))) invalid('projection step')
  if (value.last !== null && !(isRecord(value.last) && isCount(value.last.turn) && isCount(value.last.step) && typeof value.last.key === 'string' && isBucket(value.last.contribution))) invalid('projection last')
  if (!isRecord(value.totals)) invalid('projection totals')
  for (const bucket of Object.values(value.totals)) if (!isBucket(bucket)) invalid('projection bucket')
  if (!Array.isArray(value.series)) invalid('projection series')
  for (const point of value.series) if (!isSeriesPoint(point)) invalid('projection series point')
  if (!isCount(value.settled)) invalid('projection settled')
  return value
}

/** Validate one wire value. @throws {Error} on a malformed value. */
function parseView(value) {
  if (!isRecord(value)) invalid('wire view')
  if (!isBucket(value.totals)) invalid('wire totals')
  if (!isCost(value.cost)) invalid('wire cost')
  if (!isCount(value.unpriced)) invalid('wire unpriced')
  if (!Array.isArray(value.models)) invalid('wire models')
  for (const row of value.models) if (!isModelRow(row)) invalid('wire model row')
  if (!Array.isArray(value.series)) invalid('wire series')
  for (const point of value.series) if (!isSeriesPoint(point)) invalid('wire series point')
  return value
}

// ---------------------------------------------------------------------------
// Cost estimation. Rates are USD per million tokens; the resolved table is
// module state seeded from the plugin config, and every view computed under one
// table is cached until that table is replaced.
// ---------------------------------------------------------------------------

/**
 * `@provider/model`, `provider:model` and `provider/model` are all forms a log
 * can carry for the same route. Splitting the spelling once lets an override
 * keep working when the provider changes how it names its ids.
 * @param {string} model - the route's model id, possibly provider-qualified.
 * @returns {{provider: string | undefined, id: string}} both halves, lowercased.
 */
function splitModelId(model) {
  let text = model.trim().toLowerCase()
  if (text.startsWith('@')) text = text.slice(1)
  const cut = Math.max(text.lastIndexOf('/'), text.lastIndexOf(':'))
  return cut < 0 || cut >= text.length - 1
    ? { provider: undefined, id: text }
    : { provider: text.slice(0, cut), id: text.slice(cut + 1) }
}

/**
 * The bare id alone — what a route and a bare price override are matched on.
 * @param {string} model - the route's model id, possibly provider-qualified.
 * @returns {string} the bare lowercased id.
 */
function normalizeModelId(model) {
  return splitModelId(model).id
}

/** The route key a bucket and a series point both use. */
function keyOf(provider, model) {
  return `${provider}\u0000${model}`
}

/**
 * Build the resolved price table from the built-ins plus the plugin's `prices`
 * config. An override REPLACES a built-in rather than merging into it, so a
 * zero rate can be set deliberately; a malformed entry is ignored instead of
 * poisoning every later estimate.
 *
 * An override that names its provider (`"moonshot/kimi-k2"` or `provider:`)
 * registers a provider-qualified row; one that does not registers a bare row
 * that shadows every built-in with the same id. Both rank above the built-ins.
 * @param {unknown} overrides - the plugin config's `prices` value, if any.
 * @returns {{ table: Map<string, object>, bare: Map<string, object> }} the
 *   merged qualified + built-in table, plus the bare-override map that always
 *   wins over the table for the same id.
 */
function resolvePrices(overrides) {
  const table = new Map()
  const qualified = new Map()
  const bare = new Map()
  const freeze = (provider, price) => Object.freeze({
    provider,
    input: price.input,
    output: price.output,
    cacheRead: price.cacheRead ?? 0,
    cacheWrite: price.cacheWrite ?? price.input,
  })

  for (const [id, price] of Object.entries(DEFAULT_PRICES)) {
    const row = freeze(price.provider, price)
    table.set(id, row)
    table.set(keyOf(price.provider, id).toLowerCase(), row)
  }

  if (isRecord(overrides)) {
    for (const [rawId, value] of Object.entries(overrides)) {
      if (!isRecord(value)) continue
      if (!isRate(value.input) || !isRate(value.output)) continue
      const split = splitModelId(rawId)
      if (split.id === '') continue
      const declared = typeof value.provider === 'string' && value.provider !== '' ? value.provider.toLowerCase() : undefined
      const provider = declared ?? split.provider ?? 'custom'
      const row = freeze(provider, {
        input: value.input,
        output: value.output,
        cacheRead: isRate(value.cacheRead) ? value.cacheRead : 0,
        cacheWrite: isRate(value.cacheWrite) ? value.cacheWrite : undefined,
      })
      if (declared !== undefined || split.provider !== undefined) qualified.set(keyOf(provider, split.id), row)
      else bare.set(split.id, row)
    }
  }

  // A later Map entry overwrites an earlier one under the same key, so the
  // provider-qualified overrides spread in after (and win over) the built-ins.
  return { table: new Map([...table, ...qualified]), bare }
}

/**
 * Look up one route's rates: a bare override for the id, then the exact
 * provider-qualified key, then the bare normalized id, then the family fallback.
 * @param {string} provider - the route's provider.
 * @param {string} model - the route's model id.
 * @param {{ table: Map<string, object>, bare: Map<string, object> }} prices - the resolved price table.
 * @returns {{price: object, source: 'exact' | 'family'} | undefined} the match.
 */
function lookupPrice(provider, model, prices) {
  const bare = normalizeModelId(model)
  const override = prices.bare.get(bare)
  const exact = override ?? prices.table.get(keyOf(provider, bare).toLowerCase()) ?? prices.table.get(bare)
  if (exact !== undefined) return { price: exact, source: 'exact' }
  for (const family of PRICE_FAMILIES) {
    if (family.match.test(bare)) return { price: family, source: 'family' }
  }
  return undefined
}

/**
 * Estimated USD spend of one bucket under one rate row, split per component.
 * The total is the exact sum of the printed components, never a separately
 * rounded figure, so a Client that adds the parts up sees no drift.
 * @param {object} bucket - the folded per-route totals.
 * @param {object} price - USD per million tokens for all four components.
 * @returns {{input: number, output: number, cacheRead: number, cacheWrite: number, total: number}} the estimate.
 */
function costOf(bucket, price) {
  const part = (tokens, rate) => (tokens * rate) / PER_TOKENS
  const input = part(bucket.inputTokens, price.input)
  const output = part(bucket.outputTokens, price.output)
  const cacheRead = part(bucket.cacheReadTokens, price.cacheRead)
  const cacheWrite = part(bucket.cacheWriteTokens, price.cacheWrite)
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite }
}

/** The empty cost row an unpriced route reports. */
const NO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 })

let priceTable = resolvePrices(undefined)

/** Cached views, invalidated whole when the price table is replaced. */
let viewCache = new WeakMap()

/**
 * The wire value built from a totals map, sorted by metered tokens then calls,
 * with every row's cost estimate resolved against the current price table.
 */
function viewOf(state) {
  const cached = viewCache.get(state)
  if (cached !== undefined) return cached

  const rows = Object.values(state.totals).map(bucket => {
    const match = lookupPrice(bucket.provider, bucket.model, priceTable)
    return {
      ...bucket,
      key: keyOf(bucket.provider, bucket.model),
      cost: match === undefined ? { ...NO_COST } : costOf(bucket, match.price),
      priceSource: match === undefined ? 'none' : match.source,
      price: match === undefined ? null : {
        input: match.price.input,
        output: match.price.output,
        cacheRead: match.price.cacheRead,
        cacheWrite: match.price.cacheWrite,
      },
    }
  })
  rows.sort((left, right) => weightOf(right) - weightOf(left) || right.calls - left.calls)

  const totals = emptyBucket('', '')
  const cost = { ...NO_COST }
  let unpriced = 0
  for (const row of rows) {
    for (const field of ['calls', ...BUCKETS, 'genMs', 'ttftMs']) totals[field] += row[field]
    for (const field of ['input', 'output', 'cacheRead', 'cacheWrite']) cost[field] += row.cost[field]
    if (row.priceSource === 'none') unpriced += 1
  }
  cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite

  const view = { totals, cost, unpriced, models: rows, series: state.series }
  viewCache.set(state, view)
  return view
}

/**
 * Register the projection unit for the caller's lifetime.
 *
 * @param {object} ctx - the Host plugin context.
 * @param {{prices?: object}} [config] - the plugin's `cordis.patch.yml` config.
 *   `prices` maps a model id (bare, `provider/model`, or `provider:model`) to
 *   USD-per-million rates `{ provider?, input, output, cacheRead?, cacheWrite? }`.
 *   A supplied entry replaces the built-in row for that id.
 */
export function apply(ctx, config) {
  priceTable = resolvePrices(isRecord(config) ? config.prices : undefined)
  viewCache = new WeakMap()
  ctx.effect(() => ctx.sessionProjections.register({
    key: KEY,
    stateVersion: STATE_VERSION,
    stateSchema: { parse: parseState },
    init: () => ({ route: null, step: null, last: null, totals: {}, series: [], settled: 0 }),
    apply: applyEvent,
    wire: {
      viewSchema: { parse: parseView },
      view: viewOf,
    },
  }), 'usage-overlay: modelUsageByRoute unit')
}
