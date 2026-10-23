export type Tier = 'haiku' | 'sonnet' | 'opus' | 'fable'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type Choice<T extends string> = {
  value: T
  confidence: number
  isFallback: boolean
  /** Jev's own top pick, before any step-up, guard or named override. */
  jev: { value: T; confidence: number }
}

export type Recommendation = {
  model: Choice<Tier>
  effort: Choice<Effort>
  reasons: string[]
  /** Set when the draft names a model itself; the router then defers to it. */
  namedModel?: Tier
}

export type RouteStatus =
  | { kind: 'idle' }
  | { kind: 'routing' }
  | {
      kind: 'ready'
      rec: Recommendation
      draft: string
      /** Set when the draft was a new session's first message, already sent: the model it is running on. */
      sentOn?: string
    }
  | { kind: 'error'; message: string }

declare module 'claude-code' {
  interface PluginState {
    'jev-router': { status: RouteStatus }
  }
}
