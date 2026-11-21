// agenthub-relay's Claude Code mod: for a Claude Code planner only.
//
// - Keep-alive: while relay jobs run and the session idles, refresh the main
//   conversation's prompt cache with $.model.fork shortly before its one-hour
//   lifetime ends. A fork re-sends the main thread's last request, so the API
//   serves (and refreshes) the cached prefix; it adds no turn to the transcript.
// - Wake: when a job this session watched ends and nobody read its result,
//   submit one prompt so Claude reviews it.
// - /relay and a status line show jobs and keep-alive state; /relay jobs opens
//   a pane of the jobs waiting on you, with Open (take the job over in its
//   executor's own app), Review and Hand back.
// - In-app invocation: typing # offers the relay's executors (#codex, #claude,
//   #dsh, #agy), and a prompt that mentions one gets a note, which only the
//   model reads, to hand the request to that executor through the relay.
// Nothing runs in an executor process (AGENTHUB_RELAY_ROLE=executor).

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { RelayKeepAlive, RelayPaneJob } from '../types'

/** The executors a prompt can mention with #. */
export const MENTIONABLE = ['codex', 'claude', 'dsh', 'agy'] as const
const PANE = 'relay-jobs'

export type RelayExecutor = { id: string; label?: string; available?: boolean; tiers?: string[]; model?: string; agentDefault?: { model?: string } }

/** The executors a prompt mentions as #id, outside code spans and fences, in order, once each. */
export function mentionsIn(text: string): string[] {
  const prose = text.replace(/```[\s\S]*?(```|$)/g, ' ').replace(/`[^`\n]*`/g, ' ')
  const found: string[] = []
  for (const match of prose.matchAll(/(?:^|[\s(（，,。.;；:：!！?？])#([a-z]+)(?![\w-])/gi)) {
    const id = match[1].toLowerCase()
    if ((MENTIONABLE as readonly string[]).includes(id) && !found.includes(id)) found.push(id)
  }
  return found
}

/** What the model reads beside a prompt that mentions executors (the user never sees it). */
export function mentionContext(ids: string[], mentionReuse: boolean): string {
  const named = ids.map(id => `#${id} (the relay's ${id} executor)`).join(', ')
  const session = mentionReuse
    ? 'If relay_session shows no confirmed planner session, the mention itself means keeping the saved roles: start one and confirm it with reuse: true, and tell the user you did.'
    : 'If relay_session shows no confirmed planner session, start one and ask the user in one line whether to keep the saved roles before confirming.'
  return [
    `[agenthub-relay] The user mentioned ${named}.`,
    `Hand this request to ${ids.length > 1 ? 'each mentioned executor' : 'that executor'} through agenthub-relay instead of doing it yourself:`,
    `write a self-contained task and call relay_dispatch with executor ${ids.map(id => `"${id}"`).join(' / ')}${ids.length > 1 ? ', one job per executor' : ''}, then end your turn or wait as the result says.`,
    session,
  ].join(' ')
}

/** The typeahead rows for a token starting with #: the relay's executors that match it. */
export function mentionRows(token: string, executors: RelayExecutor[]): { text: string; label: string; description: string }[] {
  const typed = token.slice(1).toLowerCase()
  const known = new Map(executors.map(entry => [entry.id, entry]))
  return MENTIONABLE.filter(id => id.startsWith(typed)).map(id => {
    const entry = known.get(id)
    const model = entry?.model ?? entry?.agentDefault?.model
    const parts = [entry?.label ?? id, entry?.tiers?.length ? `tiers ${entry.tiers.join('/')}` : null, model ?? null, entry && entry.available === false ? 'not installed' : null]
    return { text: `#${id}`, label: `#${id}`, description: `agenthub-relay: ${parts.filter(Boolean).join(' · ')}` }
  })
}

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
  /** The job's latest turn (relay_send and relay_collect add turns); 1 when absent. */
  turn?: number
  takenOver?: boolean
  resumable?: boolean
  model?: string
}

