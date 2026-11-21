// Tests of the agenthub-relay mod, run by `claude plugin test .` against the
// engine itself on a mocked clock. Each hook a test registers stands for the
// engine (or the relay MCP server) beneath the plugin.

import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { decide, mentionContext, mentionRows, mentionsIn } from './register'

const MIN = 60_000
const HOUR = 60 * MIN

type Job = { id: string; status: string; integration?: string; resultFetched?: boolean; title?: string; tier?: string; executor?: string; turn?: number; takenOver?: boolean; resumable?: boolean }
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
    contexts: [] as string[][],
    statuses: [] as (string | undefined)[],
    toasts: [] as string[],
    commands: [] as string[],
    mcpCalls: 0,
    tools: [] as string[],
    executors: [
      { id: 'codex', label: 'Codex CLI', available: true, tiers: ['deep'], agentDefault: { model: 'gpt-6-astra' } },
      { id: 'claude', label: 'Claude Code', available: true, tiers: ['review'] },
      { id: 'dsh', label: 'DeepSeek Harness', available: false, tiers: ['light'] },
      { id: 'agy', label: 'Antigravity CLI', available: true, tiers: [] },
    ],
    mentionReuse: false,
    takeoverReply: {} as unknown,
    copied: [] as string[],
    opened: [] as string[],
  }
  on('ui.copy', (_, e) => {
    seen.copied.push(e.text)
    return { value: { isCopied: true } }
  })
  on('ui.open', (_, e) => {
    seen.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => {
    seen.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('mcp.connect', () => ({ value: { isConnected: true, server: 'plugin:agenthub-relay:relay' } }))
  on('mcp.call', (_, e) => {
    seen.mcpCalls += 1
    seen.tools.push(e.tool)
    const reply = (body: unknown, isError = false) => ({ value: { content: [{ type: 'text', text: JSON.stringify(body) }], isError } })
    if (e.tool === 'relay_agents') return reply({ executors: seen.executors, mentionReuse: seen.mentionReuse })
    if (e.tool === 'relay_takeover') return reply(seen.takeoverReply)
    if (e.tool === 'relay_collect') return reply({ jobId: (e.args as { jobId: string }).jobId, turn: 2, status: 'queued' })
    expect(e.tool).toBe('relay_status')
    expect(e.args).toEqual({ watch: true })
    return reply({ jobs: seen.jobs })
  })
  on('model.fork', () => {
    seen.forks += 1
    const usage = { input_tokens: 20, output_tokens: 2, cache_read_input_tokens: seen.forkReply.read, cache_creation_input_tokens: seen.forkReply.wrote }
    return { value: { isAnswered: true, text: 'OK', usage } }
  })
  on('prompt.submit', (_, e) => {
    seen.prompts.push(e.text)
    seen.contexts.push([...(e.context ?? [])])
    return { text: e.text, ...(e.context ? { context: e.context } : {}) }
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

test('a follow-up turn of the same job wakes the session again; a taken-over job does not', async ($, on) => {
  const w = world($, on)
  w.seen.jobs = [{ id: 'j1', status: 'running', turn: 1 } as Job, { id: 'j2', status: 'running', turn: 1 } as Job]
  await w.start()
  await w.minutes(2)
  w.seen.jobs = [
    { id: 'j1', status: 'completed', integration: 'none', resultFetched: false, executor: 'codex', tier: 'deep', turn: 1 } as Job,
    { id: 'j2', status: 'failed', integration: 'none', resultFetched: false, turn: 1, takenOver: true } as Job,
  ]
  await w.minutes(2)
  expect(w.seen.prompts.length).toBe(1)
  expect(w.seen.prompts[0]).toContain('Read each job\'s result, then continue your task')
  expect(w.seen.prompts[0]).not.toContain('j2')
  // relay_send: the same job runs a second turn, then ends again.
  w.seen.jobs = [{ id: 'j1', status: 'running', integration: 'none', turn: 2 } as Job]
  await w.minutes(2)
  w.seen.jobs = [{ id: 'j1', status: 'completed', integration: 'none', resultFetched: false, executor: 'codex', tier: 'deep', turn: 2 } as Job]
  await w.minutes(2)
  expect(w.seen.prompts.length).toBe(2)
  expect(w.seen.prompts[1]).toContain('j1 (codex, deep) ended completed (turn 2)')
})

test('mentions: #executor in prose, not in code; the note asks for a dispatch and how to confirm a session', () => {
  expect(mentionsIn('#codex fix the flaky test')).toEqual(['codex'])
  expect(mentionsIn('让 #dsh 改一下，再让 #codex 审，#dsh 不要动 README')).toEqual(['dsh', 'codex'])
  expect(mentionsIn('see `#codex` and ```\n#agy\n``` and issue #123 and a#claude')).toEqual([])
  expect(mentionsIn('#codexy and #CLAUDE')).toEqual(['claude'])
  const ask = mentionContext(['codex'], false)
  expect(ask).toContain('relay_dispatch with executor "codex"')
  expect(ask).toContain('ask the user in one line')
  expect(mentionContext(['codex', 'agy'], true)).toContain('confirm it with reuse: true')
  const rows = mentionRows('#c', [{ id: 'codex', label: 'Codex CLI', available: true, tiers: ['deep'], agentDefault: { model: 'gpt-6-astra' } }])
  expect(rows.map(row => row.text)).toEqual(['#codex', '#claude'])
  expect(rows[0].description).toBe('agenthub-relay: Codex CLI · tiers deep · gpt-6-astra')
})

test('typing # offers the executors; a prompt that mentions one carries a note only the model reads', async ($, on) => {
  const w = world($, on)
  on('prompt.autocomplete', () => ({ suggestions: [{ text: '#123' }] }))
  await w.start()
  await w.minutes(1)
  const offered = await $.prompt.autocomplete({ text: 'please #d', cursor: 9, token: '#d', start: 7 })
  expect(offered.suggestions.map(row => row.text)).toEqual(['#123', '#dsh'])
  expect(offered.suggestions[1].description).toContain('not installed')

  await $.prompt.submit({ text: '#codex fix the flaky test', wait: false })
  expect(w.seen.prompts.at(-1)).toBe('#codex fix the flaky test')
  expect(w.seen.contexts.at(-1)?.[0]).toContain('[agenthub-relay] The user mentioned #codex')
  await $.prompt.submit({ text: 'no mention here', wait: false })
  expect(w.seen.contexts.at(-1)).toEqual([])
  w.seen.mentionReuse = true
  await w.minutes(11)
  await $.prompt.submit({ text: 'ask #agy', wait: false })
  expect(w.seen.contexts.at(-1)?.[0]).toContain('reuse: true')
})

test('/relay jobs opens a pane whose Open takes the job over in its app and copies the terminal command', async ($, on) => {
  const w = world($, on)
  w.seen.jobs = [
    { id: 'j1', status: 'completed', integration: 'none', title: 'refactor', tier: 'deep', executor: 'claude', turn: 1, resumable: true } as Job,
    { id: 'j2', status: 'failed', integration: 'none', title: 'by hand', tier: 'deep', executor: 'codex', turn: 1, resumable: true, takenOver: true } as Job,
    { id: 'j3', status: 'completed', integration: 'applied', title: 'done', executor: 'dsh' } as Job,
  ]
  w.seen.takeoverReply = { jobId: 'j1', app: { label: 'Claude desktop app' }, terminal: { command: 'claude --resume u-1', cwd: '/w' }, opened: { ok: true } }
  await w.start()
  const presentation = { isFullscreen: false, columns: 100 }
  const shown = await $.command.run({ command: 'relay', args: 'jobs', origin: { kind: 'composer' }, presentation })
  expect(shown.text).toContain('jobs pane is open')
  expect(w.seen.opened).toEqual(['relay-jobs'])
  const ui = await $.ui.mount({
    plugin: 'agenthub-relay',
    component: 'Pane',
    requestId: 'relay-jobs',
    surface: 'desktop',
    props: { title: 'Relay jobs', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  })
  expect((await ui.find({ type: 'Text', text: /refactor/ }))?.text).toBe('refactor')
  expect(await ui.find({ type: 'Text', text: /done/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /j2 .*taken over/ }))?.text).toContain('codex')
  await ui.press({ key: 'open-j1' })
  expect(w.seen.tools).toContain('relay_takeover')
  expect(w.seen.copied).toEqual(['claude --resume u-1'])
  expect(w.seen.toasts.at(-1)).toContain('opened in the Claude desktop app')
  await ui.press({ key: 'back-j2' })
  expect(w.seen.tools).toContain('relay_collect')
  await ui.unmount()
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
