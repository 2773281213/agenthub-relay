---
name: relay-review
description: Ask another agent (Codex, Claude Code or DeepSeek Harness) for a read-only second opinion on a diff, a bug or a design through agenthub-relay. Use only when the user invokes relay-review; it never changes files and does not review architecture.
disable-model-invocation: true
---

# relay-review (DRAFT for evaluation)

This thin entry requires the agenthub-relay skill in the sibling ../agenthub-relay directory. Dispatch one `review` tier job with `node ../agenthub-relay/scripts/relay.mjs dispatch --tier review`, wait for it, and report its findings next to your own. A review job is read-only: any change it makes is reported out of scope and is never applied.

When the user asks for an architecture review, birdview-review owns the report; offer this second opinion as an input to that one review instead of producing a separate report.
