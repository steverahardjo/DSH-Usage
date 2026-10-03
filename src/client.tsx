/**
 * Client half of the `usage-overlay` bundle, written in TypeScript + JSX and
 * built with esbuild (see `build.mjs`). The built artifact keeps the loader
 * shape the web shell expects: it calls `window.__ModuleLoader__.load` with a
 * factory that returns `{ inject, apply }`, resolves React from the platform
 * module table, and inlines Recharts.
 *
 * Two seats, one dataset:
 * - `conversation.input.right` — the always-visible session readout on the
 *   composer tool row, which also owns the store for the overlay.
 * - `shell.overlay` — the centered frosted panel with a Session / Global scope
 *   switch, a Recharts multi-model line chart, and expandable per-model cards
 *   carrying an estimated-cost breakdown.
 */

import React, { useEffect, useMemo, useState, useCallback, useSyncExternalStore, Fragment } from 'react'
import {
  ResponsiveContainer, LineChart, Line, CartesianGrid, XAxis, YAxis, Tooltip,
} from 'recharts'

const NS = 'usageOverlay'
const KEY = 'modelUsageByRoute'

// ---------------------------------------------------------------------------
// Series palette (Paul Tol "muted", tuned per surface). DSH has no categorical
// chart palette, so the plugin owns one — the same one `dsh-interactive-chart`
// uses. Light/dark variants differ only where tuning moved a hue.
// ---------------------------------------------------------------------------
const PALETTE: ReadonlyArray<{ light: string; dark: string }> = [
  { light: '#cc6677', dark: '#cc6677' },
  { light: '#a29556', dark: '#ddcc77' },
  { light: '#117733', dark: '#117733' },
  { light: '#679bb6', dark: '#88ccee' },
  { light: '#882255', dark: '#924c69' },
  { light: '#42a494', dark: '#44aa99' },
  { light: '#999933', dark: '#999933' },
  { light: '#aa4499', dark: '#aa4499' },
]

