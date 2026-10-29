// agenthub-relay's Claude Code mod: for a Claude Code planner only.
//
// - Keep-alive: while relay jobs run and the session idles, refresh the main
//   conversation's prompt cache with $.model.fork shortly before its one-hour
//   lifetime ends. A fork re-sends the main thread's last request, so the API
//   serves (and refreshes) the cached prefix; it adds no turn to the transcript.
// - Wake: when a job this session watched ends and nobody read its result,
//   submit one prompt so Claude reviews it.
// - /relay and a status line show jobs and keep-alive state.
// Nothing runs in an executor process (AGENTHUB_RELAY_ROLE=executor).

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { RelayKeepAlive } from '../types'

const MINUTE = 60_000
/** The one-hour cache lifetime, counted from the start of a request that reads or writes it. */
export const TTL_MS = 60 * MINUTE
const LIVE = new Set(['queued', 'running', 'verifying'])
const TERMINAL = new Set(['completed', 'failed', 'cancelled'])
const KEEP = 200
const FORK_PROMPT = 'agenthub-relay keep-alive: no action is needed. Reply with the single word OK.'

export type RelayJob = {
  id: string
  title?: string
  tier?: string
  executor?: string
  status: string
  integration?: string
  verification?: string
  resultFetched?: boolean
}

export type Decision =
  | 'fork'
  | 'disabled'
  | 'paused'
  | 'no-jobs'
  | 'busy'
  | 'no-request'
  | 'ceiling'
  | 'cold'
  | 'backoff'
  | 'not-due'

export type DecideInput = {
  now: number
  running: number
  busy: boolean
  enabled: boolean
  lastRequestAt: number | null
  lastForkAt: number | null
  retryAfter: number | null
  paused: string | null
  intervalMs: number
  ttlMs: number
  ceilingMs: number
}

/**
 * Whether to refresh the cache now. A fork happens only while jobs run, the
 * session idles, the last refresh is at least `intervalMs` old but younger
 * than the TTL (the cache is presumed warm), and the last real request is
 * within the ceiling.
 */
export function decide(input: DecideInput): Decision {
  if (!input.enabled) return 'disabled'
  if (input.paused !== null) return 'paused'
  if (input.running === 0) return 'no-jobs'
  if (input.busy) return 'busy'
  if (input.lastRequestAt === null) return 'no-request'
  if (input.now - input.lastRequestAt >= input.ceilingMs) return 'ceiling'
  const idle = input.now - Math.max(input.lastRequestAt, input.lastForkAt ?? 0)
  if (idle >= input.ttlMs) return 'cold'
  if (input.retryAfter !== null && input.now < input.retryAfter) return 'backoff'
  if (idle < input.intervalMs) return 'not-due'
  return 'fork'
}

const INITIAL: RelayKeepAlive = {
  lastRequestAt: null,
  lastForkAt: null,
  retryAfter: null,
  forks: 0,
  lastCacheRead: null,
  lastCacheWrite: null,
  paused: null,
  lastDecision: null,
  compactions: [],
  watched: [],
  notified: [],
}

// Change the tag when the fields change: an older stored value is then read as INITIAL.
const keepAlive = atom({ plugin: 'agenthub-relay', key: 'keepAlive' } as const, INITIAL, { shape: 'keep-alive-1' })

function bounded(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
}

function ago(now: number, at: number | null): string {
  if (at === null) return 'never'
  const minutes = Math.round((now - at) / MINUTE)
  return minutes < 1 ? 'just now' : `${minutes} min ago`
}

function unique(list: readonly string[]): string[] {
  return [...new Set(list)].slice(-KEEP)
}

function wakeText(jobs: RelayJob[]): string {
  const lines = jobs.map(job => {
    const checks = job.verification ? `, checks ${job.verification}` : ''
    return `- ${job.id} (${job.executor ?? '?'}, ${job.tier ?? '?'}) ended ${job.status}${checks}: ${job.title ?? ''}`
  })
  return [
    `agenthub-relay: ${jobs.length === 1 ? 'a job you dispatched has' : `${jobs.length} jobs you dispatched have`} ended.`,
    ...lines,
    'Read each with relay_result, then relay_apply or relay_discard.',
  ].join('\n')
}

/** What the hooks share for one load of the module. */
type Runtime = {
  enabled: boolean
  wakeOnFinish: boolean
  intervalMs: number
  ceilingMs: number
  inactive: boolean
  busy: boolean
  forking: boolean
  ticking: boolean
  server: string | undefined
  lastJobs: RelayJob[]
}

