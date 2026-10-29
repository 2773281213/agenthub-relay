// The agenthub-relay mod's session state: what its hooks remember about the
// main conversation's requests, keep-alive forks and relay jobs.

export type RelayCompaction = { at: number; trigger: string }

export type RelayKeepAlive = {
  /** When the main thread's last model request started (epoch ms). */
  lastRequestAt: number | null
  /** When the last keep-alive fork started (epoch ms). */
  lastForkAt: number | null
  /** No fork before this time after a failed one (epoch ms). */
  retryAfter: number | null
  forks: number
  lastCacheRead: number | null
  lastCacheWrite: number | null
  /** Why keep-alive is paused for this session, or null. */
  paused: string | null
  /** The last decision the timer took, for /relay. */
  lastDecision: string | null
  /** Compactions of the main conversation this session saw. */
  compactions: RelayCompaction[]
  /** Jobs seen running while this session watched. */
  watched: string[]
  /** Watched jobs whose end already woke the session. */
  notified: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'agenthub-relay': { keepAlive: Shaped<RelayKeepAlive> }
  }
}