function colorOf(index: number, dark: boolean): string {
  const slot = PALETTE[((index % PALETTE.length) + PALETTE.length) % PALETTE.length] ?? PALETTE[0]!
  return dark ? slot.dark : slot.light
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------
const en: Record<string, string> = {
  'panel.title': 'Usage',
  'panel.subtitle': 'Session & global provider usage',
  'panel.close': 'Close',
  'panel.hint': 'Provider-reported estimates · Esc closes',
  'panel.waiting': 'Waiting for the first settled request…',
  'panel.empty': 'No provider usage recorded in this session yet.',
  'panel.emptyGlobal': 'No usage recorded across sessions yet.',
  'tab.session': 'Session',
  'tab.global': 'Global',
  'panel.maximize': 'Toggle full width',
  'panel.calls': 'Calls',
  'metric.input': 'Input',
  'metric.output': 'Output',
  'metric.cached': 'Cached',
  'metric.latency': 'Latency',
  'metric.ttft': 'TTFT',
  'metric.throughput': 'Throughput',
  'metric.cost': 'Est. cost',
  'metric.rate': 'Rate',
  'metric.tokens': 'Tokens',
  'model.calls': '{count} calls',
  'model.unknown': 'unknown model',
  'model.expand': 'Toggle details',
  'model.priceExact': 'list price',
  'model.priceFamily': 'family estimate',
  'model.priceNone': 'no price',
  'pill.open': 'Show usage',
  'pill.close': 'Hide usage',
  'unit.rate': '{value} tok/s',
  'unit.none': '—',
  'cost.total': 'Est. total',
  'cost.session': 'This session',
  'cost.global': 'All sessions',
  'cost.unpriced': '{count} unpriced',
  'cost.estimated': 'estimated',
  'cost.perModel': 'per model',
  'chart.title': 'Cumulative tokens · {metric}',
  'chart.hint': 'Hover for values · click a legend item to toggle',
  'chart.peak': 'peak {peak}',
  'chart.span': '{span} elapsed',
  'chart.metric.input': 'input',
  'chart.metric.output': 'output',
  'chart.metric.cached': 'cache read',
  'card.tokens': 'Tokens',
  'card.timing': 'Timing',
  'card.cost': 'Cost',
  'card.rate': 'Rate',
  'card.input': 'Input',
  'card.output': 'Output',
  'card.cacheRead': 'Cache read',
  'card.cacheWrite': 'Cache write',
  'card.avgLatency': 'Avg latency',
  'card.avgTtft': 'Avg TTFT',
  'card.throughput': 'Throughput',
  'card.price': 'Pricing',
  'card.value': 'Value',
  'readout.tokens': 'tokens',
  'readout.cost': 'cost',
}

const zh: Record<string, string> = {
  'panel.title': '用量',
  'panel.subtitle': '会话与全局提供商用量',
  'panel.close': '关闭',
  'panel.hint': '提供商上报的估算 · 按 Esc 关闭',
  'panel.waiting': '等待第一次结算的请求…',
  'panel.empty': '本次会话还没有提供商用量记录。',
  'panel.emptyGlobal': '所有会话还没有用量记录。',
  'tab.session': '会话',
  'tab.global': '全局',
  'panel.maximize': '切换全宽',
  'panel.calls': '调用',
  'metric.input': '输入',
  'metric.output': '输出',
  'metric.cached': '缓存',
  'metric.latency': '延迟',
  'metric.ttft': '首字',
  'metric.throughput': '吞吐',
  'metric.cost': '预估费用',
  'metric.rate': '单价',
  'metric.tokens': '令牌',
  'model.calls': '{count} 次',
  'model.unknown': '未知模型',
  'model.expand': '切换详情',
  'model.priceExact': '官方单价',
  'model.priceFamily': '同类估算',
  'model.priceNone': '无单价',
  'pill.open': '显示用量',
  'pill.close': '隐藏用量',
  'unit.rate': '{value} tok/s',
  'unit.none': '—',
  'cost.total': '预估总计',
  'cost.session': '本会话',
  'cost.global': '全部会话',
  'cost.unpriced': '{count} 项未计价',
  'cost.estimated': '估算',
  'cost.perModel': '按模型',
  'chart.title': '累计令牌 · {metric}',
  'chart.hint': '悬停查看数值 · 点击图例切换',
  'chart.peak': '峰值 {peak}',
  'chart.span': '已历时 {span}',
  'chart.metric.input': '输入',
  'chart.metric.output': '输出',
  'chart.metric.cached': '缓存读取',
  'card.tokens': '令牌',
  'card.timing': '耗时',
  'card.cost': '费用',
  'card.rate': '单价',
  'card.input': '输入',
  'card.output': '输出',
  'card.cacheRead': '缓存读取',
  'card.cacheWrite': '缓存写入',
  'card.avgLatency': '平均延迟',
  'card.avgTtft': '平均首字',
  'card.throughput': '吞吐',
  'card.price': '计价',
  'card.value': '数值',
  'readout.tokens': '令牌',
  'readout.cost': '费用',
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function formatTokens(value: number): string {
  const count = Number(value) || 0
  if (count < 1000) return String(Math.round(count))
  if (count < 1000000) return `${(count / 1000).toFixed(count < 10000 ? 2 : 1)}k`
  return `${(count / 1000000).toFixed(2)}M`
}

function formatMs(value: number): string {
  const ms = Number(value) || 0
  if (ms <= 0) return '0 ms'
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

function formatDuration(ms: number): string {
  const span = Number(ms) || 0
  if (span < 60000) return `${Math.round(span / 1000)}s`
  if (span < 3600000) return `${Math.round(span / 60000)}m`
  return `${Math.floor(span / 3600000)}h ${Math.round((span % 3600000) / 60000)}m`
}

function formatMoney(value: number): string {
  const amount = Number(value) || 0
  if (amount === 0) return '$0'
  if (amount >= 1000) return `$${(amount / 1000).toFixed(2)}k`
  if (amount >= 1) return `$${amount.toFixed(2)}`
  if (amount >= 0.01) return `$${amount.toFixed(3)}`
  return `$${amount.toFixed(5)}`
}

function formatRate(outputTokens: number, genMs: number): string | undefined {
  if (!(outputTokens > 0) || !(genMs > 0)) return undefined
  return `${(outputTokens / (genMs / 1000)).toFixed(1)}`
}

function weightOf(bucket: UsageBucket): number {
  return bucket.inputTokens + bucket.outputTokens
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------
interface OverlayState { open: boolean; sessionId: string | undefined }

function createUsageStore() {
  let state: OverlayState = { open: false, sessionId: undefined }
  const listeners = new Set<() => void>()
  const faces = new Map<string, ObservableSnapshot<unknown>>()
  const emit = () => { for (const listener of [...listeners]) listener() }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    setFace(sessionId: string, face: ObservableSnapshot<unknown> | undefined) {
      if (face === undefined) faces.delete(sessionId)
      else faces.set(sessionId, face)
      if (state.sessionId === sessionId) emit()
    },
    faceFor(sessionId: string | undefined) {
      return sessionId === undefined ? undefined : faces.get(sessionId)
    },
    toggle(sessionId: string) {
      const open = !(state.open && state.sessionId === sessionId)
      state = open ? { open: true, sessionId } : { open: false, sessionId: undefined }
      emit()
    },
    close() {
      if (!state.open) return
      state = { open: false, sessionId: undefined }
      emit()
    },
  }
}

type UsageStore = ReturnType<typeof createUsageStore>

function faceFor(sessions: DshSessions, sessionId: string): ObservableSnapshot<unknown> | undefined {
  const binding = sessions.binding(sessionId)
  return binding === undefined ? undefined : binding.session.projections.faceOf(KEY)
}

// ---------------------------------------------------------------------------
// Data shape helpers
// ---------------------------------------------------------------------------
function readView(value: unknown): UsageView | undefined {
  if (!isRecord(value) || !isRecord(value.totals) || !Array.isArray(value.models) || !Array.isArray(value.series)) return undefined
  return value as unknown as UsageView
}

function aggregateViews(views: UsageView[]): UsageView {
  const byKey = new Map<string, ModelRow>()
  const totals: UsageBucket = { provider: '', model: '', calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, genMs: 0, ttftMs: 0 }
  const cost: CostRow = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  let unpriced = 0
  const series: SeriesPoint[] = []

  const fields = ['calls', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'genMs', 'ttftMs'] as const
  const costFields = ['input', 'output', 'cacheRead', 'cacheWrite'] as const

  for (const view of views) {
    for (const field of fields) totals[field] += view.totals[field]
    for (const row of view.models) {
      const current = byKey.get(row.key)
      if (current === undefined) {
        byKey.set(row.key, { ...row })
      } else {
        for (const field of fields) current[field] += row[field]
        for (const field of costFields) current.cost[field] += row.cost[field]
        current.cost.total = current.cost.input + current.cost.output + current.cost.cacheRead + current.cost.cacheWrite
      }
    }
    unpriced += view.unpriced
    series.push(...view.series)
  }

  const models = [...byKey.values()].sort((a, b) => weightOf(b) - weightOf(a) || b.calls - a.calls)
  for (const field of costFields) {
    cost[field] = 0
    for (const row of models) cost[field] += row.cost[field]
  }
  cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite
  series.sort((a, b) => a.index - b.index)
  return { totals, cost, unpriced, models, series }
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------
function useStoreValue(store: UsageStore): OverlayState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}

function useObservableValue<T>(face: ObservableSnapshot<unknown> | undefined): T | undefined {
  const subscribe = useCallback(
    (listener: () => void) => (face === undefined ? () => {} : face.subscribe(listener)),
    [face],
  )
  const read = useCallback(() => (face === undefined ? undefined : face.getSnapshot() as T), [face])
  return useSyncExternalStore(subscribe, read, read)
}

function useSessionsList(sessions: DshSessions): SessionListSnapshot {
  return useSyncExternalStore(sessions.list.subscribe, sessions.list.getSnapshot, sessions.list.getSnapshot)
}

function useGlobalView(sessions: DshSessions): UsageView {
  const list = useSessionsList(sessions)
  return useMemo(() => {
    const views: UsageView[] = []
    for (const entry of Object.values(list.projectionsBySession)) {
      const view = readView(entry.values[KEY])
      if (view !== undefined) views.push(view)
    }
    return aggregateViews(views)
  }, [list])
}

function useDarkScheme(): boolean {
  const [dark, setDark] = useState(() => document.body.hasAttribute('data-ds-dark-theme'))
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setDark(document.body.hasAttribute('data-ds-dark-theme'))
    })
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
    return () => observer.disconnect()
  }, [])
  return dark
}

