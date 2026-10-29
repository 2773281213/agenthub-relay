// Tests of the agenthub-relay mod, run by `claude plugin test .` against the
// engine itself on a mocked clock. Each hook a test registers stands for the
// engine (or the relay MCP server) beneath the plugin.

import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { decide } from './register'

const MIN = 60_000
const HOUR = 60 * MIN

type Job = { id: string; status: string; integration?: string; resultFetched?: boolean; title?: string; tier?: string; executor?: string }
type Fork = { read: number; wrote: number }

/** A session with the relay stubbed; `jobs` and `forkReply` can change between steps. */
function world($: Engine, on: On, env: Record<string, string> = {}) {
  const clock = mock.clock(on, { now: 0 })
  mock.env(on, env)
  const seen = {
    jobs: [] as Job[],
    forks: 0,
    forkReply: { read: 90_000, wrote: 0 } as Fork,
    prompts: [] as string[],
    statuses: [] as (string | undefined)[],
    toasts: [] as string[],
    commands: [] as string[],
    mcpCalls: 0,
  }
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => {
    seen.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('mcp.connect', () => ({ value: { isConnected: true, server: 'plugin:agenthub-relay:relay' } }))
  on('mcp.call', (_, e) => {
    seen.mcpCalls += 1
    expect(e.tool).toBe('relay_status')
    expect(e.args).toEqual({ watch: true })
    return { value: { content: [{ type: 'text', text: JSON.stringify({ jobs: seen.jobs }) }], isError: false } }
  })
  on('model.fork', () => {
    seen.forks += 1
    const usage = { input_tokens: 20, output_tokens: 2, cache_read_input_tokens: seen.forkReply.read, cache_creation_input_tokens: seen.forkReply.wrote }
    return { value: { isAnswered: true, text: 'OK', usage } }
  })
  on('prompt.submit', (_, e) => {
    seen.prompts.push(e.text)
    return { text: e.text }
  })
  on('ui.status', (_, e) => {
    seen.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })

  const request = async (agentId?: string) => {
    const stream = $.turn.step({ turnId: 't', index: 0, model: 'opus', messageCount: 3, ...(agentId ? { agentId } : {}) })
    for await (const _chunk of stream) {
      // drain
    }
  }
  const start = () => $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const minutes = async (n: number) => {
    for (let i = 0; i < n; i++) await clock.advance(MIN)
  }
  return { clock, seen, request, start, minutes }
}

test('decide: the rules in isolation', () => {
  const base = {
    now: 56 * MIN, running: 1, busy: false, enabled: true, lastRequestAt: 0, lastForkAt: null, retryAfter: null,
    paused: null, intervalMs: 55 * MIN, ttlMs: HOUR, ceilingMs: 8 * HOUR,
  }
  expect(decide(base)).toBe('fork')
  expect(decide({ ...base, running: 0 })).toBe('no-jobs')
  expect(decide({ ...base, busy: true })).toBe('busy')
  expect(decide({ ...base, now: 30 * MIN })).toBe('not-due')
  expect(decide({ ...base, now: 61 * MIN })).toBe('cold')
  expect(decide({ ...base, lastRequestAt: null })).toBe('no-request')
  expect(decide({ ...base, now: 9 * HOUR, lastForkAt: 9 * HOUR - 56 * MIN })).toBe('ceiling')
  expect(decide({ ...base, paused: 'cold-cache' })).toBe('paused')
  expect(decide({ ...base, enabled: false })).toBe('disabled')
  expect(decide({ ...base, retryAfter: 57 * MIN })).toBe('backoff')
})

test('no fork while no job runs, however long the session idles', async ($, on) => {
  const w = world($, on)
  await w.start()
  await w.request()
  await w.minutes(130)
  expect(w.seen.forks).toBe(0)
  expect(w.seen.mcpCalls > 0).toBe(true)
  expect(w.seen.commands).toEqual(['relay'])
})

test('with a job running, one fork 55 minutes after the last request, then every 55 minutes', async ($, on) => {
  const w = world($, on)
  w.seen.jobs = [{ id: 'j1', status: 'running' }]
  await w.start()
  await w.request()
  await w.minutes(54)
  expect(w.seen.forks).toBe(0)
  await w.minutes(1)
  expect(w.seen.forks).toBe(1)
  await w.minutes(54)
  expect(w.seen.forks).toBe(1)
  await w.minutes(1)
  expect(w.seen.forks).toBe(2)
  expect(w.seen.statuses.at(-1)).toBe('relay: 1 running · cache refreshed just now')
})

test('a cache presumed cold is never forked', async ($, on) => {
  const w = world($, on)
  await w.start()
  await w.request()
  await w.minutes(61)
  w.seen.jobs = [{ id: 'j1', status: 'running' }]
  await w.minutes(120)
  expect(w.seen.forks).toBe(0)
})

test('forks stop at the ceiling counted from the last real request', async ($, on) => {
  const w = world($, on)
  w.seen.jobs = [{ id: 'j1', status: 'running' }]
  await w.start()
  await w.request()
  await w.minutes(9 * 60)
  // 55, 110, ..., 440 minutes: eight forks before the eight-hour ceiling.
  expect(w.seen.forks).toBe(8)
})

test('a fork that had to write the prefix pauses keep-alive and says how to fix it', async ($, on) => {
  const w = world($, on)
  w.seen.jobs = [{ id: 'j1', status: 'running' }]
  w.seen.forkReply = { read: 0, wrote: 80_000 }
  await w.start()
  await w.request()
  await w.minutes(56)
  expect(w.seen.forks).toBe(1)
  expect(w.seen.toasts.length).toBe(1)
  expect(w.seen.toasts[0]).toContain('CLAUDE_CODE_PROMPT_CACHE_TTL=1h')
  await w.request()
  await w.minutes(120)
  expect(w.seen.forks).toBe(1)
  expect(w.seen.statuses.at(-1)).toBe('relay: 1 running · keep-alive paused')
})

test('no fork during a turn; subagent requests do not count as the main request', async ($, on) => {
  const w = world($, on)
  w.seen.jobs = [{ id: 'j1', status: 'running' }]
  await w.start()
  await w.request()
  await $.turn.start({ text: 'long task', turnId: 't1' })
  await w.minutes(57)
  expect(w.seen.forks).toBe(0)
  await w.request('subagent-1')
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await w.minutes(1)
  // Idle 58 minutes since the main request; the subagent's did not reset it.
  expect(w.seen.forks).toBe(1)
})

test('a watched job that ends wakes the session once; one already ended at first sight does not', async ($, on) => {
  const w = world($, on)
  w.seen.jobs = [{ id: 'old', status: 'completed', integration: 'none' }, { id: 'j1', status: 'running', title: 'refactor' }]
  await w.start()
  await w.minutes(2)
  expect(w.seen.prompts.length).toBe(0)
  w.seen.jobs = [
    { id: 'old', status: 'completed', integration: 'none' },
    { id: 'j1', status: 'completed', integration: 'none', resultFetched: false, title: 'refactor', tier: 'deep', executor: 'codex' },
  ]
  await w.minutes(3)
  expect(w.seen.prompts.length).toBe(1)
  expect(w.seen.prompts[0]).toContain('j1 (codex, deep) ended completed')
  expect(w.seen.prompts[0]).not.toContain('old')
})

test('an executor process stays inactive: no command, no polling, no fork', async ($, on) => {
  const w = world($, on, { AGENTHUB_RELAY_ROLE: 'executor' })
  w.seen.jobs = [{ id: 'j1', status: 'running' }]
  await w.start()
  await w.request()
  await w.minutes(120)
  expect(w.seen.commands).toEqual([])
  expect(w.seen.mcpCalls).toBe(0)
  expect(w.seen.forks).toBe(0)
})

test('/relay reports the state and /relay off pauses keep-alive', async ($, on) => {
  const w = world($, on)
  w.seen.jobs = [{ id: 'j1', status: 'running' }]
  await w.start()
  await w.request()
  await w.minutes(2)
  const presentation = { isFullscreen: false, columns: 100 }
  const shown = await $.command.run({ command: 'relay', args: '', origin: { kind: 'composer' }, presentation })
  expect(shown.text).toContain('jobs: 1 running (j1)')
  expect(shown.text).toContain('keep-alive: on')
  const off = await $.command.run({ command: 'relay', args: 'off', origin: { kind: 'composer' }, presentation })
  expect(off.text).toContain('paused (off)')
  await w.minutes(60)
  expect(w.seen.forks).toBe(0)
})