/** One turn of one job: a follow-up turn wakes the session again. */
export function turnKey(job: RelayJob): string {
  return `${job.id}#${job.turn ?? 1}`
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
const keepAlive = atom({ plugin: 'agenthub-relay', key: 'keepAlive' } as const, INITIAL, { shape: 'keep-alive-2' })
/** The jobs the pane draws, refreshed by the minute tick. */
const paneJobs = atom({ plugin: 'agenthub-relay', key: 'jobs' } as const, [] as RelayPaneJob[], { shape: 'jobs-1' })

function paneJob(job: RelayJob): RelayPaneJob {
  return {
    id: job.id,
    title: job.title ?? job.id,
    tier: job.tier ?? '?',
    executor: job.executor ?? '?',
    model: job.model ?? null,
    status: job.status,
    integration: job.integration ?? 'none',
    verification: job.verification ?? null,
    turn: job.turn ?? 1,
    takenOver: job.takenOver === true,
    resumable: job.resumable === true,
  }
}

function jobState(job: RelayPaneJob): string {
  const turn = job.turn > 1 ? `, turn ${job.turn}` : ''
  if (job.takenOver) return `taken over${turn}`
  if (LIVE.has(job.status)) return `${job.status}${turn}`
  return `${job.status}${job.verification ? `/${job.verification}` : ''}${turn}`
}

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

export function wakeText(jobs: RelayJob[]): string {
  const lines = jobs.map(job => {
    const checks = job.verification ? `, checks ${job.verification}` : ''
    const turn = (job.turn ?? 1) > 1 ? ` (turn ${job.turn})` : ''
    return `- ${job.id} (${job.executor ?? '?'}, ${job.tier ?? '?'}) ended ${job.status}${checks}${turn}: ${job.title ?? ''}`
  })
  return [
    `[agenthub-relay] ${jobs.length === 1 ? 'A job you dispatched has' : `${jobs.length} jobs you dispatched have`} ended. Read each job's result, then continue your task:`,
    ...lines,
    'Read each with relay_result. Then relay_apply it, relay_send its session what to change, or relay_discard it.',
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
  executors: RelayExecutor[]
  mentionReuse: boolean
  agentsAt: number | null
}

async function connect($: EngineInterface, rt: Runtime): Promise<string | undefined> {
  if (rt.server === undefined) {
    const connected = await $.mcp.connect('relay')
    if (!connected.isConnected) return undefined
    rt.server = connected.server
  }
  return rt.server
}

type Called = { ok: true; value: Record<string, unknown> } | { ok: false; message: string }

/** One relay_* tool call: its JSON result, or the relay's error message. */
async function callRelay($: EngineInterface, rt: Runtime, tool: string, args: Record<string, unknown>): Promise<Called> {
  const server = await connect($, rt)
  if (server === undefined) return { ok: false, message: 'the agenthub-relay MCP server is not connected' }
  const result = await $.mcp.call(server, tool, args)
  const text = result.content.find(block => block.type === 'text')?.text
  let value: Record<string, unknown> = {}
  try {
    value = text === undefined ? {} : (JSON.parse(text) as Record<string, unknown>)
  } catch {
    value = {}
  }
  if (result.isError) {
    const error = value.error as { message?: string } | undefined
    return { ok: false, message: error?.message ?? text ?? 'the relay refused' }
  }
  return { ok: true, value }
}

async function pollJobs($: EngineInterface, rt: Runtime): Promise<RelayJob[] | undefined> {
  const called = await callRelay($, rt, 'relay_status', { watch: true })
  if (!called.ok) return undefined
  const jobs = called.value.jobs
  return Array.isArray(jobs) ? (jobs as RelayJob[]) : undefined
}

/** The executors and the mention setting, for the # typeahead and the mention note. */
async function refreshAgents($: EngineInterface, rt: Runtime, now: number): Promise<void> {
  if (rt.agentsAt !== null && now - rt.agentsAt < 10 * MINUTE) return
  rt.agentsAt = now
  const called = await callRelay($, rt, 'relay_agents', {})
  if (!called.ok) return
  if (Array.isArray(called.value.executors)) rt.executors = called.value.executors as RelayExecutor[]
  rt.mentionReuse = called.value.mentionReuse === true
}

/** The pane's Open: take the job over and open it in its executor's own app; the terminal command goes to the clipboard. */
async function openJob($: EngineInterface, rt: Runtime, job: RelayPaneJob, surface: unknown): Promise<void> {
  const called = await callRelay($, rt, 'relay_takeover', { jobId: job.id, open: true, ...(LIVE.has(job.status) ? { stop: true } : {}) })
  if (!called.ok) {
    $.ui.toast(`agenthub-relay: ${job.id} was not opened: ${called.message}`)
    return
  }
  const app = called.value.app as { label?: string } | undefined
  const terminal = called.value.terminal as { command?: string; cwd?: string } | undefined
  const opened = called.value.opened as { ok?: boolean; error?: string } | undefined
  if (terminal?.command) await $.ui.copy({ text: terminal.command, ...(surface ? { surface } : {}) } as Parameters<typeof $.ui.copy>[0])
  const where = opened?.ok ? `opened in the ${app?.label ?? 'app'}` : `run it in a terminal in ${terminal?.cwd ?? 'its worktree'}`
  $.ui.toast(`agenthub-relay: ${job.id} is yours now (${where}; the terminal command is on the clipboard). Hand it back from the jobs pane when you are done.`)
  await refreshPane($, rt)
}

async function handBack($: EngineInterface, rt: Runtime, job: RelayPaneJob): Promise<void> {
  const called = await callRelay($, rt, 'relay_collect', { jobId: job.id })
  $.ui.toast(called.ok ? `agenthub-relay: ${job.id} is handed back; its checks are running.` : `agenthub-relay: ${job.id} was not handed back: ${called.message}`)
  await refreshPane($, rt)
}

async function refreshPane($: EngineInterface, rt: Runtime): Promise<void> {
  const jobs = await pollJobs($, rt)
  if (jobs === undefined) return
  rt.lastJobs = jobs
  await setPaneJobs($, jobs)
}

async function setPaneJobs($: EngineInterface, jobs: RelayJob[]): Promise<void> {
  const next = jobs.filter(job => (job.integration ?? 'none') === 'none').map(paneJob)
  const current = await read($, paneJobs)
  if (JSON.stringify(current) !== JSON.stringify(next)) await update($, paneJobs, () => next)
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
  const waiting = rt.lastJobs.filter(job => TERMINAL.has(job.status) && job.integration === 'none' && !job.resultFetched && !job.takenOver).length
  const taken = rt.lastJobs.filter(job => job.takenOver && job.integration === 'none').length
  const parts: string[] = []
  if (running > 0) parts.push(`${running} running`)
  if (waiting > 0) parts.push(`${waiting} to review`)
  if (taken > 0) parts.push(`${taken} taken over`)
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
    await refreshAgents($, rt, now)
    if (jobs !== undefined) {
      rt.lastJobs = jobs
      await setPaneJobs($, jobs)
      const live = jobs.filter(job => LIVE.has(job.status)).map(turnKey)
      const ended = jobs.filter(
        job =>
          TERMINAL.has(job.status) &&
          state.watched.includes(turnKey(job)) &&
          !state.notified.includes(turnKey(job)) &&
          job.integration === 'none' &&
          job.takenOver !== true &&
          job.resultFetched !== true,
      )
      if (live.some(id => !state.watched.includes(id))) {
        state = await update($, keepAlive, s => ({ ...s, watched: unique([...s.watched, ...live]) }))
      }
      if (ended.length > 0 && rt.wakeOnFinish && !rt.busy) {
        state = await update($, keepAlive, s => ({ ...s, notified: unique([...s.notified, ...ended.map(turnKey)]) }))
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
    executors: [],
    mentionReuse: false,
    agentsAt: null,
  }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    if ((await $.env.get('AGENTHUB_RELAY_ROLE')) === 'executor') return started
    rt.inactive = false
    await $.command.register({
      name: 'relay',
      description: 'agenthub-relay jobs and prompt-cache keep-alive; /relay jobs opens the jobs pane',
      argumentHint: '[jobs|on|off]',
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

  on('command.run', { command: 'relay' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'jobs' && !rt.inactive) {
      await refreshPane($, rt)
      await $.ui.open({ id: PANE, title: 'Relay jobs' })
      return { text: 'agenthub-relay: the jobs pane is open.' }
    }
    return { text: await summary($, rt, arg) }
  })

  // In-app invocation, as in codex-host: # offers the relay's executors...
  on('prompt.autocomplete', { token: /^#/ }, async ($, e, next) => {
    const engine = await next(e)
    if (rt.inactive) return engine
    return { suggestions: [...engine.suggestions, ...mentionRows(e.token, rt.executors)] }
  })

  // ...and a prompt that mentions one tells the model to hand it over. The
  // text stays as typed; the note is context only the model reads.
  on('prompt.submit', async ($, e, next) => {
    if (rt.inactive || e.command !== undefined || e.isMeta) return next(e)
    const ids = mentionsIn(e.text)
    if (ids.length === 0) return next(e)
    return next({ ...e, context: [...(e.context ?? []), mentionContext(ids, rt.mentionReuse)] })
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const jobs = await read($, paneJobs)
    if (e.props.placement === 'widget') {
      const live = jobs.filter(job => LIVE.has(job.status)).length
      return <Text>{`relay: ${live} running, ${jobs.length - live} waiting`}</Text>
    }
    if (jobs.length === 0) return <Text dimColor>No relay jobs are waiting on you.</Text>
    return (
      <Box flexDirection="column">
        {jobs.map(job => (
          <Box key={job.id} flexDirection="column" marginBottom={1}>
            <Text>{job.title}</Text>
            <Text dimColor>{`${job.id} · ${job.tier} → ${job.executor}${job.model ? `:${job.model}` : ''} · ${jobState(job)}`}</Text>
            <Box flexDirection="row">
              {job.resumable && !job.takenOver && (
                <Button key={`open-${job.id}`} onPress={() => openJob($, rt, job, e.surface)}>
                  {LIVE.has(job.status) ? 'Stop and open' : 'Open'}
                </Button>
              )}
              {job.takenOver ? (
                <Button key={`back-${job.id}`} onPress={() => handBack($, rt, job)}>Hand back</Button>
              ) : (
                !LIVE.has(job.status) && (
                  <Button key={`review-${job.id}`} onPress={() => $.prompt.submit({ text: `Review relay job ${job.id} with relay_result, then apply it, send its session what to change with relay_send, or discard it.` })}>
                    Review
                  </Button>
                )
              )}
            </Box>
          </Box>
        ))}
      </Box>
    )
  })
}
