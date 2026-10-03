/**
 * Ambient declarations for the DeepSeek Harness client runtime contracts the
 * `@local/usage-overlay` client consumes.
 *
 * A linked bundle cannot resolve `@deepseek-ai/*` (the profile's node_modules
 * holds no harness packages), so the runtime shape is declared here by hand.
 * These are structural contracts only — nothing here has a runtime value — and
 * they mirror the surfaces actually exercised in `client.ts`.
 */

/** The loader facade the web shell installs at boot. */
interface DshModuleLoader {
  load(entry: {
    id: string
    factory(require: (specifier: string) => unknown): { inject: string[]; apply(ctx: DshClientContext): void }
  }): void
}

interface Window {
  __ModuleLoader__: DshModuleLoader
}

/** One provider-reported usage bucket — the projection's per-route row. */
interface UsageBucket {
  provider: string
  model: string
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  genMs: number
  ttftMs: number
}

/** A USD-per-million-token rate row. */
interface PriceRow {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** One estimated-cost breakdown in USD. */
interface CostRow {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
}

/** One per-route wire row: a bucket plus its view-computed estimate. */
interface ModelRow extends UsageBucket {
  key: string
  cost: CostRow
  priceSource: 'exact' | 'family' | 'none'
  price: PriceRow | null
}

/** One chart point: a settled message's contribution at settlement time. */
interface SeriesPoint {
  turn: number
  step: number
  index: number
  t: number
  key: string
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  latencyMs: number
}

/** The Client-visible wire value of the `modelUsageByRoute` projection. */
interface UsageView {
  totals: UsageBucket
  cost: CostRow
  unpriced: number
  models: ModelRow[]
  series: SeriesPoint[]
}

/** An observable snapshot face (the HostObservable contract). */
interface ObservableSnapshot<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

/** The per-session projections face. */
interface ProjectionsFace {
  faceOf(key: string): ObservableSnapshot<unknown>
}

/** A live session binding, the `binding(sessionId)` result. */
interface SessionBinding {
  sessionId: string
  session: {
    projections: ProjectionsFace
  }
}

/** Per-session projection baseline carried in the session list snapshot. */
interface SessionProjectionEntry {
  values: Record<string, unknown>
  state: 'idle' | 'loading' | 'ready' | 'error'
}

/** The `sessions.list` snapshot: metadata plus a per-session projection baseline. */
interface SessionListSnapshot {
  byId: Record<string, unknown>
  ids?: string[]
  phase: string
  state?: string
  projectionsBySession: Record<string, SessionProjectionEntry>
}

/** The `sessions` service face the client injects. */
interface DshSessions {
  list: ObservableSnapshot<SessionListSnapshot>
  binding(sessionId: string): SessionBinding | undefined
}

/** The `locale` service face the client injects. */
interface DshLocale {
  register(namespace: string, dictionaries: Record<string, Record<string, string>>): void
}

/** The `slots` service face the client injects. */
interface DshSlots {
  inject(slot: string, register: (ctx: unknown) => () => void): void
  register(
    meta: {
      name: string
      id?: string
      order?: number
      locale?: string
      key?: string
      inject?: (sessionId: string) => Record<string, unknown>
    },
    component: unknown,
  ): void
}

/** The client root context the `apply(ctx)` receives. */
interface DshClientContext {
  sessions: DshSessions
  locale: DshLocale
  slots: DshSlots
  effect(run: () => void | (() => void), label?: string): void
}

/** Translation function with `{name}` interpolation. */
type Translator = (key: string, params?: Record<string, string | number>) => string
