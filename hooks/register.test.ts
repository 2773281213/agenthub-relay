// Tests of the agenthub-relay mod, run by `claude plugin test .` against the
// engine itself on a mocked clock. Each hook a test registers stands for the
// engine (or the relay MCP server) beneath the plugin.

import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { decide, mentionContext, mentionRows, mentionsIn, wakeText } from './register'

const MIN = 60_000
const HOUR = 60 * MIN

type Job = { id: string; status: string; integration?: string; resultFetched?: boolean; title?: string; tier?: string; executor?: string; turn?: number; takenOver?: boolean; resumable?: boolean; needsInput?: boolean; wake?: { via?: string } }
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
    /** What relay_agents says this session is, and how many of its calls fail first. */
    role: 'planner' as 'planner' | 'executor',
    agentsFailures: 0,
    /** How many relay_agents calls throw (an MCP disconnect or timeout) before one succeeds. */
    agentsThrows: 0,
    codexhost: undefined as { harnesses: string[]; defaultHarness?: string } | undefined,
    /** How many prompt submits the engine refuses before it takes one. */
    submitFailures: 0,
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
    if (e.tool === 'relay_agents') {
      if (seen.agentsThrows > 0) {
        seen.agentsThrows -= 1
        throw new Error('the relay MCP server is not connected')
      }
      if (seen.agentsFailures > 0) {
        seen.agentsFailures -= 1
        return reply({ error: { code: 'not-ready', message: 'starting' } }, true)
      }
      return reply({ executors: seen.executors, mentionReuse: seen.mentionReuse, role: seen.role, ...(seen.codexhost ? { codexhost: seen.codexhost } : {}) })
    }
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
    if (seen.submitFailures > 0) {
      seen.submitFailures -= 1
      throw new Error('the composer is busy')
    }
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

test('in a codexhost Thread the mod waits for the relay: a relay job harness stays inactive', async ($, on) => {
  const w = world($, on, { CODEXHOST_THREAD_ID: 'th-1' })
  w.seen.role = 'executor'
  w.seen.agentsFailures = 1 // the check at session start does not get through
  w.seen.jobs = [{ id: 'j1', status: 'running' }]
  await w.start()
  for (let i = 0; i < 20 && w.seen.tools.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 5))
  await w.request()
  await $.prompt.submit({ text: '#codex fix it', wait: false })
  expect(w.seen.tools).toEqual(['relay_agents', 'relay_agents'], 'prompt.submit asked the role too')
  expect(w.seen.contexts.at(-1)).toEqual([])
  await w.minutes(70)
  expect(w.seen.tools).toEqual(['relay_agents', 'relay_agents'])
  expect(w.seen.forks).toBe(0)
})

test('in a codexhost Thread a failing role check lets a mentioned prompt through unchanged', async ($, on) => {
  const w = world($, on, { CODEXHOST_THREAD_ID: 'th-6' })
  w.seen.agentsThrows = 2 // session start and the prompt's own check lose the MCP connection
  await w.start()
  for (let i = 0; i < 20 && w.seen.tools.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 5))
  expect(w.seen.tools).toEqual(['relay_agents'])

  await $.prompt.submit({ text: '#codex fix the flaky test', wait: false })
  expect(w.seen.prompts.at(-1)).toBe('#codex fix the flaky test')
  expect(w.seen.contexts.at(-1)).toEqual([])
  expect(w.seen.tools).toEqual(['relay_agents', 'relay_agents'], 'the prompt tried the role check once more')
})

test('in a codexhost Thread a mention asks the role first, so the first note is not dropped', async ($, on) => {
  const w = world($, on, { CODEXHOST_THREAD_ID: 'th-5' })
  w.seen.agentsFailures = 1 // the check at session start does not get through
  await w.start()
  for (let i = 0; i < 20 && w.seen.tools.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 5))
  expect(w.seen.tools).toEqual(['relay_agents'])

  await $.prompt.submit({ text: '#codex fix the flaky test', wait: false })
  expect(w.seen.tools).toEqual(['relay_agents', 'relay_agents'], 'prompt.submit asked the role before attaching the note')
  expect(w.seen.contexts.at(-1)?.[0]).toContain('[agenthub-relay] The user mentioned #codex')
})

test('in a codexhost Thread a planner wakes up once the relay says so, asking at once and again while it cannot', async ($, on) => {
  const w = world($, on, { CODEX_THREAD_ID: 'th-2' })
  w.seen.agentsFailures = 1
  w.seen.jobs = [{ id: 'j1', status: 'running' }]
  await w.start()
  await w.minutes(1)
  // At the start (refused), then at the first minute (answered), then polling.
  expect(w.seen.tools.slice(0, 3)).toEqual(['relay_agents', 'relay_agents', 'relay_status'])
  w.seen.jobs = [{ id: 'j1', status: 'completed', integration: 'none', resultFetched: false, executor: 'codex', tier: 'deep' }]
  await w.minutes(2)
  expect(w.seen.prompts.length).toBe(1)
})

test('in a codexhost Thread /relay asks the relay rather than answering inactive, and the first request still counts for keep-alive', async ($, on) => {
  const w = world($, on, { CODEXHOST_THREAD_ID: 'th-3' })
  w.seen.agentsFailures = 1 // the check at the start does not get through
  w.seen.jobs = [{ id: 'j1', status: 'running' }]
  await w.start()
  await w.request() // the planner's first turn, while its role is still being asked
  const presentation = { isFullscreen: false, columns: 100 }
  const shown = await $.command.run({ command: 'relay', args: '', origin: { kind: 'composer' }, presentation })
  expect(shown.text).not.toContain('inactive')
  expect(shown.text).toContain('keep-alive: on')
  expect(shown.text).toContain('last request: just now')
  await w.minutes(56)
  expect(w.seen.forks).toBe(1)
})

