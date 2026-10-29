---
name: relay-status
description: Show agenthub-relay jobs in this repository and help decide whether to apply, discard or cancel each one. Use only when the user invokes relay-status.
disable-model-invocation: true
---

# relay-status: jobs and what to do with them

This thin entry uses the agenthub-relay skill in the sibling `../agenthub-relay` directory; read its SKILL.md for the commands and for `--planner`.

1. Run `node ../agenthub-relay/scripts/cli.mjs status --json --planner <you>` and list each job: tier, executor and model, status, verification and title.
2. For each finished job not yet applied or discarded, run `result <id>` and recommend apply or discard with reasons: checks, out-of-scope files, the summary and, when it matters, the patch.
3. Run `apply`, `discard` or `cancel` only after the user says which.

When Birdview is active, apply only jobs that belong to the plan the user confirmed, and record the edit in Birdview's activity before applying; a job outside that plan needs an updated plan and a new confirmation first.
