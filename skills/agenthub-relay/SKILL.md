---
name: agenthub-relay
description: Hand coding work to other agents (Codex, Claude Code, DeepSeek Harness) with the bundled relay script or the relay_* MCP tools - split the work, pick a tier and, when asked, an executor and model, write a self-contained task with scope and checks, wait, then review and apply or discard. Use when part of a task can be done by another agent in parallel or more cheaply. Not for reviewing architecture or skills.
---

# agenthub-relay: delegating to other agents

You are the planner. Executors run in their own git worktrees; your working tree changes only when you apply a job. This works the same whichever agent plans: Claude Code, Codex, DeepSeek Harness or Antigravity.

Do not delegate when you are yourself an executor (`AGENTHUB_RELAY_ROLE=executor`; dispatch refuses), when you cannot state the task precisely, or when explaining it costs more than doing it.

## How to call the relay

Run the bundled script with Node.js 20 or newer from the repository you are working in:

```sh
node <this skill's directory>/scripts/cli.mjs <command> --planner <you>
```

`<you>` is `claude`, `codex`, `dsh` or `agy`: say who you are on every command (or set `AGENTHUB_RELAY_PLANNER`). It picks the profile meant for your kind of planner, so that, for example, a Codex planner's deep work goes to Claude Code instead of back to Codex. Every command prints JSON; exit code 1 means the relay refused (read `error.code` and `error.message`), 2 means the command was malformed.

If the `relay_*` MCP tools are loaded (the Claude Code plugin loads them), you may use them instead; they do the same thing and record the same jobs.

| Command | Tool |
|---|---|
| `agents` | `relay_agents` |
| `dispatch --tier <t> --task-file - [--scope <p>]... [--check <c>]... [--executor <id>] [--model <m>] [--effort <e>] [--title <s>] [--acceptance <s>]` (task on stdin) | `relay_dispatch` |
| `wait [<id>...] [--timeout <s>]` | `relay_wait` |
| `result <id>` | `relay_result` |
| `apply <id> [--allow-out-of-scope] [--force]`, `discard <id>`, `cancel <id>` | `relay_apply`, `relay_discard`, `relay_cancel` |
| `status [<id>] [--json]` | `relay_status` |
| `config show`, `config set <key> <value> [--user]`, `config unset <key> [--user]` | (script only) |

## 1. Who executes, and with which model

- The first time you use the relay in a project, run `config show`. If it still shows the built-in defaults, tell the user which executor and model each tier goes to and ask once whether to keep that.
- When the user names an executor, model or effort for a piece of work ("give this to Claude Opus"), pass `--executor`, `--model` and `--effort` on that dispatch only.
- Save a choice with `config set` only when the user asks for it to stick ("from now on, light work uses …"). Say what you will write before you write it. Tier values are `executor[:model][@effort]`, for example `config set profiles.thread16.deep claude:opus@high`; `--user` saves it for every project.
- An executor that has no flag for a model refuses one with `model-unsupported` (DeepSeek Harness sets its model in its own settings). Tell the user; do not retry with another model.
- You cannot change your own model from here. If the user wants a different planner model, point them to their host (in Claude Code, `/model`).

## 2. Split

- Hand off pieces that are independent of each other and of what you are doing. Keep design decisions, cross-cutting changes and integration for yourself.
- Give concurrent write jobs disjoint scopes. A write job holds its scope until it ends, and a completed one until you apply or discard it; an overlapping dispatch is refused.

## 3. Pick a tier

| Tier | For | Required | Default executor (`thread16` / `codex-planner`) |
|---|---|---|---|
| `deep` | complex or multi-file work that needs reasoning | `scope` (`"."` for the whole repository) | `codex` / `claude` |
| `light` | simple, clearly specified, mechanical work | 1-10 `scope` paths and at least one check | `dsh` (DeepSeek V4 Flash) |
| `review` | read-only investigation or a second opinion | nothing; any change is reported out of scope | `claude` / `codex` |

`agents` shows the active profile, why it was chosen, and which executors are installed.

## 4. Write the task

The executor sees only your task and the repository at the base commit (tracked changes included; untracked files are not, and dispatch warns about them). Write it so a capable engineer new to the code could finish it:

- the goal and why, in a sentence or two;
- the files, symbols and conventions that matter;
- constraints: what must not change, interfaces to keep;
- `acceptance`: what done looks like;
- `checks`: shell commands that exit 0 only when the work is right. They run in the job's worktree after the executor finishes; prefer focused tests to a slow full suite.

Pass the task on stdin (`--task-file -`) to avoid shell quoting. Never put secrets in a task. Executors receive credentials only by variable name (`passEnv` in `.agenthub/config.json`, edited by hand).

## 5. Wait

- With the relay_* MCP tools in Claude Code: if the dispatch result says `watcher.active: true`, end your turn; the Claude Code mod wakes you when a job ends and keeps your prompt cache warm meanwhile.
- Otherwise run `wait` (50 seconds by default; `--timeout` up to 3600 if your shell allows long commands), doing other useful work between calls, until a job finishes.

## 6. Review and integrate

1. `result <id>`: summary, model, checks, changed files, out-of-scope files, patch stat and log paths. Read the patch (`logs.patch`) for anything that is not trivial.
2. If it is right, `apply <id>`. The changes land unstaged in your working tree; review and commit them as your own. Out-of-scope changes need `--allow-out-of-scope`, and only after you have read them; a failed or cancelled job needs `--force`.
3. Otherwise `discard <id>`, then improve the task or move it up a tier and dispatch again.
4. `cancel <id>` stops a job you no longer need.

A completed job is not proof: "checks passed" covers only what the checks test, and a job without checks is unverified.

## With Birdview

When Birdview is active for the task, confirm Birdview's displayed plan, or the birdview-review proposal being implemented, before dispatching any job that changes files; dispatched jobs are part of that plan's scope and are recorded as its activity. Read-only `review` jobs may run before confirmation.