test('keep_alive_in_codexhost off leaves a codexhost Thread session to the Host to keep warm', { options: { keep_alive_in_codexhost: false } }, async ($, on) => {
  const w = world($, on, { CODEXHOST_THREAD_ID: 'th-4' })
  w.seen.jobs = [{ id: 'j1', status: 'running' }]
  await w.start()
  await w.request()
  await w.minutes(70)
  expect(w.seen.forks).toBe(0)
  const presentation = { isFullscreen: false, columns: 100 }
  expect((await $.command.run({ command: 'relay', args: '', origin: { kind: 'composer' }, presentation })).text).toContain('keep-alive: off in settings')
})

test('a relay_agents call that fails is tried again at the next tick, not ten minutes later', async ($, on) => {
  const w = world($, on)
  w.seen.agentsFailures = 1
  on('prompt.autocomplete', () => ({ suggestions: [] }))
  await w.start()
  await w.minutes(1)
  expect((await $.prompt.autocomplete({ text: '#co', cursor: 3, token: '#co', start: 0 })).suggestions[0].description).toBe('agenthub-relay: codex')
  await w.minutes(1)
  expect(w.seen.tools.filter(tool => tool === 'relay_agents').length).toBe(2)
  expect((await $.prompt.autocomplete({ text: '#co', cursor: 3, token: '#co', start: 0 })).suggestions[0].description).toContain('Codex CLI')
  await w.minutes(5)
  expect(w.seen.tools.filter(tool => tool === 'relay_agents').length).toBe(2)
})

test('a wake the engine refuses is tried again; a job the relay wakes in its codexhost Thread is left to it', async ($, on) => {
  const w = world($, on)
  w.seen.jobs = [{ id: 'j1', status: 'running' }, { id: 'j2', status: 'running' }]
  await w.start()
  await w.minutes(2)
  w.seen.submitFailures = 1
  w.seen.jobs = [
    { id: 'j1', status: 'completed', integration: 'none', resultFetched: false, executor: 'codex', tier: 'deep' },
    { id: 'j2', status: 'completed', integration: 'none', resultFetched: false, executor: 'codex', tier: 'deep', wake: { via: 'codexhost' } },
  ]
  await w.minutes(1)
  expect(w.seen.prompts.length).toBe(0)
  await w.minutes(1)
  expect(w.seen.prompts.length).toBe(1)
  expect(w.seen.prompts[0]).toContain('j1 (codex, deep) ended completed')
  expect(w.seen.prompts[0]).not.toContain('j2')
  await w.minutes(3)
  expect(w.seen.prompts.length).toBe(1)
})

test('the pane shows a job waiting for an answer as such, and its button asks for the answer', async ($, on) => {
  const w = world($, on)
  w.seen.jobs = [{ id: 'j4', status: 'failed', integration: 'none', title: 'migrate', tier: 'deep', executor: 'codexhost', turn: 1, resumable: true, needsInput: true }]
  await w.start()
  const presentation = { isFullscreen: false, columns: 100 }
  await $.command.run({ command: 'relay', args: 'jobs', origin: { kind: 'composer' }, presentation })
  const ui = await $.ui.mount({
    plugin: 'agenthub-relay',
    component: 'Pane',
    requestId: 'relay-jobs',
    surface: 'desktop',
    props: { title: 'Relay jobs', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  })
  expect((await ui.find({ type: 'Text', text: /j4 .*needs input/ }))?.text).toContain('codexhost')
  await ui.press({ key: 'review-j4' })
  expect(w.seen.prompts.at(-1)).toContain('waiting for an answer')
  await ui.unmount()
})

test('codex-host harnesses are mentioned as #codexhost/<harness> and offered once codexhost is typed', () => {
  expect(mentionsIn('让 #codexhost/antigravity 审，#codexhost 做，#codexhost/pi.')).toEqual(['codexhost/antigravity', 'codexhost', 'codexhost/pi'])
  expect(mentionsIn('#codex/x and #agy/y')).toEqual([])
  expect(mentionContext(['codexhost/claude-code'], false)).toContain('relay_dispatch with executor "codexhost/claude-code"')
  expect(mentionContext(['codexhost'], false)).toContain('codexhost.defaultHarness')
  const codexhost = { harnesses: ['antigravity', 'pi'], defaultHarness: 'pi' }
  expect(mentionRows('#co', [], codexhost).map(row => row.text)).toEqual(['#codex', '#codexhost/'])
  expect(mentionRows('#codexhost', [], codexhost).map(row => row.text)).toEqual(['#codexhost', '#codexhost/antigravity', '#codexhost/pi'])
  expect(mentionRows('#codexhost/a', [], codexhost).map(row => row.text)).toEqual(['#codexhost/antigravity'])
  expect(mentionRows('#co', []).map(row => row.text)).toEqual(['#codex'])
})

test('a job waiting for an answer reads as waiting, not as failed', () => {
  const text = wakeText([{ id: 'j3', status: 'failed', needsInput: true, executor: 'codexhost', tier: 'deep', turn: 2, title: 'migrate' }])
  expect(text).toContain('j3 (codexhost, deep) is waiting for your answer (turn 2): migrate')
  expect(text).not.toContain('ended failed')
})