async function pollJobs($: EngineInterface, rt: Runtime): Promise<RelayJob[] | undefined> {
  if (rt.server === undefined) {
    const connected = await $.mcp.connect('relay')
    if (!connected.isConnected) return undefined
    rt.server = connected.server
  }
  const result = await $.mcp.call(rt.server, 'relay_status', { watch: true })
  if (result.isError) return undefined
  const text = result.content.find(block => block.type === 'text')?.text
  if (text === undefined) return undefined
  const parsed: unknown = JSON.parse(text)
  const jobs = (parsed as { jobs?: unknown }).jobs
  return Array.isArray(jobs) ? (jobs as RelayJob[]) : undefined
}

async function forkNow($: EngineInterface, rt: Runtime, at: number): Promise<void> {
  rt.forking = true
  try {
    const reply = await $.model.fork({ prompt: FORK_PROMPT })
    if (reply.isAnswered) {
      const readTokens = reply.usage.cache_read_input_tokens
      const wroteTokens = reply.usage.cache_creation_input_tokens
      // A warm prefix is read, not written; writing more than was read means
      // the entry had lapsed, which a one-hour TTL would not have allowed.
      const cold = wroteTokens > readTokens
      await update($, keepAlive, s => ({
        ...s,
        lastForkAt: at,
        retryAfter: null,
        forks: s.forks + 1,
        lastCacheRead: readTokens,
        lastCacheWrite: wroteTokens,
        paused: cold ? 'cold-cache' : s.paused,
        lastDecision: cold ? 'forked-cold' : 'forked',
      }))
      if (cold) {
        $.ui.toast(
          'agenthub-relay: the keep-alive found the prompt cache already expired, so this session is not on the one-hour cache TTL. Keep-alive is paused; set CLAUDE_CODE_PROMPT_CACHE_TTL=1h (or promptCacheTtl) and run /relay on.',
        )
      }
      return
    }
    const reason = reply.reason === 'api-error' ? `api-error ${reply.status ?? ''}`.trim() : reply.reason
    await update($, keepAlive, s => ({
      ...s,
      retryAfter: reply.reason === 'nothing-to-fork' ? s.retryAfter : at + 5 * MINUTE,
      lastDecision: `fork-${reason}`,
    }))
  } finally {
    rt.forking = false
  }
}

function showStatus($: EngineInterface, rt: Runtime, state: RelayKeepAlive, now: number): void {
  const running = rt.lastJobs.filter(job => LIVE.has(job.status)).length
  const waiting = rt.lastJobs.filter(job => TERMINAL.has(job.status) && job.integration === 'none' && !job.resultFetched).length
  const parts: string[] = []
  if (running > 0) parts.push(`${running} running`)
  if (waiting > 0) parts.push(`${waiting} to review`)
  if (running > 0 && rt.enabled) {
    if (state.paused !== null) parts.push('keep-alive paused')
    else if (state.lastForkAt !== null) parts.push(`cache refreshed ${ago(now, state.lastForkAt)}`)
  }
  $.ui.status(parts.length > 0 ? `relay: ${parts.join(' · ')}` : undefined)
}

async function tick($: EngineInterface, rt: Runtime): Promise<void> {
  if (rt.inactive || rt.ticking) return
  rt.ticking = true
  try {
    const now = await $.clock.now()
    const jobs = await pollJobs($, rt)
    let state = await read($, keepAlive)
    if (jobs !== undefined) {
      rt.lastJobs = jobs
      const live = jobs.filter(job => LIVE.has(job.status)).map(job => job.id)
      const ended = jobs.filter(
        job =>
          TERMINAL.has(job.status) &&
          state.watched.includes(job.id) &&
          !state.notified.includes(job.id) &&
          job.integration === 'none' &&
          job.resultFetched !== true,
      )
      if (live.some(id => !state.watched.includes(id))) {
        state = await update($, keepAlive, s => ({ ...s, watched: unique([...s.watched, ...live]) }))
      }
      if (ended.length > 0 && rt.wakeOnFinish && !rt.busy) {
        state = await update($, keepAlive, s => ({ ...s, notified: unique([...s.notified, ...ended.map(job => job.id)]) }))
        await $.prompt.submit({ text: wakeText(ended) })
      }
    }
    const decision = decide({
      now,
      running: (jobs ?? []).filter(job => LIVE.has(job.status)).length,
      busy: rt.busy,
      enabled: rt.enabled,
      lastRequestAt: state.lastRequestAt,
      lastForkAt: state.lastForkAt,
      retryAfter: state.retryAfter,
      paused: state.paused,
      intervalMs: rt.intervalMs,
      ttlMs: TTL_MS,
      ceilingMs: rt.ceilingMs,
    })
    if (decision === 'fork') await forkNow($, rt, now)
    else if (decision !== state.lastDecision) await update($, keepAlive, s => ({ ...s, lastDecision: decision }))
    showStatus($, rt, await read($, keepAlive), now)
  } finally {
    rt.ticking = false
  }
}

