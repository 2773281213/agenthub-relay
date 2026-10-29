---
name: agenthub-relay
description: Hand coding work to other agents (Codex, Claude Code, DeepSeek Harness) through the agenthub-relay relay_* MCP tools - split the work, pick a tier, write a self-contained task with scope and checks, wait, then review and apply or discard. Use when the relay_* tools are available and part of a task can be done by another agent in parallel or more cheaply.
---

# agenthub-relay: delegating to other agents

You are the planner. Executors run in their own git worktrees; your working tree changes only when you call `relay_apply`. This works the same whichever agent plans: Claude Code, Codex, DeepSeek Harness or Antigravity.

Do not delegate when you are yourself an executor (`AGENTHUB_RELAY_ROLE=executor`; `relay_dispatch` refuses), when you cannot state the task precisely, or when explaining it costs more than doing it.

## 1. Split

- Hand off pieces that are independent of each other and of what you are doing. Keep design decisions, cross-cutting changes and integration for yourself.
- Give concurrent write jobs disjoint scopes. A write job holds its scope until it ends, and a completed one until you apply or discard it; an overlapping dispatch is refused.

## 2. Pick a tier

| Tier | For | Required | Default executor (`thread16`) |
|---|---|---|---|
| `deep` | complex or multi-file work that needs reasoning | `scope` (`"."` for the whole repository) | `codex` |
| `light` | simple, clearly specified, mechanical work | 1-10 `scope` paths and at least one check | `dsh` (DeepSeek V4 Flash) |
| `review` | read-only investigation or a second opinion | nothing; any change is reported out of scope | `claude` |

`relay_agents` shows the active profile and which executors are installed. Set `executor` only for a reason, such as escalating a failed light job to `codex`.

## 3. Write the task

The executor sees only your task and the repository at the base commit (tracked changes included; untracked files are not, and dispatch warns about them). Write it so a capable engineer new to the code could finish it:

- the goal and why, in a sentence or two;
- the files, symbols and conventions that matter;
- constraints: what must not change, interfaces to keep;
- `acceptance`: what done looks like;
- `checks`: shell commands that exit 0 only when the work is right. They run in the job's worktree after the executor finishes; prefer focused tests to a slow full suite.

Never put secrets in a task. Executors receive credentials only by variable name (`passEnv` in `.agenthub/config.json`).

## 4. Wait

- If the `relay_dispatch` result says `watcher.active: true`, end your turn: the watcher (the Claude Code mod) wakes you when a job ends, and keeps your prompt cache warm while you wait.
- Otherwise call `relay_wait` (it returns within 50 seconds), doing other useful work between calls, until a job finishes.

## 5. Review and integrate

1. `relay_result`: summary, checks, changed files, out-of-scope files, patch stat and log paths. Read the patch (`logs.patch`) for anything that is not trivial.
2. If it is right, `relay_apply`. The changes land unstaged in your working tree; review and commit them as your own. Out-of-scope changes need `allowOutOfScope: true`, and only after you have read them; a failed or cancelled job needs `force: true`.
3. Otherwise `relay_discard`, then improve the task or move it up a tier and dispatch again.
4. `relay_cancel` stops a job you no longer need.

A completed job is not proof: "checks passed" covers only what the checks test, and a job without checks is unverified.

## With Birdview

When Birdview is active for the task, confirm Birdview's displayed plan before dispatching any job that changes files; dispatched jobs are part of that plan's scope and are recorded as its activity. Read-only `review` jobs may run before confirmation.
