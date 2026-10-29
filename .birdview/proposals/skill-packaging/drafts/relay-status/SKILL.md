---
name: relay-status
description: Show agenthub-relay jobs in this repository and help decide whether to apply, discard or cancel each one. Use only when the user invokes relay-status.
disable-model-invocation: true
---

# relay-status (DRAFT for evaluation)

This thin entry requires the agenthub-relay skill in the sibling ../agenthub-relay directory. Run `node ../agenthub-relay/scripts/relay.mjs status`, then `result <id>` for finished jobs. Recommend apply or discard with reasons, and run `apply`, `discard` or `cancel` only after the user says which.