async function summary($: EngineInterface, rt: Runtime, arg: string): Promise<string> {
  if (rt.inactive) return 'agenthub-relay: inactive, this process is an agenthub-relay executor'
  if (arg === 'off') await update($, keepAlive, s => ({ ...s, paused: 'off' }))
  if (arg === 'on') await update($, keepAlive, s => ({ ...s, paused: null, retryAfter: null }))
  const now = await $.clock.now()
  const state = await read($, keepAlive)
  const running = rt.lastJobs.filter(job => LIVE.has(job.status))
  const waiting = rt.lastJobs.filter(job => TERMINAL.has(job.status) && job.integration === 'none')
  const last = state.compactions.at(-1)
  return [
    'agenthub-relay',
    `jobs: ${running.length} running${running.length ? ` (${running.map(job => job.id).join(', ')})` : ''}, ${waiting.length} finished and not applied or discarded`,
    `keep-alive: ${!rt.enabled ? 'off in settings' : state.paused === null ? 'on' : `paused (${state.paused})`}; every ${rt.intervalMs / MINUTE} min while jobs run, for up to ${rt.ceilingMs / (60 * MINUTE)} h after your last request`,
    `last request: ${ago(now, state.lastRequestAt)} · last refresh: ${ago(now, state.lastForkAt)} · refreshes: ${state.forks}`,
    `last refresh read ${state.lastCacheRead ?? '-'} cached tokens and wrote ${state.lastCacheWrite ?? '-'}`,
    `compactions seen: ${state.compactions.length}${last ? ` (last: ${last.trigger}, ${ago(now, last.at)})` : ''}`,
    `last decision: ${state.lastDecision ?? '-'}`,
  ].join('\n')
}

export const register: Register = (on, options) => {
  const rt: Runtime = {
    enabled: options.keep_alive !== false,
    wakeOnFinish: options.wake_on_finish !== false,
    intervalMs: bounded(options.interval_minutes, 55, 1, 59) * MINUTE,
    ceilingMs: bounded(options.ceiling_hours, 8, 1, 48) * 60 * MINUTE,
    inactive: true, // until session.start has checked the role
    busy: false,
    forking: false,
    ticking: false,
    server: undefined,
    lastJobs: [],
  }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    if ((await $.env.get('AGENTHUB_RELAY_ROLE')) === 'executor') return started
    rt.inactive = false
    await $.command.register({
      name: 'relay',
      description: 'agenthub-relay jobs and prompt-cache keep-alive',
      argumentHint: '[on|off]',
    })
    $.clock.every(MINUTE, () => {
      tick($, rt).catch(() => {})
    })
    return started
  })

  on('turn.start', async ($, e, next) => {
    if (!rt.inactive && !rt.forking && e.agentId === undefined) rt.busy = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (!rt.inactive && !rt.forking && e.agentId === undefined) rt.busy = false
    return done
  })

  // Every model request of the main loop: its start is when the cache's
  // lifetime restarts. Subagents use their own, shorter-lived cache.
  on('turn.step', async function* ($, e, next) {
    if (!rt.inactive && !rt.forking && e.agentId === undefined) {
      const at = await $.clock.now()
      await update($, keepAlive, s => ({ ...s, lastRequestAt: at, retryAfter: null }))
    }
    return yield* next(e)
  })

  // Compaction rebuilds the cached prefix; record it so a lost cache can be
  // told apart from a keep-alive that did not run. Observed, never vetoed.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (!rt.inactive && e.agentId === undefined) {
      const at = await $.clock.now()
      await update($, keepAlive, s => ({ ...s, compactions: [...s.compactions, { at, trigger: e.trigger }].slice(-20) }))
    }
    return result
  }).catch(($, e, next) => next(e)) // replays what the compaction settled to; never runs it twice

  on('command.run', { command: 'relay' }, async ($, e) => ({ text: await summary($, rt, e.args.trim()) }))
}