// ---------------------------------------------------------------------------
// Presentational pieces
// ---------------------------------------------------------------------------
function Metric({ label, value }: { label: string; value: string | undefined }) {
  return (
    <div style={styles.metric}>
      <span style={styles.metricLabel}>{label}</span>
      <span style={styles.metricValue}>{value ?? '—'}</span>
    </div>
  )
}

function ShareBar({ models, dark }: { models: ModelRow[]; dark: boolean }) {
  const total = models.reduce((sum, model) => sum + weightOf(model), 0)
  if (!(total > 0)) return null
  return (
    <div style={styles.shareBar} aria-hidden>
      {models.map((model, index) => (
        <div key={model.key} style={{ ...styles.shareSegment, width: `${(weightOf(model) / total) * 100}%`, background: colorOf(index, dark) }} />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Chart
// ---------------------------------------------------------------------------
type MetricMode = 'output' | 'input' | 'cached'

function metricOf(point: SeriesPoint, mode: MetricMode): number {
  return mode === 'input' ? point.inputTokens : mode === 'cached' ? point.cacheReadTokens : point.outputTokens
}

interface ChartRow { index: number; [modelKey: string]: number }

function ChartSection({ view, dark, t }: { view: UsageView; dark: boolean; t: Translator }) {
  const [mode, setMode] = useState<MetricMode>('output')
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const models = view.models
  const points = view.series

  // Clean chart keys: the model wire key contains a \0 separator, which is a
  // legal object key but a fragile Recharts dataKey. Index into the sorted
  // model list instead — stable for one render.
  const chartKey = (index: number) => `m${index}`

  const rows = useMemo<ChartRow[]>(() => {
    const cumulative = new Map<string, number>()
    const out: ChartRow[] = []
    for (const point of points) {
      const modelIndex = models.findIndex(model => model.key === point.key)
      const key = chartKey(modelIndex)
      const next = (cumulative.get(key) ?? 0) + metricOf(point, mode)
      cumulative.set(key, next)
      const row: ChartRow = { index: point.index }
      for (let index = 0; index < models.length; index += 1) row[chartKey(index)] = cumulative.get(chartKey(index)) ?? 0
      out.push(row)
    }
    return out
  }, [points, models, mode])

  const toggle = (key: string) => {
    setHidden(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const visible = models.filter(model => !hidden.has(model.key))
  const peak = models.reduce((max, model) => Math.max(max, model.outputTokens), 0)
  const span = points.length >= 2 ? Math.max(1, points[points.length - 1]!.t - points[0]!.t) : 0

  const lines = models.map((model, index) => hidden.has(model.key) ? null : (
    <Line
      key={model.key}
      type="monotone"
      dataKey={chartKey(index)}
      name={model.model}
      stroke={colorOf(index, dark)}
      strokeWidth={2}
      dot={false}
      activeDot={{ r: 4 }}
      isAnimationActive={false}
    />
  ))

  return (
    <div style={styles.chartCard}>
      <div style={styles.chartHead}>
        <span style={styles.chartTitle}>{t('chart.title', { metric: t(`chart.metric.${mode}`) })}</span>
        <span style={styles.chartMeta}>
          {t('chart.peak', { peak: formatTokens(peak) })} · {t('chart.span', { span: formatDuration(span) })}
        </span>
      </div>
      <div style={styles.metricToggle}>
        {(['output', 'input', 'cached'] as MetricMode[]).map(key => (
          <button
            key={key}
            type="button"
            onClick={() => setMode(key)}
            style={mode === key ? { ...styles.metricToggleBtn, ...styles.metricToggleActive } : styles.metricToggleBtn}
          >
            {t(`chart.metric.${key}`)}
          </button>
        ))}
      </div>
      {points.length < 2 ? (
        <div style={styles.chartEmpty}>{t('panel.empty')}</div>
      ) : (
        <div style={styles.chartWrap}>
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--dsw-alias-border-l1)" vertical={false} />
              <XAxis dataKey="index" tick={{ fontSize: 11, fill: 'var(--dsw-alias-label-secondary)' }} tickLine={false} axisLine={false} />
              <YAxis
                tick={{ fontSize: 11, fill: 'var(--dsw-alias-label-secondary)' }}
                tickLine={false}
                axisLine={false}
                width={56}
                tickFormatter={(value: number) => formatTokens(value)}
              />
              <Tooltip
                contentStyle={styles.tooltip}
                labelStyle={{ color: 'var(--dsw-alias-label-secondary)', fontSize: 11 }}
                labelFormatter={(label: number) => `#${label + 1}`}
                formatter={(value, name) => [formatTokens(Number(value)), models.find(m => m.model === name)?.model ?? String(name)]}
              />
              {lines}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
      <div style={styles.legend}>
        {models.map((model, index) => (
          <button
            key={model.key}
            type="button"
            onClick={() => toggle(model.key)}
            style={{ ...styles.legendItem, opacity: hidden.has(model.key) ? 0.4 : 1 }}
          >
            <span style={{ ...styles.legendDot, background: colorOf(index, dark) }} />
            <span style={{ textDecoration: hidden.has(model.key) ? 'line-through' : 'none' }}>{model.model || t('model.unknown')}</span>
          </button>
        ))}
      </div>
      <div style={styles.chartHint}>{t('chart.hint')}</div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Model cards
// ---------------------------------------------------------------------------
/** One model's selectable row in the left-hand list. */
function ModelCard({ row, index, dark, t, selected, onSelect }: {
  row: ModelRow
  index: number
  dark: boolean
  t: Translator
  selected: boolean
  onSelect: () => void
}) {
  const color = colorOf(index, dark)
  const cached = row.cacheReadTokens + row.cacheWriteTokens
  const priced = row.priceSource !== 'none'
  return (
    <div style={{
      ...styles.modelCard,
      ...(selected ? styles.modelCardSelected : null),
      borderLeft: `3px solid ${color}`,
    }}>
      <button type="button" onClick={onSelect} style={styles.modelHead} aria-pressed={selected} title={t('model.expand')}>
        <span style={{ ...styles.swatch, background: color }} />
        <span style={styles.modelName} title={`${row.provider}/${row.model}`}>{row.model || t('model.unknown')}</span>
        <span style={styles.modelProvider}>{row.provider}</span>
        <span style={styles.modelCalls}>{t('model.calls', { count: row.calls })}</span>
        <span style={styles.modelCost}>{priced ? formatMoney(row.cost.total) : t('unit.none')}</span>
        <span style={styles.chevron}>{selected ? '▸' : '›'}</span>
      </button>
      <div style={styles.statLine}>
        <span>{t('metric.input')} {formatTokens(row.inputTokens)}</span>
        <span>{t('metric.output')} {formatTokens(row.outputTokens)}</span>
        <span>{t('metric.cached')} {formatTokens(cached)}</span>
      </div>
    </div>
  )
}

/** One cell of a detail table. */
function Td({ children, num, strong }: { children?: React.ReactNode; num?: boolean; strong?: boolean }) {
  return (
    <td style={{ ...styles.td, ...(num ? styles.tdNum : null), ...(strong ? styles.tdStrong : null) }}>
      {children}
    </td>
  )
}

/** The right-hand detail tables for the selected model. */
function ModelDetail({ row, index, dark, t }: { row: ModelRow; index: number; dark: boolean; t: Translator }) {
  const color = colorOf(index, dark)
  const cached = row.cacheReadTokens + row.cacheWriteTokens
  const avgLatency = row.calls > 0 ? row.genMs / row.calls : 0
  const avgTtft = row.calls > 0 ? row.ttftMs / row.calls : 0
  const rate = formatRate(row.outputTokens, row.genMs)
  const priced = row.priceSource !== 'none'
  const price = row.price
  const money = (value: number) => (priced ? formatMoney(value) : t('unit.none'))
  const priceRate = (value: number | undefined) => (value === undefined ? t('unit.none') : `$${value}/M`)

  const buckets: Array<{ label: string; tokens: number; rate: number | undefined; cost: number }> = [
    { label: t('card.input'), tokens: row.inputTokens, rate: price?.input, cost: row.cost.input },
    { label: t('card.output'), tokens: row.outputTokens, rate: price?.output, cost: row.cost.output },
    { label: t('card.cacheRead'), tokens: row.cacheReadTokens, rate: price?.cacheRead, cost: row.cost.cacheRead },
    { label: t('card.cacheWrite'), tokens: row.cacheWriteTokens, rate: price?.cacheWrite, cost: row.cost.cacheWrite },
  ]

  const timings: Array<{ label: string; value: string }> = [
    { label: t('card.avgLatency'), value: formatMs(avgLatency) },
    { label: t('card.avgTtft'), value: formatMs(avgTtft) },
    { label: t('card.throughput'), value: rate === undefined ? t('unit.none') : t('unit.rate', { value: rate }) },
    { label: t('panel.calls'), value: String(row.calls) },
  ]

  const badge = row.priceSource === 'exact' ? t('model.priceExact') : row.priceSource === 'family' ? t('model.priceFamily') : t('model.priceNone')

  return (
    <div style={styles.detailPane}>
      <div style={styles.detailHead}>
        <span style={{ ...styles.swatch, background: color }} />
        <span style={styles.detailName} title={`${row.provider}/${row.model}`}>{row.model || t('model.unknown')}</span>
        <span style={styles.modelProvider}>{row.provider}</span>
        <span style={{ ...styles.badge, ...(priced ? styles.badgePriced : styles.badgeNone) }}>{badge}</span>
      </div>

      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.th}>{t('card.tokens')}</th>
            <th style={{ ...styles.th, ...styles.thNum }}>{t('metric.tokens')}</th>
            <th style={{ ...styles.th, ...styles.thNum }}>{t('metric.rate')}</th>
            <th style={{ ...styles.th, ...styles.thNum }}>{t('card.cost')}</th>
          </tr>
        </thead>
        <tbody>
          {buckets.map(bucket => (
            <tr key={bucket.label}>
              <Td>{bucket.label}</Td>
              <Td num>{formatTokens(bucket.tokens)}</Td>
              <Td num>{priceRate(bucket.rate)}</Td>
              <Td num>{money(bucket.cost)}</Td>
            </tr>
          ))}
          <tr>
            <Td strong>{t('cost.total')}</Td>
            <Td num strong>{formatTokens(row.inputTokens + row.outputTokens + cached)}</Td>
            <Td num />
            <Td num strong>{money(row.cost.total)}</Td>
          </tr>
        </tbody>
      </table>

      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.th}>{t('card.timing')}</th>
            <th style={{ ...styles.th, ...styles.thNum }}>{t('card.value')}</th>
          </tr>
        </thead>
        <tbody>
          {timings.map(item => (
            <tr key={item.label}>
              <Td>{item.label}</Td>
              <Td num>{item.value}</Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------
function UsagePanel({ data, global, t, dark, onClose }: {
  data: UsageView | undefined
  global: boolean
  t: Translator
  dark: boolean
  onClose: () => void
}) {
  const [maximized, setMaximized] = useState(false)
  const [selectedKey, setSelectedKey] = useState<string | undefined>(undefined)
  const models = data === undefined ? [] : [...data.models].sort((a, b) => weightOf(b) - weightOf(a) || b.calls - a.calls)
  // Selection is derived, never stale: an unset or vanished key falls back to
  // the largest model, so the right-hand table is never empty while rows exist.
  const selectedIndex = Math.max(0, models.findIndex(model => model.key === selectedKey))
  const selected = models[selectedIndex]
  const totals = data?.totals
  const rate = totals === undefined ? undefined : formatRate(totals.outputTokens, totals.genMs)
  const empty = data === undefined ? t('panel.waiting') : models.length === 0 ? (global ? t('panel.emptyGlobal') : t('panel.empty')) : null

  return (
    <div style={maximized ? { ...styles.panel, ...styles.panelMax } : styles.panel}>
      <div style={styles.header}>
        <div style={styles.titleBlock}>
          <span style={styles.title}>{t('panel.title')}</span>
          <span style={styles.subtitle}>{global ? t('cost.global') : t('cost.session')}</span>
        </div>
        <button type="button" onClick={() => setMaximized(m => !m)} style={styles.iconBtn} title={t('panel.maximize')} aria-label={t('panel.maximize')}>⤢</button>
        <button type="button" onClick={onClose} style={styles.closeBtn} title={t('panel.close')} aria-label={t('panel.close')}>×</button>
      </div>

      {empty !== null ? (
        <div style={styles.empty}>{empty}</div>
      ) : data === undefined || totals === undefined ? null : (
        <Fragment>
          <div style={styles.totalsRow}>
            <Metric label={t('panel.calls')} value={String(totals.calls)} />
            <Metric label={t('metric.input')} value={formatTokens(totals.inputTokens)} />
            <Metric label={t('metric.output')} value={formatTokens(totals.outputTokens)} />
            <Metric label={t('metric.cached')} value={formatTokens(totals.cacheReadTokens + totals.cacheWriteTokens)} />
            <Metric label={t('metric.latency')} value={totals.calls > 0 ? formatMs(totals.genMs / totals.calls) : undefined} />
            <Metric label={t('metric.ttft')} value={totals.calls > 0 ? formatMs(totals.ttftMs / totals.calls) : undefined} />
            <Metric label={t('metric.throughput')} value={rate === undefined ? undefined : t('unit.rate', { value: rate })} />
            <Metric label={t('metric.cost')} value={formatMoney(data.cost.total)} />
          </div>
          {data.unpriced > 0 && <div style={styles.unpriced}>{t('cost.unpriced', { count: data.unpriced })}</div>}
          <ChartSection view={data} dark={dark} t={t} />
          <ShareBar models={models} dark={dark} />
          <div style={styles.modelsSplit}>
            <div style={styles.modelsList}>
              {models.map((row, index) => (
                <ModelCard
                  key={row.key}
                  row={row}
                  index={index}
                  dark={dark}
                  t={t}
                  selected={index === selectedIndex}
                  onSelect={() => setSelectedKey(row.key)}
                />
              ))}
            </div>
            {selected !== undefined && <ModelDetail row={selected} index={selectedIndex} dark={dark} t={t} />}
          </div>
        </Fragment>
      )}
      <div style={styles.hint}>{t('panel.hint')}</div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------
function UsageReadout(props: { sessionId: string; face?: ObservableSnapshot<unknown>; usage: UsageStore; sessions: DshSessions; t: Translator }) {
  const data = readView(useObservableValue(props.face))
  const storeState = useStoreValue(props.usage)
  const globalView = useGlobalView(props.sessions)

  useEffect(() => {
    props.usage.setFace(props.sessionId, props.face)
    return () => props.usage.setFace(props.sessionId, undefined)
  }, [props.usage, props.sessionId, props.face])

  const sessionTokens = data === undefined ? undefined : weightOf(data.totals)
  const globalTokens = weightOf(globalView.totals)
  const active = storeState.open && storeState.sessionId === props.sessionId
  const hasAny = sessionTokens !== undefined || globalTokens > 0
  const { t } = props

  return (
    <button
      type="button"
      onClick={() => props.usage.toggle(props.sessionId)}
      style={active ? { ...styles.readout, ...styles.readoutActive } : styles.readout}
      aria-expanded={active}
      aria-label={active ? t('pill.close') : t('pill.open')}
      title={active ? t('pill.close') : t('pill.open')}
    >
      <span style={hasAny ? { ...styles.dot, ...styles.dotLive } : styles.dot} />
      <span style={styles.readoutValue}>{sessionTokens === undefined ? t('unit.none') : formatTokens(sessionTokens)}</span>
      <span style={styles.readoutUnit}>{t('readout.tokens')}</span>
      <span style={styles.readoutSep}>·</span>
      <span style={styles.readoutValue}>{formatMoney(globalView.cost.total)}</span>
      <span style={styles.readoutUnit}>{t('readout.cost')}</span>
    </button>
  )
}

function UsageOverlay(props: { usage: UsageStore; sessions: DshSessions; t: Translator }) {
  const state = useStoreValue(props.usage)
  const dark = useDarkScheme()
  const face = props.usage.faceFor(state.sessionId)
  const data = readView(useObservableValue(face))
  const globalView = useGlobalView(props.sessions)
  const [tab, setTab] = useState<'session' | 'global'>('session')
  const { t } = props

  useEffect(() => {
    if (!state.open) return undefined
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') props.usage.close() }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [props.usage, state.open])

  if (!state.open) return null
  const shown = tab === 'global' ? globalView : data

  return (
    <div style={styles.overlay}>
      <div style={styles.tabBar}>
        <button type="button" onClick={() => setTab('session')} style={tab === 'session' ? { ...styles.tab, ...styles.tabActive } : styles.tab}>{t('tab.session')}</button>
        <button type="button" onClick={() => setTab('global')} style={tab === 'global' ? { ...styles.tab, ...styles.tabActive } : styles.tab}>{t('tab.global')}</button>
      </div>
      <UsagePanel data={shown} global={tab === 'global'} t={t} dark={dark} onClose={() => props.usage.close()} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    gap: 8, padding: 18, boxSizing: 'border-box', pointerEvents: 'none',
    background: 'color-mix(in srgb, var(--dsw-alias-bg-base) 36%, transparent)', zIndex: 40,
  },
  tabBar: {
    pointerEvents: 'auto', display: 'inline-flex', gap: 4, padding: 3,
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 999,
    background: 'color-mix(in srgb, var(--dsw-alias-bg-overlay) 85%, transparent)',
    backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
  },
  tab: {
    border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--dsw-alias-label-secondary)',
    fontSize: 13, fontWeight: 600, padding: '6px 14px', borderRadius: 999, font: 'inherit',
  },
  tabActive: { background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)' },
  panel: {
    pointerEvents: 'auto', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 12,
    width: 'min(960px, 96vw)', maxHeight: 'min(88vh, 100%)', overflowY: 'auto',
    padding: '18px 20px 16px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 18,
    background: 'color-mix(in srgb, var(--dsw-alias-bg-overlay) 82%, transparent)',
    backdropFilter: 'blur(24px) saturate(160%)', WebkitBackdropFilter: 'blur(24px) saturate(160%)',
    boxShadow: '0 24px 64px rgba(0,0,0,0.32)', color: 'var(--dsw-alias-label-primary)', fontSize: 13, lineHeight: 1.5,
  },
  panelMax: { width: 'calc(100vw - 24px)', maxHeight: 'calc(100vh - 24px)' },
  header: { display: 'flex', alignItems: 'center', gap: 8 },
  titleBlock: { flex: 1, display: 'flex', flexDirection: 'column', gap: 1 },
  title: { fontSize: 17, fontWeight: 650, letterSpacing: '0.01em' },
  subtitle: { fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)' },
  iconBtn: {
    flex: 'none', width: 26, height: 26, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    borderRadius: 8, border: '1px solid var(--dsw-alias-border-l1)', background: 'transparent',
    color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer', fontSize: 14, padding: 0,
  },
  closeBtn: {
    flex: 'none', width: 26, height: 26, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    borderRadius: 8, border: '1px solid var(--dsw-alias-border-l1)', background: 'transparent',
    color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: 0,
  },
  empty: { padding: '12px 2px', color: 'var(--dsw-alias-label-secondary)' },
  totalsRow: { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: '10px 12px' },
  metric: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
  metricLabel: { color: 'var(--dsw-alias-label-secondary)', fontSize: 11, whiteSpace: 'nowrap' },
  metricValue: { fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  unpriced: { color: 'var(--dsw-alias-state-warn-label)', fontSize: 11.5 },
  shareBar: { display: 'flex', height: 6, borderRadius: 999, overflow: 'hidden', background: 'var(--dsw-alias-bg-layer-1)' },
  shareSegment: { height: '100%' },
  chartCard: {
    display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 14px',
    border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 14, background: 'var(--dsw-alias-bg-layer-1)',
  },
  chartHead: { display: 'flex', alignItems: 'baseline', gap: 8 },
  chartTitle: { flex: 1, fontWeight: 650, fontSize: 13.5 },
  chartMeta: { color: 'var(--dsw-alias-label-secondary)', fontSize: 11.5, whiteSpace: 'nowrap' },
  metricToggle: { display: 'inline-flex', gap: 4 },
  metricToggleBtn: {
    border: '1px solid var(--dsw-alias-border-l1)', background: 'transparent', cursor: 'pointer',
    color: 'var(--dsw-alias-label-secondary)', fontSize: 11.5, fontWeight: 600, padding: '3px 10px', borderRadius: 999, font: 'inherit',
  },
  metricToggleActive: { background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)', borderColor: 'var(--dsw-alias-brand-primary-new-colorprimary-new-color)' },
  chartWrap: { width: '100%' },
  chartEmpty: { padding: '16px 12px', border: '1px dashed var(--dsw-alias-border-l1)', borderRadius: 12, color: 'var(--dsw-alias-label-secondary)', fontSize: 12 },
  chartHint: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 11 },
  tooltip: {
    background: 'color-mix(in srgb, var(--dsw-alias-bg-overlay) 94%, transparent)',
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.2)',
    fontSize: 12, padding: '8px 10px',
  },
  legend: { display: 'flex', flexWrap: 'wrap', gap: '4px 12px' },
  legendItem: { display: 'inline-flex', alignItems: 'center', gap: 6, border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--dsw-alias-label-secondary)', fontSize: 12, padding: 0, font: 'inherit' },
  legendDot: { width: 9, height: 9, borderRadius: 3 },
  modelsSplit: { display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-start' },
  modelsList: { flex: '1 1 300px', minWidth: 280, display: 'flex', flexDirection: 'column', gap: 8 },
  modelCard: {
    display: 'flex', flexDirection: 'column', gap: 5, padding: '10px 12px',
    border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 12, background: 'var(--dsw-alias-bg-layer-1)',
    transition: 'border-color 120ms ease, background 120ms ease',
  },
  modelCardSelected: { borderColor: 'var(--dsw-alias-brand-primary-new-colorprimary-new-color)', background: 'var(--dsw-alias-bg-layer-2)' },
  detailPane: {
    flex: '1.4 1 340px', minWidth: 300, display: 'flex', flexDirection: 'column', gap: 10,
    padding: '12px 14px', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 12,
    background: 'var(--dsw-alias-bg-layer-1)',
  },
  detailHead: { display: 'flex', alignItems: 'center', gap: 8 },
  detailName: { flex: 1, minWidth: 0, fontWeight: 650, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  badge: { fontSize: 10, fontWeight: 650, borderRadius: 999, padding: '1px 7px', flex: 'none' },
  badgePriced: { background: 'var(--dsw-alias-state-success-tertiary)', color: 'var(--dsw-alias-state-success-primary)' },
  badgeNone: { background: 'var(--dsw-alias-state-warn-tertiary)', color: 'var(--dsw-alias-state-warn-label)' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
  th: {
    textAlign: 'left', color: 'var(--dsw-alias-label-tertiary)', fontWeight: 650, fontSize: 10.5,
    textTransform: 'uppercase', letterSpacing: '0.04em', padding: '4px 6px',
    borderBottom: '1px solid var(--dsw-alias-border-l1)', whiteSpace: 'nowrap',
  },
  thNum: { textAlign: 'right' },
  td: { padding: '4px 6px', borderBottom: '1px solid var(--dsw-alias-border-l1)', color: 'var(--dsw-alias-label-secondary)' },
  tdNum: { textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--dsw-alias-label-primary)' },
  tdStrong: { fontWeight: 650, color: 'var(--dsw-alias-label-primary)' },
  modelHead: { display: 'flex', alignItems: 'center', gap: 8, border: 'none', background: 'transparent', cursor: 'pointer', padding: 0, font: 'inherit', textAlign: 'left', width: '100%', color: 'inherit' },
  swatch: { width: 10, height: 10, borderRadius: 3, flex: 'none' },
  modelName: { fontWeight: 650, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  modelProvider: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 11, flex: 'none' },
  modelCalls: { color: 'var(--dsw-alias-label-secondary)', fontSize: 11, flex: 'none' },
  modelCost: { fontWeight: 650, fontSize: 12.5, flex: 'none' },
  chevron: { color: 'var(--dsw-alias-label-tertiary)', flex: 'none', width: 12, textAlign: 'center' },
  statLine: { display: 'flex', flexWrap: 'wrap', gap: '2px 12px', color: 'var(--dsw-alias-label-secondary)', fontSize: 12 },
  hint: { color: 'var(--dsw-alias-state-idle-primary)', fontSize: 11 },
  readout: {
    display: 'inline-flex', alignItems: 'center', gap: 5, height: 24, padding: '0 8px', borderRadius: 999,
    border: '1px solid var(--dsw-alias-border-l1)', background: 'transparent', color: 'var(--dsw-alias-label-secondary)',
    cursor: 'pointer', font: 'inherit', fontSize: 11.5, whiteSpace: 'nowrap',
  },
  readoutActive: { borderColor: 'var(--dsw-alias-brand-primary-new-colorprimary-new-color)', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-2)' },
  dot: { width: 6, height: 6, borderRadius: 999, background: 'var(--dsw-alias-state-idle-primary)', flex: 'none' },
  dotLive: { background: 'var(--dsw-alias-state-success-primary)' },
  readoutValue: { fontWeight: 650, fontVariantNumeric: 'tabular-nums' },
  readoutUnit: { opacity: 0.7 },
  readoutSep: { opacity: 0.4 },
}

// ---------------------------------------------------------------------------
// Registration. The built bundle exports `{ inject, apply }`; build.mjs wraps
// it in `window.__ModuleLoader__.load`, so React's requires resolve through the
// factory-injected require (the platform module table).
// ---------------------------------------------------------------------------
export const inject = ['slots', 'locale', 'sessions']

export function apply(ctx: DshClientContext): void {
  const usage = createUsageStore()
  const translateOf = (t: unknown): Translator => (typeof t === 'function' ? t as Translator : ((key: string) => key))

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'usage-overlay: dictionaries')

  ctx.effect(() => ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'usage-overlay.readout',
    order: 30,
    locale: NS,
    inject: sessionId => ({ face: faceFor(ctx.sessions, sessionId), usage, sessions: ctx.sessions, sessionId }),
  }, (props: { face?: ObservableSnapshot<unknown>; usage: UsageStore; sessions: DshSessions; sessionId: string; t: unknown }) =>
    <UsageReadout {...props} t={translateOf(props.t)} />)), 'usage-overlay: composer readout')

  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'usage-overlay.panel',
    order: 60,
    locale: NS,
    inject: () => ({ usage, sessions: ctx.sessions }),
  }, (props: { usage: UsageStore; sessions: DshSessions; t: unknown }) =>
    <UsageOverlay {...props} t={translateOf(props.t)} />)), 'usage-overlay: frosted overlay')
}
