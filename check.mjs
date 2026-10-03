/**
 * Offline check for the usage-overlay Host fold.
 *
 * Drives `index.js` through a fake projection registry with hand-built session
 * events shaped exactly like `SessionEventMap`, then asserts the wire view. No
 * Harness process is involved: this only proves the pure fold, the per-model
 * series regrouping, and the cost estimate arithmetic.
 */
import assert from 'node:assert/strict'
import { apply } from './index.js'

/** Register the unit against a fake registry and return its definition. */
function mount(config) {
  let definition
  const ctx = {
    effect: (run) => { run() },
    sessionProjections: { register: (def) => { definition = def; return () => {} } },
  }
  apply(ctx, config)
  assert.ok(definition, 'projection unit registered')
  assert.equal(definition.key, 'modelUsageByRoute')
  return definition
}

const definition = mount()
let state = definition.init({}, 0)
const drive = (event) => { state = definition.apply(state, { seq: event.seq ?? 0, time: event.time, type: event.type, data: event.data }) }
const view = () => definition.wire.viewSchema.parse(definition.wire.view(state))

const chunkGroup = (time0, dt) => ({ type: 'text-chunks', time0, index: 0, dt, texts: dt.map(() => 'x') })
const usageChunk = (time, usage) => ({ type: 'chunk', time, chunk: { type: 'usage', usage } })

// --- one settled call -------------------------------------------------------
drive({ type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } })
drive({ type: 'step/start', seq: 2, time: 1100, data: { turn: 1, step: 1 } })
drive({ type: 'request/header', seq: 3, time: 1110, data: { header: { config: { provider: 'deepseek', model: 'deepseek-flash' } }, reason: 'initial' } })
const stream = [chunkGroup(1500, [100, 100]), usageChunk(1900, { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 500 })]
drive({ type: 'assistant/attempt', seq: 4, time: 1950, data: { turn: 1, step: 1, stream } })
drive({
  type: 'assistant/message', seq: 5, time: 1960,
  data: { turn: 1, step: 1, message: { role: 'assistant', source: { kind: 'model', provider: 'deepseek', model: 'deepseek-flash' } }, stream, usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 500 } },
})

let out = view()
assert.deepEqual(
  { ...out.totals },
  { provider: '', model: '', calls: 1, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 500, cacheWriteTokens: 0, genMs: 400, ttftMs: 400 },
  'attempt then message replaces, never doubles',
)
assert.equal(out.models.length, 1)
assert.equal(out.models[0].model, 'deepseek-flash')
assert.equal(out.models[0].provider, 'deepseek')
assert.equal(out.models[0].key, 'deepseek\u0000deepseek-flash')
assert.equal(out.models[0].priceSource, 'exact')
assert.deepEqual(out.models[0].price, { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 })

// Estimated cost: 1000 in @ 0.30/M + 200 out @ 1.20/M + 500 cache-read @ 0.006/M.
const expected = (1000 * 0.3 + 200 * 1.2 + 500 * 0.006) / 1e6
assert.ok(Math.abs(out.models[0].cost.total - expected) < 1e-12, 'per-model cost matches the published rates')
assert.equal(out.unpriced, 0)
assert.ok(Math.abs(out.cost.total - expected) < 1e-12, 'session cost sums its priced models')

// The per-model series carries the settlement, keyed by model, for the chart.
assert.equal(out.series.length, 1)
assert.equal(out.series[0].index, 0)
assert.equal(out.series[0].key, 'deepseek\u0000deepseek-flash')
assert.equal(out.series[0].model, 'deepseek-flash')
assert.equal(out.series[0].outputTokens, 200)
assert.equal(out.series[0].cacheWriteTokens, 0)

// The same fold run again over one state must not publish a new view object.
assert.equal(definition.wire.view(state), definition.wire.view(state), 'wire view identity is cached')
const totalsBefore = state.totals
drive({ type: 'step/start', seq: 6, time: 2000, data: { turn: 1, step: 2 } })
assert.equal(state.totals, totalsBefore, 'a step boundary does not touch totals')

// --- a retried attempt is metered on its own --------------------------------
drive({ type: 'request/header', seq: 7, time: 2100, data: { header: { config: { provider: 'deepseek', model: 'deepseek-flash' } }, reason: 'resume' } })
drive({ type: 'assistant/attempt', seq: 8, time: 2300, data: { turn: 1, step: 2, stream: [chunkGroup(2200, [50]), usageChunk(2250, { inputTokens: 300, outputTokens: 50 })] } })
drive({ type: 'llm/retry-started', seq: 9, time: 2400, data: { turn: 1, step: 2 } })
drive({ type: 'assistant/attempt', seq: 10, time: 2600, data: { turn: 1, step: 2, stream: [chunkGroup(2500, [40]), usageChunk(2540, { inputTokens: 300, outputTokens: 60 })] } })
drive({
  type: 'assistant/message', seq: 11, time: 2550,
  data: { turn: 1, step: 2, message: { role: 'assistant', source: { kind: 'model', provider: 'deepseek', model: 'deepseek-flash' } }, stream: [chunkGroup(2500, [40]), usageChunk(2540, { inputTokens: 300, outputTokens: 60 })], usage: { inputTokens: 300, outputTokens: 60 } },
})

