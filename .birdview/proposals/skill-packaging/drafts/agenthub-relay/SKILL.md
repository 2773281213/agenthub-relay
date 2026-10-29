---
name: agenthub-relay
description: Hand coding work to other agents (Codex, Claude Code, DeepSeek Harness) with the bundled relay script - split the work, pick a tier, write a self-contained task with scope and checks, wait, then review and apply or discard. Use when part of a task can be done by another agent in parallel or more cheaply. Not for reviewing architecture or skills.
---

# agenthub-relay: delegating to other agents (DRAFT for evaluation)

You are the planner. Executors run in their own git worktrees; your working tree changes only when you run `apply`. Run the bundled script with Node.js 20 or newer: `node <skill-root>/scripts/relay.mjs <command>`. If the relay_* MCP tools are loaded, they do the same thing; use either.

Do not delegate when you are yourself an executor (`AGENTHUB_RELAY_ROLE=executor`; `dispatch` refuses), when you cannot state the task precisely, or when explaining it costs more than doing it.

## Commands

- `dispatch --tier deep|light|review --scope <path>... --check <cmd>... --task-file <file>`: start a job; prints its id as JSON.
- `wait <id> [--timeout <seconds>]`, `result <id>`, `apply <id>`, `discard <id>`, `cancel <id>`, `status`.

## With Birdview

When Birdview is active for the task, confirm Birdview's displayed plan, or the birdview-review proposal being implemented, before dispatching any job that changes files; dispatched jobs are part of that plan's scope and are recorded as its activity. Read-only `review` jobs may run before confirmation.
