---
name: relay-review
description: Ask another agent (Codex, Claude Code or DeepSeek Harness) for a read-only second opinion on a diff, a bug or a design through agenthub-relay. Use only when the user invokes relay-review; it never changes files and does not review architecture.
disable-model-invocation: true
---

# relay-review: a second opinion from another agent

This thin entry uses the agenthub-relay skill in the sibling `../agenthub-relay` directory; read its SKILL.md for the commands and for `--planner`.

1. Write the question as a self-contained review task: what to look at (files, a diff, a failing test), what to look for, and what form the answer should take.
2. Dispatch one `review` tier job: `node ../agenthub-relay/scripts/cli.mjs dispatch --tier review --task-file - --planner <you>`, adding `--executor`, `--model` or `--effort` when the user named them.
3. Wait for it, read `result`, and report its findings next to your own, saying where you agree and where you do not.

A review job is read-only: any change it makes is reported out of scope and is never applied. Discard the job when you are done with it.

When the user asks for an architecture review, birdview-review owns the report; offer this second opinion as an input to that one review instead of producing a separate report.