out = view()
const flash = out.models.find(model => model.model === 'deepseek-flash')
assert.equal(flash.calls, 3, 'failed attempt, retry and settlement all count')
assert.equal(flash.inputTokens, 1600)
assert.equal(flash.outputTokens, 310)

// --- a second route splits out, ordered by metered tokens -------------------
drive({ type: 'step/start', seq: 12, time: 3000, data: { turn: 1, step: 3 } })
drive({ type: 'request/header', seq: 13, time: 3010, data: { header: { config: { provider: 'moonshot', model: 'kimi-k2' } }, reason: 'change' } })
drive({
  type: 'assistant/message', seq: 14, time: 4000,
  data: { turn: 1, step: 3, message: { role: 'assistant', source: { kind: 'model', provider: 'moonshot', model: 'kimi-k2' } }, stream: [chunkGroup(3500, [500])], usage: { inputTokens: 100, outputTokens: 900000 } },
})

out = view()
assert.equal(out.models.length, 2)
assert.equal(out.models[0].model, 'kimi-k2', 'most fresh tokens first')
assert.equal(out.totals.calls, 4)
assert.equal(out.totals.inputTokens, 1700)
assert.equal(out.totals.outputTokens, 900310)

// `kimi-k2` is not a published id, so it resolves through the family fallback
// rather than silently reporting a made-up exact price.
const kimi = out.models.find(model => model.model === 'kimi-k2')
assert.equal(kimi.priceSource, 'family')
assert.equal(kimi.price.output, 4)
assert.equal(out.unpriced, 0)

// The joined estimate is the sum of both rows' components.
const sum = out.models.reduce((total, row) => total + row.cost.total, 0)
assert.ok(Math.abs(out.cost.total - sum) < 1e-12, 'session cost equals the sum of its model rows')

// Series indices stay dense across two models so the chart has no phantom gap,
// and the retried step's replacement kept index 1 rather than consuming a slot.
assert.deepEqual(out.series.map(point => point.index), [0, 1, 2])
assert.deepEqual(out.series.map(point => point.model), ['deepseek-flash', 'deepseek-flash', 'kimi-k2'])
assert.deepEqual(out.series.map(point => point.step), [1, 2, 3])
assert.equal(state.settled, 3, 'one settlement counter tick per distinct step')

// --- an unpriced model is reported, never priced at zero by accident --------
drive({ type: 'step/start', seq: 15, time: 5000, data: { turn: 1, step: 4 } })
drive({
  type: 'assistant/message', seq: 16, time: 6000,
  data: { turn: 1, step: 4, message: { role: 'assistant', source: { kind: 'model', provider: 'acme', model: 'mystery-9000' } }, stream: [], usage: { inputTokens: 1000, outputTokens: 1000 } },
})
out = view()
const mystery = out.models.find(model => model.model === 'mystery-9000')
assert.equal(mystery.priceSource, 'none')
assert.equal(mystery.price, null)
assert.deepEqual(mystery.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 })
assert.equal(out.unpriced, 1, 'the unpriced route is counted so the Client can warn')

// --- a config override replaces a built-in ----------------------------------
const custom = mount({ prices: { 'deepseek-flash': { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 3 } , 'acme/mystery-9000': { provider: 'acme', input: 10, output: 20 } } })
let customState = custom.init({}, 0)
const driveCustom = (event) => { customState = custom.apply(customState, { seq: 0, time: event.time, type: event.type, data: event.data }) }
driveCustom({
  type: 'assistant/message', time: 100,
  data: { turn: 1, step: 1, message: { role: 'assistant', source: { kind: 'model', provider: 'deepseek', model: 'deepseek-flash' } }, stream: [], usage: { inputTokens: 1000000, outputTokens: 1000000, cacheReadTokens: 1000000, cacheWriteTokens: 1000000 } },
})
driveCustom({
  type: 'assistant/message', time: 200,
  data: { turn: 1, step: 2, message: { role: 'assistant', source: { kind: 'model', provider: 'acme', model: 'mystery-9000' } }, stream: [], usage: { inputTokens: 1000000, outputTokens: 1000000 } },
})
const customOut = custom.wire.viewSchema.parse(custom.wire.view(customState))
const flashRow = customOut.models.find(row => row.model === 'deepseek-flash')
assert.deepEqual(flashRow.price, { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 3 }, 'override replaces the built-in row')
assert.equal(flashRow.cost.total, 6.5, 'one million of each bucket at the overridden rates')
assert.equal(customOut.unpriced, 0, 'a provider-qualified override prices an otherwise unknown model')
const mysteryRow = customOut.models.find(row => row.model === 'mystery-9000')
assert.equal(mysteryRow.cost.total, 30, 'an override without cacheWrite charges input for cache writes')
assert.equal(mysteryRow.price.cacheWrite, 10)

// --- malformed input is rejected, and state round-trips ---------------------
assert.throws(() => definition.stateSchema.parse({ route: null, step: null, last: null, totals: { a: { provider: 'x' } }, series: [], settled: 0 }), /usage-overlay/)
assert.throws(() => definition.wire.viewSchema.parse({ totals: out.totals }), /usage-overlay/)
assert.deepEqual(definition.stateSchema.parse(JSON.parse(JSON.stringify(state))), state, 'checkpoint round-trip')

console.log('usage-overlay host fold: all checks passed')
